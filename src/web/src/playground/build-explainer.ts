/**
 * build-explainer.ts — First-run "what just happened?" modal for Build & Run.
 *
 * Called after a successful Build & Run to orient first-time visitors.
 * Gated on `localStorage` so it only auto-shows once; the "What just
 * happened?" button in the toolbar re-opens it for any session.
 *
 * Rendered via WinBox (cv-mac follow-up to #104 Phase 6) so it shares
 * the same Mac OS 8 chrome (striped titlebar, platinum body) as the
 * project picker and Help palette. Drag, resize, focus-trap, and
 * Escape-to-close come from WinBox; we just hand it the content and
 * wire the two action buttons.
 */

// WinBox's published npm package has a broken `main` — side-effect import
// the bundle and reach for the global at runtime. Same pattern as
// projectPicker.ts and helpPalette.ts.
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "../winboxChrome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let active: any | null = null;

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
    /* persistence failure — modal may reappear next session */
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function renderExplainerHtml(ctx: BuildExplainContext): string {
  return /* html */ `
    <div class="cvm-explainer">
      <p class="cvm-explainer__summary">
        You built ${escapeHtml(ctx.appName)} in your browser in
        ${ctx.totalMs.toFixed(0)} ms.
      </p>
      <p>
        Here's what happened when you edited
        <code>${escapeHtml(ctx.rezFile)}</code> and clicked
        <em>Build &amp; Run</em>:
      </p>
      <ol class="cvm-explainer__steps">
        <li>
          <strong>We compiled &ldquo;${escapeHtml(ctx.rezFile)}&rdquo; into a resource fork</strong>
          &mdash; the part of a classic Mac binary that holds menus,
          windows, strings, and icons. This step ran entirely in your
          browser using WASM-Rez; no server was involved.
        </li>
        <li>
          <strong>We packed it into a 1.44 MB HFS disk image</strong>
          &mdash; the size of an old floppy disk, held entirely in your
          browser's memory.
        </li>
        <li>
          <strong>We rebooted the emulated Mac with that disk mounted as a secondary volume</strong>
          &mdash; called &ldquo;${escapeHtml(ctx.volumeName)}&rdquo;.
        </li>
        <li>
          <strong>The Mac is back up.</strong>
          Open the &ldquo;${escapeHtml(ctx.volumeName)}&rdquo; disk on
          the desktop, then double-click &ldquo;${escapeHtml(ctx.appName)}&rdquo;
          to launch your updated app.
        </li>
      </ol>
      <div class="cvm-explainer__buttons">
        <button type="button"
                class="cvm-pg-button cvm-explainer__btn--default"
                data-action="dismiss-forever">
          Got it &mdash; don&rsquo;t show again
        </button>
        <button type="button"
                class="cvm-pg-button"
                data-action="show-mac">
          Show me the Mac &uarr;
        </button>
      </div>
    </div>
  `;
}

/**
 * Always shows the Build & Run explainer modal.
 * Replaces any existing modal.
 *
 * @param ctx  Build context to display in the modal.
 * @param from Optional: the element that triggered the open (focus returns here on close).
 *             Currently unused — WinBox handles focus management — but kept for
 *             API compatibility with the pre-WinBox modal call sites.
 */
export function showBuildExplainer(
  ctx: BuildExplainContext,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _from?: HTMLElement,
): void {
  if (active) {
    active.close();
    active = null;
  }
  const content = document.createElement("div");
  content.innerHTML = renderExplainerHtml(ctx);

  // Wire the two action buttons before mounting — WinBox doesn't fire
  // a content-ready callback, but the DOM is built synchronously here
  // so we can attach handlers on the cloned tree before passing it in.
  const dismiss = content.querySelector<HTMLButtonElement>(
    '[data-action="dismiss-forever"]',
  );
  const showMac = content.querySelector<HTMLButtonElement>(
    '[data-action="show-mac"]',
  );
  if (dismiss) {
    dismiss.addEventListener("click", () => {
      safeLocalSet(STORAGE_KEY, "1");
      active?.close();
    });
  }
  if (showMac) {
    showMac.addEventListener("click", () => {
      active?.close();
      const emWin = document.getElementById("emulator");
      if (emWin) emWin.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  active = new WinBox({
    title: "What just happened?",
    width: "520px",
    height: "440px",
    x: "center",
    y: "center",
    mount: content,
    modal: true,
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-explainer-winbox", "cvm-mac-winbox"],
    onclose: () => {
      active = null;
      // returning false allows the close
      return false;
    },
  });
  enableShade(active);

  // Focus the default action button so keyboard users can dismiss
  // immediately with Enter — matches the old hand-rolled modal's UX.
  // RequestAnimationFrame waits one tick for WinBox to insert the
  // content into the DOM.
  requestAnimationFrame(() => {
    dismiss?.focus();
  });
}

/**
 * Shows the explainer only if the user has never dismissed it before.
 * The localStorage gate is per-browser; incognito/private sessions always
 * see it. Falls back to showing if localStorage is unavailable.
 *
 * @param ctx  Build context to display.
 * @param from Optional trigger element (kept for API compat).
 */
export function showBuildExplainerIfFirstTime(
  ctx: BuildExplainContext,
  from?: HTMLElement,
): void {
  if (safeLocalGet(STORAGE_KEY)) return;
  showBuildExplainer(ctx, from);
}
