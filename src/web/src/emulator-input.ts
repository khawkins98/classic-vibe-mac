/**
 * emulator-input.ts — translate browser pointer/keyboard events into
 * BasiliskII's input queue.
 *
 * BasiliskII (Infinite Mac WASM build) consumes input via a SharedArrayBuffer
 * Int32 ring; offsets are defined upstream at
 *   src/emulator/common/common.ts → InputBufferAddresses.
 *
 * The main thread and emulator worker coordinate via a cyclical lock at
 * inputBuffer[globalLockAddr]. The cycle is:
 *   READY_FOR_UI_THREAD (0) → UI_THREAD_LOCK (1) → READY_FOR_EMUL_THREAD (2)
 *   → EMUL_THREAD_LOCK (3) → READY_FOR_UI_THREAD (0) → …
 * The main thread (us) acquires from state 0, writes events, releases to
 * state 2 with Atomics.notify (wakes the worker which is Atomics.wait-ing).
 * The worker acquires from state 2, reads events, releases to state 0.
 *
 * If we ever skip our half of the cycle (which the previous version did —
 * writing values without participating in the lock at all), the worker's
 * compareExchange from state 2 never succeeds, and no input is delivered.
 * That manifested as the emulator showing the host cursor over the canvas
 * but never tracking it inside the framebuffer, never reacting to clicks.
 *
 * Reference: mihaip/infinite-mac@30112da0db
 *   src/emulator/ui/input.ts → SharedMemoryEmulatorInput
 *   src/emulator/common/common.ts → updateInputBufferWithEvents,
 *   InputBufferAddresses, LockStates
 *
 * Keyboard mapping is a subset of upstream
 *   src/emulator/common/key-codes.ts (JS_CODE_TO_ADB_KEYCODE) — we keep just
 * the standard US-keyboard set needed for Minesweeper (letters/digits,
 * arrows, modifiers, return, space, escape, delete).
 */

import {
  InputBufferAddresses,
  LockStates,
} from "./emulator-worker-types";

// ── Event queue ────────────────────────────────────────────────────────
// Mirrors the EmulatorInputEvent shape from upstream common.ts. We only
// model the events we actually generate from the browser side.

type InputEvent =
  | { type: "mousemove"; x: number; y: number }
  | { type: "mousedown"; button: number }
  | { type: "mouseup"; button: number }
  | { type: "keydown"; keyCode: number; modifiers: number }
  | { type: "keyup"; keyCode: number; modifiers: number };

let inputView: Int32Array | null = null;
const queue: InputEvent[] = [];
let drainScheduled = false;

/**
 * Hand off the SharedArrayBuffer-backed input buffer once the worker has
 * posted handles back. The view spans the full input region; we only touch
 * the indices in InputBufferAddresses.
 */
export function setInputBuffer(buffer: SharedArrayBuffer | null): void {
  inputView = buffer ? new Int32Array(buffer) : null;
  if (inputView) tryDrainQueue();
}

// ── Lock helpers (mirror of upstream ui/input.ts) ──────────────────────

function tryAcquireLock(view: Int32Array): boolean {
  const res = Atomics.compareExchange(
    view,
    InputBufferAddresses.globalLockAddr,
    LockStates.READY_FOR_UI_THREAD,
    LockStates.UI_THREAD_LOCK,
  );
  return res === LockStates.READY_FOR_UI_THREAD;
}

function releaseLock(view: Int32Array): void {
  Atomics.store(
    view,
    InputBufferAddresses.globalLockAddr,
    LockStates.READY_FOR_EMUL_THREAD,
  );
  // Wake the worker if it's parked in idleWait().
  Atomics.notify(view, InputBufferAddresses.globalLockAddr);
}

/**
 * Drain queued events into the SAB. If the worker currently holds the lock
 * (state != READY_FOR_UI_THREAD), reschedule to next macrotask. Mirrors
 * upstream `#tryToSendInput`.
 */
