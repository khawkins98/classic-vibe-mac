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

  <section class="window window--wide" aria-labelledby="title-emu">
    <header class="window__titlebar">
      <span class="window__close" aria-hidden="true"></span>
      <h2 class="window__title" id="title-emu">Macintosh</h2>
    </header>
    <div class="window__body window__body--platinum">
      <div class="inset" id="emulator">
        <div id="emulator-canvas-mount" class="emulator-mount"></div>
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
        disk image, and (soon) boots it inside System&nbsp;7.5.5 on a
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
        <li>Packs the binary into a small HFS disk image with
          <code>hfsutils</code>.</li>
        <li>Hosts a Vite + TypeScript page that mounts Basilisk&nbsp;II
          (Apache-2.0, via
          <a href="https://github.com/mihaip/infinite-mac">Infinite Mac</a>)
          and boots System&nbsp;7.5.5.</li>
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

      <h2>Status</h2>
      <p>
        The build pipeline compiles. The HFS disk image is packed. The
        BasiliskII core boots. Minesweeper is wired into the boot disk's
        Startup Items. See
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
`;

const configEl = document.getElementById("config");
if (configEl) {
  configEl.textContent = JSON.stringify(emulatorConfig, null, 2);
}

// Hand the emulator slot to the loader. It owns rendering inside this
// element from this point on (progress UI, then canvas). If anything goes
// wrong it switches to its own error/stub state — main.ts does not need
// to handle failures.
const emulatorMount = document.getElementById("emulator-canvas-mount");
if (emulatorMount) {
  startEmulator(emulatorConfig, emulatorMount);
}
