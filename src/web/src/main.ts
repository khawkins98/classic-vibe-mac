/**
 * Landing page bootstrap.
 *
 * This page IS the page that loads the emulator (per the marketer brief —
 * the landing page and the app surface are the same). On DOMContentLoaded
 * we hand off the `#emulator-canvas-mount` element inside the "Macintosh"
 * window's `.inset` to `startEmulator()`, which renders its own
 * period-styled loader UI and (eventually) the canvas.
 *
 * See ./emulator-loader.ts for the boot lifecycle and ./emulator-config.ts
 * for the typed config.
 */
import { emulatorConfig } from "./emulator-config";
import { startEmulator } from "./emulator-loader";
import {
  isPauseWhenHiddenEnabled,
  setPauseWhenHidden,
  onPauseWhenHiddenChange,
  isShowEditorEnabled,
  setShowEditor,
  onShowEditorChange,
} from "./settings";
import { mountPlayground } from "./playground/editor";

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app root element");
}

// Inline rainbow Apple logo. Six horizontal bands clipped to a bitten-apple
// silhouette. Kept inline so the page renders without any asset fetch.
const appleLogoSvg = /* html */ `
  <svg viewBox="0 0 28 32" aria-hidden="true" focusable="false">
    <defs>
      <clipPath id="apple-clip">
        <path d="M19.6 17.1c0-3.6 2.9-5.3 3-5.4-1.6-2.4-4.2-2.7-5.1-2.8-2.2-.2-4.2 1.3-5.3 1.3-1.1 0-2.8-1.3-4.6-1.2-2.3 0-4.5 1.4-5.7 3.4-2.4 4.2-.6 10.5 1.8 13.9 1.2 1.7 2.5 3.5 4.3 3.5 1.7-.1 2.4-1.1 4.5-1.1 2.1 0 2.7 1.1 4.6 1.1 1.9 0 3.1-1.7 4.2-3.4 1.3-2 1.9-3.9 1.9-4-.1 0-3.6-1.4-3.6-5.3zM16.6 6.6c.9-1.1 1.6-2.7 1.4-4.2-1.4.1-3 .9-4 2-.9.9-1.6 2.5-1.4 4 1.5.1 3.1-.7 4-1.8z" />
      </clipPath>
    </defs>
    <g clip-path="url(#apple-clip)">
      <rect x="0" y="0" width="28" height="6" fill="#7DB728" />
      <rect x="0" y="6" width="28" height="6" fill="#F2C418" />
      <rect x="0" y="12" width="28" height="6" fill="#F38B2C" />
      <rect x="0" y="18" width="28" height="6" fill="#E94B3B" />
      <rect x="0" y="24" width="28" height="5" fill="#7E3FA1" />
      <rect x="0" y="29" width="28" height="3" fill="#0080C7" />
    </g>
  </svg>
`;

// Tiny 1-bit-style document icon for the "desktop" decoration. Drawn as
// SVG with crisp edges so it reads as pixel art at 32×32.
const docIconSvg = /* html */ `
  <svg viewBox="0 0 32 32" shape-rendering="crispEdges" aria-hidden="true"
       focusable="false" class="desktop-icon__glyph">
    <rect x="6" y="3" width="17" height="26" fill="#fff" stroke="#000" stroke-width="1" />
    <polygon points="23,3 23,9 29,9" fill="#fff" stroke="#000" stroke-width="1" />
    <line x1="23" y1="3" x2="29" y2="9" stroke="#000" stroke-width="1" />
    <line x1="9" y1="14" x2="20" y2="14" stroke="#000" />
    <line x1="9" y1="17" x2="20" y2="17" stroke="#000" />
    <line x1="9" y1="20" x2="20" y2="20" stroke="#000" />
    <line x1="9" y1="23" x2="16" y2="23" stroke="#000" />
  </svg>
`;

const today = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
}).format(new Date());

