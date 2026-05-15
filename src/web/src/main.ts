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
  BUNDLE_VERSION,
  BUILT_AT,
  TOOLCHAIN_VERSION,
  SAMPLE_PROJECTS,
} from "./playground/types";

// Identity stamp printed on every page load. Survives in DevTools across
// reloads/navigation, so we can tell at a glance which deploy a user's
// tab is running — invaluable when debugging the wasm toolchain ("does
// your binary match mine?") and post-deploy sanity checks.
// - bundleVersion: hash of the C sample sources (changes on sample edits)
// - toolchainVersion: hash of cc1/as/ld/Elf2Mac + sysroot blobs (changes
//   on toolchain updates — what bundleVersion misses)
// - builtAt: Vite's wall-clock at bundle time
// - loaded: when this tab fetched the JS
// If builtAt is hours stale but loaded is fresh, you're on cached HTML
// pointing at old JS. If toolchainVersion doesn't match the latest deploy,
// your browser is caching old wasm-cc1 assets.
console.info(
  `[cvm] build bundleVersion=${BUNDLE_VERSION} toolchainVersion=${TOOLCHAIN_VERSION} builtAt=${BUILT_AT} loaded=${new Date().toISOString()}`,
);
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

  <!--
    Mac OS 8 IDE layout (cv-mac #104; supersedes the #45 two-pane split).
    At ≥1200px: 3-column CSS grid with the right column further split
    top/bottom. At narrower viewports each grid cell becomes a normal
    block — content stacks vertically in source order.

    Grid cells (id-stable for tests + downstream wiring):
      .cvm-ide__files  — left files panel (project picker, Phase 3+)
      .cvm-ide__editor — center editor (existing playground innards)
      .cvm-ide__mac    — top-right Macintosh preview
      .cvm-ide__output — bottom-right output/console panel (Phase 4+)

    The data-editor-visible attribute on .cvm-ide, when "false", hides
    the editor column and expands the Mac to take the whole grid — a
    "Mac-only focus mode" toggled by the "Show editor" checkbox.
  -->
  <div class="cvm-ide" id="cvm-split-layout" data-editor-visible="true">

    <!-- LEFT: files panel (1/5 width).
         Phase 2 content: static list of SAMPLE_PROJECTS as a Mac OS 8
         icon-list sidebar. The playground's project dropdown is still
         the canonical control; this panel is preview/navigation surface
         until Phase 3 wires the WinBox startup picker. -->
    <aside class="cvm-ide__files window" aria-labelledby="title-files">
      <header class="window__titlebar">
        <span class="window__close" aria-hidden="true"></span>
        <h2 class="window__title" id="title-files">Projects</h2>
      </header>
      <div class="window__body cvm-files">
        <ul class="cvm-files__list" role="list">
          ${SAMPLE_PROJECTS.map((p) => `
            <li class="cvm-files__item" data-project-id="${p.id}">
              <span class="cvm-files__icon">📄</span>
              <span class="cvm-files__label">${p.label}</span>
            </li>
          `).join("")}
        </ul>
        <p class="cvm-files__hint">
          Multi-file editing + .zip import / export coming with
          <a href="https://github.com/khawkins98/classic-vibe-mac/issues/100">#100</a>.
          The dropdown in the editor pane is the live project switcher today.
        </p>
      </div>
    </aside>

    <!-- CENTER: playground editor (2/5 width).
         The existing playground section (project picker, build buttons,
         tabs, CodeMirror) is mounted into this slot by editor.ts's
         mountPlayground(). No internal restructure in Phase 2 — just
         rehoming the same DOM into a wider, primary-position column. -->
    <section class="cvm-ide__editor window window--wide window--playground"
             id="cvm-playground"
             aria-labelledby="title-playground">
    </section>

    <!-- RIGHT TOP: Macintosh preview (2/5 width, ~60% height). -->
    <section class="cvm-ide__mac window" aria-labelledby="title-emu">
      <header class="window__titlebar">
        <span class="window__close" aria-hidden="true"></span>
        <h2 class="window__title" id="title-emu">Macintosh</h2>
      </header>
      <div class="window__body window__body--platinum cvm-ide__mac-body">
        <div class="inset" id="emulator">
          <div id="emulator-canvas-mount" class="emulator-mount"></div>
        </div>
        <!--
          Settings caption sits BELOW the inset (still inside the Macintosh
          window's body). The "💤" indicator on the right replaces the static
          label when the emulator is currently paused. "Show editor"
          collapses the editor column for a full-width Mac focus mode.
          See settings.ts + emulator-loader.
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

    <!-- RIGHT BOTTOM: Output panel (2/5 width, ~40% height).
         Phase 2 content: placeholder. Phase 4 moves Show Assembly + the
         compile log + DebugStr capture into this slot as tabs.
         See cv-mac #104. -->
    <section class="cvm-ide__output window" aria-labelledby="title-output">
      <header class="window__titlebar">
        <span class="window__close" aria-hidden="true"></span>
        <h2 class="window__title" id="title-output">Output</h2>
      </header>
      <div class="window__body cvm-output">
        <p class="cvm-output__hint">
          <strong>Phase 2 placeholder.</strong> Compiler log, Show
          Assembly, console output, and DebugStr capture will move
          into this panel as tabs in a follow-up
          (<a href="https://github.com/khawkins98/classic-vibe-mac/issues/104">cv-mac #104</a>).
          For now, expand the assembly section inside the editor pane.
        </p>
      </div>
    </section>

  </div><!-- /.cvm-ide -->

  <!-- Below-the-fold marketing content: Read Me + Emulator Config.
       Pre-#104 these lived inside the left pane alongside the Mac.
       With the IDE layout the editor is primary, so the marketing
       content moves below the grid — discoverable via scroll, but
       not competing for editor space. -->
  <div class="cvm-below-fold">

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
            For the curious. The config object below is what the
            BasiliskII loader is handed at boot — the chunked HFS
            disk URL, the canvas dimensions, the shared-folder
            mapping, the weather fallback coords, etc.
          </p>
          <pre id="config"></pre>
        </div>
      </section>

  </div><!-- /.cvm-below-fold -->
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

// ── Mac OS 8 IDE grid layout (#104) ────────────────────────────────────────
//
// The page is a fixed CSS grid at ≥1200px: files | editor | (Mac / Output).
// No draggable divider (cv-mac #45's drag-divider system was removed in
// #104 because grid cells don't resize the same way flex panes did).
// At <1200px the grid cells become normal blocks and content stacks.
//
// We still hold a reference to the layout element because applyEditorVisibility()
// toggles data-editor-visible on it.

const splitLayoutEl = document.getElementById(
  "cvm-split-layout",
) as HTMLDivElement | null;

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
