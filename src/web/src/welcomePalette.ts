/**
 * Welcome palette — first-run onboarding modal.
 *
 * Surfaces the "vibe-code classic Macintosh apps in your browser"
 * pitch + a small featured-samples gallery the first time someone
 * opens the page. Re-openable on demand from the Apple menu.
 *
 * Pattern matches aboutPalette / helpPalette / preferencesPalette:
 * a WinBox modal with Mac OS 8 styling, singleton instance.
 *
 * Persistence: a localStorage flag (`cvm-welcome-seen`) gates the
 * first-run trigger. The modal's "Don't show this again" checkbox
 * defaults to UNchecked — close-without-thinking means "I'll see this
 * next visit too." Tick the box to suppress it from then on. The
 * Apple-menu entry opens it on demand regardless of the flag.
 */
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "./winboxChrome";
import { SAMPLE_PROJECTS, complexityStars, type SampleProject } from "./playground/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

const FLAG_KEY = "cvm-welcome-seen";

let active: { focus: () => void; close: () => void } | null = null;

/**
 * Show the welcome modal unconditionally. Called from the Apple-menu
 * "Welcome to classic-vibe-mac…" entry; the first-run case calls this
 * via {@link maybeShowFirstRunWelcome}.
 */
export function openWelcome(): void {
  if (active) {
    active.focus();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Welcome to classic-vibe-mac",
    // Sized to fit the full pitch + 2×2 gallery + "Don't show again"
    // footer + Get started button without scrolling at the default
    // viewport. Was 540×580 — the footer row clipped on the original
    // chrome height, so users couldn't see the CTA or the
    // dismiss-forever checkbox without resizing the WinBox manually.
    width: "640px",
    height: "640px",
    x: "center",
    y: "center",
    html: welcomeHtml(),
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-welcome-winbox", "cvm-mac-winbox"],
    onclose: () => {
      // Honour the "don't show again" checkbox state.
      const cb = document.querySelector<HTMLInputElement>(".cvm-welcome__dont-again");
      if (cb && cb.checked) {
        try { localStorage.setItem(FLAG_KEY, "1"); } catch { /* ignore */ }
      } else {
        try { localStorage.removeItem(FLAG_KEY); } catch { /* ignore */ }
      }
      active = null;
      return false;
    },
  });
  enableShade(wb);
  wireUpInteractions(wb);
  active = { focus: () => wb.focus(), close: () => wb.close() };
}

/**
 * First-run hook. Call after the playground has mounted (so the
 * project dropdown exists for the "Try this" buttons to drive).
 * No-op if the user has already dismissed the modal once.
 *
 * Also a no-op under automation: Playwright + every other browser
 * driver sets `navigator.webdriver === true`, and a first-run modal
 * that intercepts clicks would break every e2e test that targets the
 * playground controls. Real users open this with the modal visible;
 * automated tests get a pristine UI. (Apple → "Welcome to
 * classic-vibe-mac…" still opens it on demand if a test ever needs
 * to exercise the modal itself.)
 */
export function maybeShowFirstRunWelcome(): void {
  if (typeof navigator !== "undefined" && navigator.webdriver) return;
  let seen = false;
  try { seen = localStorage.getItem(FLAG_KEY) === "1"; } catch { /* ignore */ }
  if (seen) return;
  // Defer one tick so the playground's project dropdown is wired up
  // before the user can click a "Try this" button.
  setTimeout(openWelcome, 0);
}

/**
 * Wire up the modal's interactive bits — "Try this" buttons that
 * select a sample, and "Get started" that closes the dialog. WinBox
 * inserts the HTML into a shadow-rooted container; we look up by
 * the buttons' data attribute rather than walking the DOM globally.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireUpInteractions(wb: any): void {
  const root = wb.body as HTMLElement | undefined;
  if (!root) return;
  root.querySelectorAll<HTMLButtonElement>(".cvm-welcome__try").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.sample;
      if (!id) return;
      selectSample(id);
      wb.close();
    });
  });
  const getStartedBtn = root.querySelector<HTMLButtonElement>(".cvm-welcome__cta");
  getStartedBtn?.addEventListener("click", () => wb.close());
}

/**
 * Drive the playground's project dropdown to switch to `sampleId`.
 * Re-uses the existing `change` handler the editor wires up — we
 * just set the value + dispatch the event.
 */