root.innerHTML = /* html */ `
  <div class="menubar" role="navigation" aria-label="Menu bar">
    <span class="menubar__apple">${appleLogoSvg}</span>
    <span class="menubar__item">File</span>
    <span class="menubar__item">Edit</span>
    <span class="menubar__item">View</span>
    <span class="menubar__item">Special</span>
    <span class="menubar__item menubar__item--right">${today}</span>
  </div>

  <div class="desktop-icon" aria-hidden="true">
    ${docIconSvg}
    <span class="desktop-icon__label">Read Me</span>
  </div>

  <!-- Two-pane split layout (issue #45).
       At ≥1200px: left pane = Mac + supporting windows, right pane = editor.
       Below 1200px: all panes are transparent wrappers; windows stack normally. -->
  <div class="cvm-split-layout" id="cvm-split-layout" data-editor-visible="true">

    <!-- Left pane: Macintosh window + Read Me + Emulator Config -->
    <div class="cvm-split-pane cvm-split-pane--left">

      <section class="window window--wide" aria-labelledby="title-emu">
        <header class="window__titlebar">
          <span class="window__close" aria-hidden="true"></span>
          <h2 class="window__title" id="title-emu">Macintosh</h2>
        </header>
        <div class="window__body window__body--platinum">
          <div class="inset" id="emulator">
            <div id="emulator-canvas-mount" class="emulator-mount"></div>
          </div>
          <!--
            Settings caption sits BELOW the inset (still inside the Macintosh
            window's body, so it reads as part of the same chrome). A period-
            styled checkbox lets the visitor opt out of pause-when-hidden.
            The "💤" indicator on the right replaces the static label when
            the emulator is currently paused. See settings.ts + emulator-loader.
          -->
          <div class="emulator-caption" role="group" aria-label="Emulator preferences">
            <label class="cvm-check">
              <input type="checkbox" id="cvm-pause-when-hidden" />
              <span class="cvm-check__box" aria-hidden="true"></span>
              <span class="cvm-check__label">Pause emulator when tab is hidden</span>
            </label>
            <label class="cvm-check">
              <input type="checkbox" id="cvm-show-editor" />
              <span class="cvm-check__box" aria-hidden="true"></span>
              <span class="cvm-check__label">Show editor</span>
            </label>
            <span class="emulator-caption__status" id="cvm-pause-status" aria-live="polite"></span>
          </div>
        </div>
      </section>

      <section class="window" aria-labelledby="title-readme">
        <header class="window__titlebar">
          <span class="window__close" aria-hidden="true"></span>
          <h2 class="window__title" id="title-readme">Read Me &mdash; SimpleText</h2>
        </header>
        <div class="window__body">
          <h1>classic-vibe-mac</h1>
          <p>
            A GitHub template for building a classic Macintosh app in C and
            serving it, running, in a browser. Push your source. The template
            cross-compiles it for the 68k Mac, packs the binary into an HFS
            disk image, and boots it inside System&nbsp;7.5.5 on a
            WebAssembly Basilisk&nbsp;II.
          </p>
          <p>
            It is, more or less, a 1993 Macintosh that lives at a URL.
          </p>

          <h2>What it does</h2>
          <ul>
            <li>Cross-compiles C to a 68k Mac binary using
              <a href="https://github.com/autc04/Retro68">Retro68</a>, in
              GitHub Actions.</li>
            <li>Packs the binary into a bootable HFS System&nbsp;7.5.5 disk
              with <code>hfsutils</code>; the Finder auto-launches it
              on boot.</li>
            <li>Hosts a Vite + TypeScript page that mounts Basilisk&nbsp;II
              (GPL-2.0, vendored from
              <a href="https://github.com/mihaip/infinite-mac">Infinite Mac</a>'s
              Apache-2.0 build) and boots System&nbsp;7.5.5.</li>
            <li>Ships two demo apps side-by-side:
              <a href="https://github.com/khawkins98/classic-vibe-mac/tree/main/src/app/reader">Reader</a>
              (a tiny HTML viewer that reads from <code>:Shared:</code> on
              the boot disk) and
              <a href="https://github.com/khawkins98/classic-vibe-mac/tree/main/src/app/macweather">MacWeather</a>
              (live forecast data via a JS poller, rendered with 1-bit
              QuickDraw glyphs).</li>
            <li>Three-layer testing: host C unit tests, Playwright end-to-end,
              and AI vision assertions on canvas screenshots.</li>
          </ul>

          <h2>Make your own</h2>
          <p>
            Fork the repo (or click <em>Use this template</em>), drop your C
            source into <code>src/app/</code>, and push. CI handles the rest.
          </p>
          <pre>git clone https://github.com/your-fork/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run dev</pre>

          <h2>How this works</h2>
          <p>
            Curious about the stack? See
            <a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/docs/HOW-IT-WORKS.md">HOW-IT-WORKS.md</a>
            &mdash; a guided tour of how the page above goes from "static
            files on GitHub Pages" to "1993 Macintosh running your edited
            app", plus what you can build with this stack and where it
            stops compared to other paths into classic Mac development.
          </p>

          <h2>Status</h2>
          <p>
            The pipeline runs end-to-end. Two apps ship on the boot disk
            and the Finder auto-launches them. Reader renders HTML; MacWeather
            renders the live forecast. See
            <a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/PRD.md">PRD.md</a>
            for what's still on the list.
          </p>
        </div>
      </section>

      <section class="window window--narrow" aria-labelledby="title-config">
        <header class="window__titlebar">
          <span class="window__close" aria-hidden="true"></span>
          <h2 class="window__title" id="title-config">Emulator Config</h2>
        </header>
        <div class="window__body">
          <p>
            For the curious. This is what the BasiliskII loader will be handed
            once it is wired up.
          </p>
          <pre id="config"></pre>
        </div>
      </section>

    </div><!-- /.cvm-split-pane--left -->

    <!-- Drag divider — keyboard-accessible via role=separator + arrow keys -->
    <div
      class="cvm-split-divider"
      id="cvm-split-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize Mac and editor panes"
      aria-valuemin="30"
      aria-valuemax="80"
      aria-valuenow="65"
      tabindex="0"
      title="Drag to resize panes"
    ></div>

    <!-- Right pane: playground editor -->
    <div class="cvm-split-pane cvm-split-pane--right">
      <section class="window window--wide window--playground" id="cvm-playground" aria-labelledby="title-playground">
      </section>
    </div><!-- /.cvm-split-pane--right -->

  </div><!-- /.cvm-split-layout -->
`;

