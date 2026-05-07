/**
 * emulator-input.ts — translate browser pointer/keyboard events into
 * BasiliskII's input queue.
 *
 * BasiliskII (Infinite Mac WASM build) consumes input via a SharedArrayBuffer
 * Int32 ring; offsets are defined upstream at
 *   src/emulator/common/common.ts → InputBufferAddresses.
 *
 * `wireInput(canvas)` attaches DOM listeners to a canvas element. They
 * dispatch through a small `InputBufferAdapter` set by emulator-loader.ts
 * once the worker hands back the shared buffers. Until the adapter is set,
 * events are dropped silently — safe to call wireInput before the worker
 * boots.
 *
 * Keyboard mapping is a subset of upstream
 *   mihaip/infinite-mac@30112da0db src/emulator/common/key-codes.ts
 * (JS_CODE_TO_ADB_KEYCODE) — we keep just the standard US-keyboard set
 * needed for Minesweeper (letters/digits, arrows, modifiers, return,
 * space, escape, delete).
 */

export interface InputBufferAdapter {
  pushMouseMove(x: number, y: number): void;
  /** button: 0=left, 1=middle, 2=right. */
  pushMouseButton(button: number, down: boolean): void;
  /** macKeyCode is an ADB scancode (NOT browser keyCode). */
  pushKey(macKeyCode: number, down: boolean, modifiers: number): void;
}

let adapter: InputBufferAdapter | null = null;

export function setBufferAdapter(a: InputBufferAdapter | null): void {
  adapter = a;
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
  const onPointerMove = (e: PointerEvent) => {
    if (!adapter) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(0, Math.min(canvas.width, (e.clientX - rect.left) * scaleX));
    const y = Math.max(0, Math.min(canvas.height, (e.clientY - rect.top) * scaleY));
    adapter.pushMouseMove(Math.floor(x), Math.floor(y));
  };

  const onPointerDown = (e: PointerEvent) => {
    canvas.focus();
    adapter?.pushMouseButton(e.button, true);
  };

  const onPointerUp = (e: PointerEvent) => {
    adapter?.pushMouseButton(e.button, false);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!adapter) return;
    const adb = JS_CODE_TO_ADB[e.code];
    if (adb === undefined) return;
    e.preventDefault();
    adapter.pushKey(adb, true, modifiersOf(e));
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!adapter) return;
    const adb = JS_CODE_TO_ADB[e.code];
    if (adb === undefined) return;
    e.preventDefault();
    adapter.pushKey(adb, false, modifiersOf(e));
  };

  // Suppress the browser context menu so right-click can be option-click.
  const onContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  // Keys go on window, not the canvas — System 7 expects keystrokes whether
  // or not the canvas has focus, and tabIndex-focus is fragile.
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
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