function tryDrainQueue(): void {
  if (!inputView || queue.length === 0) return;
  if (!tryAcquireLock(inputView)) {
    scheduleDrain();
    return;
  }
  // Coalesce: only the latest mousemove matters within one cycle. Upstream
  // common.ts updateInputBufferWithEvents does the same. Buttons collapse
  // to "last state per button"; one key event per cycle (extras requeued).
  let hasMousePosition = false;
  let mouseX = 0;
  let mouseY = 0;
  let mouseButtonState = -1;
  let mouseButton2State = -1;
  let hasKeyEvent = false;
  let keyCode = 0;
  let keyState = 0;
  let keyModifiers = 0;
  const remaining: InputEvent[] = [];

  for (const ev of queue) {
    switch (ev.type) {
      case "mousemove":
        // Take the *latest* mousemove (overwrite previous) so the cursor
        // doesn't lag behind the user. Different from upstream which keeps
        // the first; for our high-frequency pointermove stream the latest
        // is what matters.
        hasMousePosition = true;
        mouseX = ev.x;
        mouseY = ev.y;
        break;
      case "mousedown":
      case "mouseup":
        if (ev.button === 2) {
          mouseButton2State = ev.type === "mousedown" ? 1 : 0;
        } else {
          mouseButtonState = ev.type === "mousedown" ? 1 : 0;
        }
        break;
      case "keydown":
      case "keyup":
        if (hasKeyEvent) {
          remaining.push(ev);
          break;
        }
        hasKeyEvent = true;
        keyCode = ev.keyCode;
        keyState = ev.type === "keydown" ? 1 : 0;
        keyModifiers = ev.modifiers;
        break;
    }
  }

  if (hasMousePosition) {
    inputView[InputBufferAddresses.mousePositionFlagAddr] = 1;
    inputView[InputBufferAddresses.mousePositionXAddr] = mouseX;
    inputView[InputBufferAddresses.mousePositionYAddr] = mouseY;
  }
  // Upstream writes -1 for "no change this cycle"; the worker's resetInput
  // sets these back to 0 after the emul thread reads them, but the C side
  // distinguishes -1 (no change) from 0 (released) for button transitions.
  inputView[InputBufferAddresses.mouseButtonStateAddr] = mouseButtonState;
  inputView[InputBufferAddresses.mouseButton2StateAddr] = mouseButton2State;
  if (hasKeyEvent) {
    inputView[InputBufferAddresses.keyEventFlagAddr] = 1;
    inputView[InputBufferAddresses.keyCodeAddr] = keyCode;
    inputView[InputBufferAddresses.keyStateAddr] = keyState;
    inputView[InputBufferAddresses.keyModifiersAddr] = keyModifiers;
  }

  releaseLock(inputView);

  queue.length = 0;
  if (remaining.length) {
    queue.push(...remaining);
    scheduleDrain();
  }
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  // setTimeout(0) yields to the worker so it can flip the lock back. Same
  // as upstream `#tryToSendInputLater`.
  setTimeout(() => {
    drainScheduled = false;
    tryDrainQueue();
  }, 0);
}

function enqueue(ev: InputEvent): void {
  queue.push(ev);
  tryDrainQueue();
}

// ── KeyboardEvent.code → ADB scancode (subset of upstream key-codes.ts) ──
// We use `event.code` (physical key location, layout-independent) rather
// than `event.key` so the mapping is stable across user keyboard layouts.
const JS_CODE_TO_ADB: Readonly<Record<string, number>> = {
  KeyA: 0x00, KeyS: 0x01, KeyD: 0x02, KeyF: 0x03, KeyH: 0x04, KeyG: 0x05,
  KeyZ: 0x06, KeyX: 0x07, KeyC: 0x08, KeyV: 0x09, KeyB: 0x0b, KeyQ: 0x0c,
  KeyW: 0x0d, KeyE: 0x0e, KeyR: 0x0f, KeyY: 0x10, KeyT: 0x11, KeyO: 0x1f,
  KeyU: 0x20, KeyI: 0x22, KeyP: 0x23, KeyL: 0x25, KeyJ: 0x26, KeyK: 0x28,
  KeyN: 0x2d, KeyM: 0x2e,
  Digit1: 0x12, Digit2: 0x13, Digit3: 0x14, Digit4: 0x15, Digit5: 0x17,
  Digit6: 0x16, Digit7: 0x1a, Digit8: 0x1c, Digit9: 0x19, Digit0: 0x1d,
  Equal: 0x18, Minus: 0x1b, BracketRight: 0x1e, BracketLeft: 0x21,
  Quote: 0x27, Semicolon: 0x29, Backslash: 0x2a, Comma: 0x2b, Slash: 0x2c,
  Period: 0x2f, Backquote: 0x32,
  Enter: 0x24, Tab: 0x30, Space: 0x31, Backspace: 0x33, Escape: 0x35,
  MetaLeft: 0x37, MetaRight: 0x37, OSLeft: 0x37, OSRight: 0x37,
  ShiftLeft: 0x38, ShiftRight: 0x7b, CapsLock: 0x39,
  AltLeft: 0x3a, AltRight: 0x7c,
  ControlLeft: 0x36, ControlRight: 0x7d,
  ArrowLeft: 0x3b, ArrowRight: 0x3c, ArrowDown: 0x3d, ArrowUp: 0x3e,
  Home: 0x73, End: 0x77, PageUp: 0x74, PageDown: 0x79,
  Delete: 0x75,
};

