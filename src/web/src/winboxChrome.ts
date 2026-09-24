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

// ── Accessibility ─────────────────────────────────────────────────────

const CONTROL_LABELS: Record<string, string> = {
  "wb-min": "Minimize window",
  "wb-max": "Zoom window",
  "wb-full": "Full screen",
  "wb-close": "Close window",
};

let titleIdSeq = 0;

export interface WindowA11yOptions {
  /**
   * Treat the window as a transient dialog/palette: role="dialog", focus
   * moves into it on open, Escape closes it, and focus returns to
   * whatever had it before once it closes. Docked IDE panes leave this
   * off — they're permanent regions, not dialogs.
   */
  dialog?: boolean;
  /** aria-modal + Tab trap. Only for windows opened with WinBox `modal: true`. */
  modal?: boolean;
  /** Selector (within the body) to focus on open. Defaults to the body
   *  itself so screen readers start reading from the top. */
  initialFocus?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Give a WinBox proper semantics + keyboard support:
 *   - root gets role="dialog" (palettes) or role="region" (docked panes),
 *     labelled by its title-bar text.
 *   - the title-bar controls (WinBox renders them as bare <span>s with
 *     background-image icons) become focusable, named role="button"s
 *     activated by Enter / Space.
 *   - dialogs: focus moves in on open, Escape closes, focus is restored
 *     to the opener on close; modal dialogs also trap Tab.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function enableWindowA11y(wb: any, opts: WindowA11yOptions = {}): void {
  const root: HTMLElement | null = wb?.body?.parentElement ?? null;
  if (!root) return;
  const body: HTMLElement = wb.body;

  const title = root.querySelector<HTMLElement>(".wb-title");
  if (title) {
    if (!title.id) title.id = `cvm-wb-title-${++titleIdSeq}`;
    root.setAttribute("aria-labelledby", title.id);
  }
  root.setAttribute("role", opts.dialog ? "dialog" : "region");
  if (opts.modal) root.setAttribute("aria-modal", "true");

  for (const [cls, label] of Object.entries(CONTROL_LABELS)) {
    const el = root.querySelector<HTMLElement>(`.wb-control .${cls}`);
    if (!el) continue;
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    el.tabIndex = 0;
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        el.click();
      }
    });
  }

  if (!opts.dialog) return;

  const opener = document.activeElement as HTMLElement | null;
  body.tabIndex = -1;

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      wb.close();
      return;
    }
    if (e.key === "Tab" && opts.modal) {
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const cur = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (cur === first || cur === body)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  // Wrap WinBox's onclose (a plain instance property it calls from
  // close()) so focus goes back to the opener once the window closes.
  const origOnClose = wb.onclose;
  wb.onclose = (force?: boolean) => {
    const veto = origOnClose ? origOnClose.call(wb, force) : false;
    if (!veto && opener && opener !== document.body && document.contains(opener)) {
      // Defer: WinBox tears the DOM down right after onclose returns.
      setTimeout(() => {
        try { opener.focus(); } catch { /* unfocusable now */ }
      }, 0);
    }
    return veto;
  };

  setTimeout(() => {
    if (root.contains(document.activeElement) && document.activeElement !== root) return;
    const target = opts.initialFocus
      ? body.querySelector<HTMLElement>(opts.initialFocus)
      : null;
    (target ?? body).focus();
  }, 0);
}
