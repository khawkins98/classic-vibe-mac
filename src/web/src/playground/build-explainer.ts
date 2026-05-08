/**
 * build-explainer.ts — First-run "what just happened?" modal for Build & Run.
 *
 * Called after a successful Build & Run to orient first-time visitors.
 * Gated on `localStorage` so it only auto-shows once; the "What just
 * happened?" button in the toolbar re-opens it for any session.
 */

const STORAGE_KEY = "cvm.buildExplainerSeen";

export interface BuildExplainContext {
  /** Human-readable app name, e.g. "MacWeather". */
  appName: string;
  /** The .r file that was compiled, e.g. "macweather.r". */
  rezFile: string;
  /** Total Build & Run duration in milliseconds. */
  totalMs: number;
  /** Volume name used on the disk image, typically "Apps". */
  volumeName: string;
}

// Module-level handle so we can prevent duplicate stacking.
let activeModal: HTMLElement | null = null;
// The element that triggered the open (for focus restoration on close).
let triggerEl: HTMLElement | null = null;
// Cleanup function returned by attachFocusTrap.
let focusTrapCleanup: (() => void) | null = null;

function safeLocalGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Silently accept; the explainer may reappear next time.
  }
}

function attachFocusTrap(container: HTMLElement): () => void {
  const selector = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== "Tab") return;
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
      (el) => !el.closest("[hidden]"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  container.addEventListener("keydown", handleKeydown);
  return () => container.removeEventListener("keydown", handleKeydown);
}

function closeModal(): void {
  if (focusTrapCleanup) {
    focusTrapCleanup();
    focusTrapCleanup = null;
  }
  if (activeModal) {
    activeModal.remove();
    activeModal = null;
  }
  triggerEl?.focus();
  triggerEl = null;
}

function buildModal(ctx: BuildExplainContext): HTMLElement {
  const titleId = "cvm-modal-title";
  const descId = "cvm-modal-desc";

  const overlay = document.createElement("div");
  overlay.className = "cvm-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", titleId);
  overlay.setAttribute("aria-describedby", descId);

  // Click on the scrim (not the dialog) to dismiss.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal();
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeModal();
    }
  });

  // ── Dialog box ──────────────────────────────────────────────────────────
  const dialog = document.createElement("div");
  dialog.className = "cvm-modal";

  // Title bar
  const titlebar = document.createElement("div");
  titlebar.className = "cvm-modal__titlebar";

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "cvm-modal__closebox";
  closeBtn.setAttribute("aria-label", "Close explanation");
  closeBtn.addEventListener("click", closeModal);

  const titleEl = document.createElement("span");
  titleEl.id = titleId;
  titleEl.className = "cvm-modal__title";
  titleEl.textContent = "What just happened?";

  titlebar.append(closeBtn, titleEl);

  // Body
  const body = document.createElement("div");
  body.className = "cvm-modal__body";
  body.id = descId;

  const summary = document.createElement("p");
  summary.className = "cvm-modal__summary";
  summary.textContent = `You built ${ctx.appName} in your browser in ${ctx.totalMs.toFixed(0)} ms.`;

  const intro = document.createElement("p");
  intro.textContent = `Here\u2019s what happened when you edited ${ctx.rezFile} and clicked Build\u202f\u0026\u202fRun:`;

  const steps = document.createElement("ol");
  steps.className = "cvm-modal__steps";

  const stepData: [string, string][] = [
    [
      `We compiled \u201c${ctx.rezFile}\u201d into a resource fork\u2009\u2014`,
      `the part of a classic Mac binary that holds menus, windows, strings, and icons. This step ran entirely in your browser using WASM-Rez; no server was involved.`,
    ],
    [
      `We packed it into a 1.44\u202fMB HFS disk image\u2009\u2014`,
      `the size of an old floppy disk, held entirely in your browser\u2019s memory.`,
    ],
    [
      `We rebooted the emulated Mac with that disk mounted as a secondary volume\u2009\u2014`,
      `called \u201c${ctx.volumeName}\u201d.`,
    ],
    [
      `The Mac is back up.`,
      ` Open the \u201c${ctx.volumeName}\u201d disk on the desktop, then double-click \u201c${ctx.appName}\u201d to launch your updated app.`,
    ],
  ];

  for (const [bold, rest] of stepData) {
    const li = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = bold;
    li.append(strong, document.createTextNode(rest));
    steps.appendChild(li);
  }

  body.append(summary, intro, steps);

  // Button row
  const btns = document.createElement("div");
  btns.className = "cvm-modal__buttons";

  const gotIt = document.createElement("button");
  gotIt.type = "button";
  gotIt.className = "cvm-pg-button cvm-modal__btn--default";
  gotIt.textContent = "Got it \u2014 don\u2019t show again";
  gotIt.addEventListener("click", () => {
    safeLocalSet(STORAGE_KEY, "1");
    closeModal();
  });

  const showMac = document.createElement("button");
  showMac.type = "button";
  showMac.className = "cvm-pg-button";
  showMac.textContent = "Show me the Mac \u2191";
  showMac.addEventListener("click", () => {
    closeModal();
    const emWin = document.getElementById("emulator");
    if (emWin) emWin.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  btns.append(gotIt, showMac);

  dialog.append(titlebar, body, btns);
  overlay.appendChild(dialog);

  return overlay;
}

/**
 * Always shows the Build & Run explainer modal.
 * Replaces any existing modal.
 *
 * @param ctx  Build context to display in the modal.
 * @param from Optional: the element that triggered the open (focus returns here on close).
 */
export function showBuildExplainer(ctx: BuildExplainContext, from?: HTMLElement): void {
  if (activeModal) closeModal();
  triggerEl = from ?? null;
  activeModal = buildModal(ctx);
  document.body.appendChild(activeModal);
  focusTrapCleanup = attachFocusTrap(activeModal);
  // Focus the default button so keyboard users can dismiss immediately.
  const defaultBtn = activeModal.querySelector<HTMLButtonElement>(".cvm-modal__btn--default");
  defaultBtn?.focus();
}

/**
 * Shows the explainer only if the user has never dismissed it before.
 * The localStorage gate is per-browser; incognito/private sessions always
 * see it. Falls back to showing if localStorage is unavailable.
 *
 * @param ctx  Build context to display.
 * @param from Optional trigger element.
 */
export function showBuildExplainerIfFirstTime(ctx: BuildExplainContext, from?: HTMLElement): void {
  if (safeLocalGet(STORAGE_KEY)) return;
  showBuildExplainer(ctx, from);
}