export function wireInput(canvas: HTMLCanvasElement): () => void {
  // We always recompute getBoundingClientRect() per-event. The window may
  // have moved/resized between worker init and the first user event; a rect
  // cached at handoff time would be stale. Cheap (no layout flush triggered
  // by reads-only-after-write patterns elsewhere on the page).
  const onPointerMove = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // CSS pixels → emulator framebuffer pixels. Without scaling, a click on
    // the right edge of a 1280-CSS-px canvas would land at x=1280 in the
    // 640-px emulator framebuffer (off-screen).
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = clamp(0, canvas.width - 1, (e.clientX - rect.left) * scaleX);
    const y = clamp(0, canvas.height - 1, (e.clientY - rect.top) * scaleY);
    enqueue({ type: "mousemove", x: Math.floor(x), y: Math.floor(y) });
  };

  const onPointerDown = (e: PointerEvent) => {
    canvas.focus();
    // Capture the pointer so drag-out-of-canvas still delivers pointerup
    // (e.g. menu drags that wander off the emulator viewport).
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture can throw if the pointer is already lost */
    }
    // Send a fresh mousemove first so the press lands at exactly the
    // current cursor position (avoids "ghost" clicks at a stale location
    // when the user clicks before moving).
    onPointerMove(e);
    enqueue({ type: "mousedown", button: e.button });
  };

  const onPointerUp = (e: PointerEvent) => {
    enqueue({ type: "mouseup", button: e.button });
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* may already be released */
    }
  };

  // Skip the global keyboard forward when the user is typing into a
  // page-side input (the playground editor, a future search box, etc.).
  // Otherwise every keystroke gets eaten by the Mac and the editor feels
  // dead — Cmd-C / Cmd-V / typing all silently miss. We check the
  // currently-focused element rather than e.target because key events
  // sometimes bubble from window directly.
  const isEditableTarget = (): boolean => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    // CodeMirror 6 puts cursor in `.cm-content` (a contenteditable div).
    // The check above already catches it, but keep the explicit class
    // check as a safety net for any custom editor surface.
    if (el.closest(".cm-editor, .cm-content")) return true;
    return false;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditableTarget()) return;
    const adb = JS_CODE_TO_ADB[e.code];
    if (adb === undefined) return;
    e.preventDefault();
    enqueue({ type: "keydown", keyCode: adb, modifiers: modifiersOf(e) });
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (isEditableTarget()) return;
    const adb = JS_CODE_TO_ADB[e.code];
    if (adb === undefined) return;
    e.preventDefault();
    enqueue({ type: "keyup", keyCode: adb, modifiers: modifiersOf(e) });
  };

  // Suppress the browser context menu so right-click can be option-click.
  const onContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  // Keys go on window so the Mac receives them whether or not the canvas
  // has explicit focus (tabIndex focus is fragile across browsers). The
  // isEditableTarget() guard at the top of each handler then skips
  // forwarding when focus is in a page-side input — without it, typing
  // into the playground editor would be silently eaten by the Mac.
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("pointercancel", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}

function clamp(min: number, max: number, v: number): number {
  return v < min ? min : v > max ? max : v;
}

function modifiersOf(e: KeyboardEvent): number {
  // BasiliskII modifier bits: shift=1, ctrl=2, option=4, command=8.
  let m = 0;
  if (e.shiftKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.altKey) m |= 4;
  if (e.metaKey) m |= 8;
  return m;
}
