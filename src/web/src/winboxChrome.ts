/**
 * winboxChrome.ts — shared classic-Mac window behaviours for our
 * WinBox palettes (cv-mac follow-up to #104).
 *
 * WinBox already provides drag, resize, raise-on-click, and close out
 * of the box. Two classic-Mac behaviours it doesn't natively support:
 *
 *   - **Shade (window-shade roll-up)**: double-clicking the title bar
 *     collapses the window to just its title bar, hiding the body.
 *     Double-click again to expand. The de-facto Mac OS 7/8 idiom.
 *
 *   - **Mac OS 8 chrome styling**: striped title bar, paper title
 *     field, platinum body. Done via per-palette CSS classes
 *     (.cvm-picker-winbox, .cvm-help-winbox, .cvm-explainer-winbox).
 *
 * This module adds the shade behaviour to a WinBox instance. CSS lives
 * in style.css under `.cvm-mac-winbox--shaded`.
 */

/**
 * Attach shade-on-double-click to a WinBox. Returns a cleanup function
 * that detaches the listener; usually the caller doesn't need to call
 * it because the listener is removed when the WinBox is closed.
 *
 * WinBox's own dblclick handler on .wb-header toggles full-screen
 * maximize. Our handler stops the event in the capture phase so the
 * shade toggle wins. We attach on the document (not the header) and
 * filter by `target.closest(".wb-header")` because WinBox's listener
 * is also attached at the document level and our capture-phase
 * listener at the document level fires first.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enableShade(wb: any): () => void {
  // WinBox doesn't expose a single "outer container" property; the
  // canonical way to reach it is `wb.body.parentElement` (the .winbox
  // div that wraps the .wb-header + .wb-body + resize handles).
  const root: HTMLElement | null = wb?.body?.parentElement ?? null;
  if (!root) return () => {};

  let shaded = false;
  let unshadedHeight: number | null = null;

  function applyShaded(next: boolean): void {
    if (next === shaded) return;
    shaded = next;
    if (shaded) {
      unshadedHeight = root!.clientHeight;
      root!.classList.add("cvm-mac-winbox--shaded");
      try {
        // Shrink the WinBox to just its titlebar height. 20px matches
        // the .wb-header height we set in style.css.
        wb.resize(root!.clientWidth, 22, true);
      } catch {
        /* older WinBox: ignore */
      }
    } else {
      root!.classList.remove("cvm-mac-winbox--shaded");
      try {
        if (unshadedHeight != null) wb.resize(root!.clientWidth, unshadedHeight, true);
      } catch {
        /* swallow */
      }
    }
  }

  function onDouble(e: Event): void {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // Only react to dblclicks landing on THIS WinBox's header.
    const header = target.closest(".wb-header");
    if (!header || !root!.contains(header)) return;
    // Skip the chrome control buttons (close / min / max).
    if (target.closest(".wb-control") || target.closest(".wb-close") ||
        target.closest(".wb-min") || target.closest(".wb-max")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    applyShaded(!shaded);
  }

  // Capture phase on document so we fire before WinBox's own handler
  // (which is also on document).
  document.addEventListener("dblclick", onDouble, true);
  return () => document.removeEventListener("dblclick", onDouble, true);
}