function selectSample(sampleId: string): void {
  const sel = document.getElementById("cvm-pg-project") as HTMLSelectElement | null;
  if (!sel) return;
  sel.value = sampleId;
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  // Bring the playground pane into view if scrolled / off-screen.
  document.getElementById("cvm-playground")?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
}

/**
 * Featured samples for the welcome gallery — a curated breadth slice,
 * not an attempt to list everything. Hand-picked so a new visitor
 * sees the ladder: tiny → small → useful → game.
 */
const FEATURED_IDS: ReadonlyArray<string> = [
  "wasm-hello",      // the absolute floor
  "wasm-mdpad",      // modern productivity in classic chrome
  "wasm-bounce",     // visual + the cvm_log Console-tab demo
  "wasm-glypha3",    // the real period game at the top
];

function welcomeHtml(): string {
  const cards = FEATURED_IDS.map(idToCardHtml).filter((s) => s !== "").join("");
  return /* html */ `
<div class="cvm-welcome">
  <h2 class="cvm-welcome__title">Vibe-code a classic Mac app</h2>

  <p class="cvm-welcome__lede">
    Edit C in this page, hit <strong>Build &amp; Run</strong>, and
    your code is running on an emulated <strong>Mac OS 7</strong> in
    seconds. The full toolchain (Retro68's <code>cc1</code> +
    <code>as</code> + <code>ld</code> + <code>Elf2Mac</code>) is
    wasm-bundled in this tab — no install, no backend, no compile
    service. Pair it with your favourite AI coding assistant and you
    can write period-correct Macintosh software the way nobody could
    in 1995.
  </p>

  <h3 class="cvm-welcome__heading">Pick a starting point</h3>
  <div class="cvm-welcome__gallery">
    ${cards}
  </div>

  <p class="cvm-welcome__footnote">
    There are 26 samples on the shelf — the picker on the left has the
    full list once you're inside. Need a hand?
    <a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/README.md" target="_blank">README</a> ·
    <a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/docs/HOW-IT-WORKS.md" target="_blank">How it works</a>.
  </p>

  <div class="cvm-welcome__actions">
    <label class="cvm-welcome__again">
      <input type="checkbox" class="cvm-welcome__dont-again" />
      Don't show this again
    </label>
    <button type="button" class="cvm-welcome__cta">Get started</button>
  </div>
</div>
  `.trim();
}

function idToCardHtml(id: string): string {
  const proj = SAMPLE_PROJECTS.find((p: SampleProject) => p.id === id);
  if (!proj) return "";
  const stars = complexityStars(proj.complexity);
  const blurb = blurbFor(id);
  // Escape any user-tainted fields. Sample labels / blurbs are static
  // in-repo strings so this is belt-and-suspenders.
  const safeLabel = escapeHtml(proj.label);
  const safeBlurb = escapeHtml(blurb);
  return /* html */ `
    <div class="cvm-welcome__card">
      <div class="cvm-welcome__card-head">
        <span class="cvm-welcome__card-name">${safeLabel}</span>
        <span class="cvm-welcome__card-stars" aria-label="complexity ${proj.complexity} of 6">${stars}</span>
      </div>
      <p class="cvm-welcome__card-blurb">${safeBlurb}</p>
      <button type="button" class="cvm-welcome__try" data-sample="${escapeHtml(id)}">Try this</button>
    </div>
  `;
}

/**
 * One-sentence blurbs for the featured tiles. Curated copy rather
 * than borrowing the sample's own description — the tone here is
 * "what visitor will get out of clicking it", short enough to fit
 * a card.
 */
function blurbFor(id: string): string {
  switch (id) {
    case "wasm-hello":
      return "The absolute floor: one DrawString in a window. Read this first to see how small a Mac app can be.";
    case "wasm-mdpad":
      return "Split-pane Markdown editor with live preview. Modern format, classic chrome — type left, see rendered Markdown right.";
    case "wasm-bounce":
      return "Offscreen BitMap + CopyBits double-buffering. Watch the cvm_log() trace in the Console tab as the ball moves.";
    case "wasm-glypha3":
      return "John Calhoun's 1992 arcade game, vendored whole. Real sprite art, 17 sound effects, ~6,600 lines of period C.";
    default:
      return "";
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