const configEl = document.getElementById("config");
if (configEl) {
  configEl.textContent = JSON.stringify(emulatorConfig, null, 2);
}

// ── Settings checkbox wiring (sleep when hidden) ──
//
// The checkbox lives in the caption row under the Mac window. We keep
// the DOM in sync with the persisted value (cvm.pauseWhenHidden) on:
//   - initial load
//   - cross-tab storage events (handled inside settings.ts → onPauseWhenHiddenChange)
// Toggling fires the setter which both persists and notifies listeners,
// so the loader's visibility controller observes the change immediately.
const pauseCheckbox = document.getElementById(
  "cvm-pause-when-hidden",
) as HTMLInputElement | null;
const pauseStatus = document.getElementById("cvm-pause-status");
if (pauseCheckbox) {
  pauseCheckbox.checked = isPauseWhenHiddenEnabled();
  pauseCheckbox.addEventListener("change", () => {
    setPauseWhenHidden(pauseCheckbox.checked);
  });
  // Mirror back in case another tab toggled it.
  onPauseWhenHiddenChange(() => {
    const v = isPauseWhenHiddenEnabled();
    if (pauseCheckbox.checked !== v) pauseCheckbox.checked = v;
  });
}

// "💤 Paused" indicator. The loader fires `cvm:paused-change` on body
// whenever the actual pause state flips. We update both the caption text
// AND set a body class for CSS-driven canvas tinting (handled in style.css).
function renderPauseStatus(paused: boolean) {
  if (!pauseStatus) return;
  pauseStatus.textContent = paused ? "\u{1F4A4} Paused" : "";
  pauseStatus.classList.toggle("emulator-caption__status--paused", paused);
}
renderPauseStatus(false);
window.addEventListener("cvm:paused-change", (ev) => {
  const paused = !!(ev as CustomEvent<{ paused: boolean }>).detail?.paused;
  renderPauseStatus(paused);
});

// Hand the emulator slot to the loader. It owns rendering inside this
// element from this point on (progress UI, then canvas). If anything goes
// wrong it switches to its own error/stub state — main.ts does not need
// to handle failures. We retain the handle so the playground's "Build &
// Run" button can call `reboot()` to swap the secondary disk.
const emulatorMount = document.getElementById("emulator-canvas-mount");
type EmulatorHandle = ReturnType<typeof startEmulator>;
let emulatorHandle: EmulatorHandle | null = null;
if (emulatorMount) {
  emulatorHandle = startEmulator(emulatorConfig, emulatorMount);
}

// ── Two-pane split layout (issue #45) ──────────────────────────────────────
//
// At ≥1200px the page switches from a vertical stack to a side-by-side IDE
// layout: Mac + supporting windows on the left, editor on the right, with a
// draggable divider. Below 1200px the split panes are transparent wrappers
// and the existing stacked layout is unchanged.

const splitLayoutEl = document.getElementById(
  "cvm-split-layout",
) as HTMLDivElement | null;
const splitDividerEl = document.getElementById(
  "cvm-split-divider",
) as HTMLDivElement | null;

