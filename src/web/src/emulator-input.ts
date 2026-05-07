/**
 * emulator-input.ts — translate browser pointer/keyboard events into
 * BasiliskII's input queue.
 *
 * BasiliskII (in the Infinite Mac WASM build) consumes input via a
 * SharedArrayBuffer ring whose offsets are defined upstream at:
 *
 *   src/emulator/common/common.ts -> InputBufferAddresses
 *
 * The actual buffer is owned by the worker once the emulator is started.
 * For now (we are in the stub state — see emulator-loader.ts) this module
 * provides the canvas-side wiring scaffold so the next agent doesn't have
 * to invent the event capture pattern from scratch. Calling `wireInput`
 * is safe in stub mode: it attaches listeners and just no-ops on dispatch
 * until `setBufferAdapter` is called with a real adapter from the worker.
 *
 * Why this lives in its own file: the Infinite Mac equivalent
 * (src/emulator/ui/input.ts) is ~600 lines including pointer-lock,
 * mouse-delta vs absolute mode, software-modifier keys, and clipboard
 * integration. We only need the basics for a single boot disk + game,
 * so we lift the smallest workable subset.
 */

export interface InputBufferAdapter {
  /** Push a mouse position update (x,y in canvas pixels). */
  pushMouseMove(x: number, y: number): void;
  /** Push a mouse button transition. button: 0=left, 1=right. */
  pushMouseButton(button: number, down: boolean): void;
  /** Push a keyboard event. keyCode is a Mac scancode (not browser keyCode). */
  pushKey(macKeyCode: number, down: boolean, modifiers: number): void;
}

let adapter: InputBufferAdapter | null = null;

/** Called by the worker once the shared input buffer is ready. */
export function setBufferAdapter(a: InputBufferAdapter | null): void {
  adapter = a;
}

export function wireInput(canvas: HTMLCanvasElement): () => void {
  const onPointerMove = (e: PointerEvent) => {
    if (!adapter) return;
    const rect = canvas.getBoundingClientRect();
    // Scale CSS pixels back to canvas pixels — the canvas is sized at
    // emulator native resolution but may be CSS-scaled by the chrome.
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

  // Browser keyCode -> Mac scancode mapping is non-trivial. The full table
  // lives upstream at src/emulator/ui/input.ts (BROWSER_KEYCODE_TO_MAC).
  // For the stub we just forward `key` as a placeholder; the worker side
  // will translate once wired.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!adapter) return;
    // Don't steal browser shortcuts (cmd-r, etc.) until we're sure we want to.
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    adapter.pushKey(e.keyCode, true, modifiersOf(e));
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (!adapter) return;
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    adapter.pushKey(e.keyCode, false, modifiersOf(e));
  };

  // Suppress the browser context menu so right-click can be a Mac
  // option-click eventually.
  const onContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointerup", onPointerUp);
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("keyup", onKeyUp);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}

function modifiersOf(e: KeyboardEvent): number {
  // Bit layout matches Infinite Mac's modifier flags (shift=1, ctrl=2,
  // option=4, command=8). Approximate mapping for now.
  let m = 0;
  if (e.shiftKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.altKey) m |= 4;
  if (e.metaKey) m |= 8;
  return m;
}
