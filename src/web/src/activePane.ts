/**
 * activePane.ts — track which docked pane "owns" the keyboard.
 *
 * The four IDE panes (Project / Playground / Macintosh / Output)
 * compete for ⌘-key shortcuts:
 *   - menubar shortcuts (⌘P Open Quickly, ⌘O Open Project, ⌘S
 *     Download .zip, ⌘? Help, etc.) want to fire host-side when
 *     the user is interacting with the playground / project /
 *     output panes
 *   - the emulated Mac (BasiliskII) wants to receive ⌘-keys when
 *     the user clicked into the Macintosh canvas — ⌘S in a
 *     Mac-side TextEdit should save the Mac document, not download
 *     the host's project zip
 *
 * The router below tracks "which pane was last clicked" and
 * exposes a sync predicate the keydown handlers consult. State
 * also surfaces as a `data-active-pane` attribute on <body> so CSS
 * can highlight the active pane's WinBox titlebar (the period-Mac
 * "active window" affordance).
 *
 * Tracked via document-level pointerdown — using `document.activeElement`
 * isn't reliable here because the Mac canvas's tab-focus is fragile
 * across browsers (some defocus on Cmd-key combos), and the menubar's
 * dropdown moves focus to a button button by design without changing
 * the user's *intent*.
 */

export type ActivePane = "mac" | "editor" | "other";

let activePane: ActivePane = "other";

const PANE_SELECTOR =
  ".cvm-pane-mac, .cvm-pane-editor, .cvm-pane-files, .cvm-pane-output";

/** Current active pane. Defaults to "other" before any pointerdown
 *  fires; effectively "do whatever the existing routing does." */
export function getActivePane(): ActivePane {
  return activePane;
}

/** True when the user last clicked inside the Macintosh canvas pane.
 *  Used by menubar / shortcut handlers to defer ⌘-keys to the
 *  emulated Mac instead of firing host-side actions. */
export function isMacActive(): boolean {
  return activePane === "mac";
}

/** Manually set the active pane. Call from a code path that knows
 *  the user's intent better than pointerdown can (e.g. a palette
 *  opens — we want the editor to be active again after dismissal). */
export function setActivePane(pane: ActivePane): void {
  if (pane === activePane) return;
  activePane = pane;
  reflectToBody();
}

function reflectToBody(): void {
  document.body.dataset.activePane = activePane;
}

/** Wire the pointerdown listener that updates active-pane state.
 *  Idempotent — calling multiple times is a no-op after the first. */
let installed = false;
export function installActivePaneTracker(): void {
  if (installed) return;
  installed = true;
  reflectToBody();
  document.addEventListener(
    "pointerdown",
    (e) => {
      const target = e.target as Element | null;
      if (!target) return;
      const pane = target.closest<HTMLElement>(PANE_SELECTOR);
      if (!pane) return;
      // Map the pane class to a router category. "mac" is the only
      // pane that has to defer ⌘-keys to BasiliskII; the others
      // (files / editor / output) all want host-side menubar shortcuts.
      const next: ActivePane = pane.classList.contains("cvm-pane-mac")
        ? "mac"
        : "editor";
      setActivePane(next);
    },
    // Capture so we run BEFORE any other pointerdown handler that
    // might preventDefault + stopPropagation.
    true,
  );
}