const SPLIT_PCT_KEY = "cvm.splitPct";
const SPLIT_DEFAULT = 65;
const SPLIT_MIN = 30;
const SPLIT_MAX = 80;

let splitPct = SPLIT_DEFAULT;
try {
  const stored = localStorage.getItem(SPLIT_PCT_KEY);
  if (stored) {
    const v = Number(stored);
    if (Number.isFinite(v) && v >= SPLIT_MIN && v <= SPLIT_MAX) splitPct = v;
  }
} catch { /* ignore */ }

function clampSplit(pct: number): number {
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct));
}

function applySplitPct(pct: number, persist = false): void {
  splitPct = clampSplit(pct);
  if (splitLayoutEl) {
    splitLayoutEl.style.setProperty("--split-pct", `${splitPct}%`);
  }
  if (splitDividerEl) {
    splitDividerEl.setAttribute("aria-valuenow", String(Math.round(splitPct)));
  }
  if (persist) {
    try { localStorage.setItem(SPLIT_PCT_KEY, String(splitPct)); } catch { /* ignore */ }
  }
}
applySplitPct(splitPct);

if (splitDividerEl && splitLayoutEl) {
  let dragging = false;

  splitDividerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    document.body.classList.add("cvm-resizing");
    splitDividerEl.setPointerCapture(e.pointerId);
  });

  splitDividerEl.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = splitLayoutEl.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    applySplitPct(pct);
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("cvm-resizing");
    applySplitPct(splitPct, /* persist */ true);
  };
  splitDividerEl.addEventListener("pointerup", stopDrag);
  splitDividerEl.addEventListener("pointercancel", stopDrag);

  // Keyboard resize: arrows ±2%, Shift+arrows ±10%, Home/End = clamps, Enter = reset.
  splitDividerEl.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 10 : 2;
    if (e.key === "ArrowLeft") applySplitPct(splitPct - step, true);
    else if (e.key === "ArrowRight") applySplitPct(splitPct + step, true);
    else if (e.key === "Home") applySplitPct(SPLIT_MIN, true);
    else if (e.key === "End") applySplitPct(SPLIT_MAX, true);
    else if (e.key === "Enter") applySplitPct(SPLIT_DEFAULT, true);
    else return;
    e.preventDefault();
  });
}

// ── Playground (Phase 1: read-only-leaning viewer + IDB-backed editor) ──
//
// Mounted under the Macintosh window. Vite's import.meta.env.BASE_URL is
// the configured base path (e.g. `/` in dev, `/classic-vibe-mac/` on
// Pages); the playground prepends it to fetch bundled sample files from
// `/sample-projects/<project>/<filename>`. The mount is async because
// initPersistence() opens IndexedDB.
const playgroundEl = document.getElementById("cvm-playground");
const showEditorCheckbox = document.getElementById(
  "cvm-show-editor",
) as HTMLInputElement | null;

function applyEditorVisibility(visible: boolean) {
  if (!playgroundEl) return;
  // Hide the section (mobile + stacked layout: collapses it entirely).
  playgroundEl.toggleAttribute("hidden", !visible);
  // At desktop, also signal the split container so CSS can collapse/expand
  // the right pane and divider without touching the left pane's flex basis.
  if (splitLayoutEl) {
    splitLayoutEl.dataset.editorVisible = visible ? "true" : "false";
  }
}

if (showEditorCheckbox) {
  showEditorCheckbox.checked = isShowEditorEnabled();
  showEditorCheckbox.addEventListener("change", () => {
    setShowEditor(showEditorCheckbox.checked);
    applyEditorVisibility(showEditorCheckbox.checked);
  });
  onShowEditorChange(() => {
    const v = isShowEditorEnabled();
    if (showEditorCheckbox.checked !== v) showEditorCheckbox.checked = v;
    applyEditorVisibility(v);
  });
}

if (playgroundEl) {
  applyEditorVisibility(isShowEditorEnabled());
  // Hot-load callback: hands the patched HFS image to the loader, which
  // tears down the worker, spawns a fresh one with the new disk in the
  // secondary slot, and resolves once the second boot is complete.
  void mountPlayground(
    playgroundEl,
    import.meta.env.BASE_URL,
    emulatorHandle
      ? async ({ bytes, volumeName }) => {
          await emulatorHandle!.reboot({
            kind: "inMemory",
            name: volumeName,
            bytes,
          });
        }
      : undefined,
  );
}
