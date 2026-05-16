import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

// GitHub Pages serves the site under /<repo-name>/ when using a project page
// (e.g. https://<user>.github.io/classic-vibe-mac/). Override at build time
// with VITE_BASE=/your-repo-name/ npm run build.
//
// TODO: once the canonical repo name is decided, hard-code the default here
// (e.g. "/classic-vibe-mac/") so a fresh fork's CI build works without env
// configuration. For local `npm run dev` we always want "/".
const base = process.env.VITE_BASE ?? "/";

// ────────────────────────────────────────────────────────────────────────
// Playground Phase 1: sample-project seeding
//
// We expose a small set of source files from `src/app/<project>/` to the
// browser at `/sample-projects/<project>/<filename>`. Two reasons to do
// this in a Vite plugin instead of just symlinking into `public/`:
//
//   1. The canonical source lives in `src/app/`. Copying keeps that
//      single source of truth — editing reader.c there is the only edit
//      anyone has to do; the playground picks it up on next build.
//   2. We compute a hash of the bundled file contents at build/dev start
//      and inject it as the global constant `__CVM_BUNDLE_VERSION__`.
//      The persistence layer compares that constant to the version it
//      seeded last; on mismatch it wipes the user's IDB-stored copies so
//      the freshly bundled source loads. (3-way diff is deferred — see
//      the editor reviewer's notes on Issue #21.)
//
// In dev, the plugin writes to `public/sample-projects/` once at
// `configResolved` so the dev server's static middleware serves them.
// ────────────────────────────────────────────────────────────────────────

interface SeedSpec {
  project: string;
  filename: string;
  /** Absolute path to the source file under src/app. */
  sourcePath: string;
}

const REPO_ROOT = resolve(__dirname, "..", "..");
const PUBLIC_DIR = resolve(__dirname, "public");

const SEED_FILES: SeedSpec[] = [
  // Legacy splice-path projects (reader / macweather / hello-mac) used
  // to seed source bundles here so the playground could let users edit
  // their .r resource forks. Removed 2026-05-15 (cv-mac #100) — the
  // playground now only seeds projects that build end-to-end in the
  // browser, so the visible projects are all fully editable. The
  // source dirs at src/app/{reader,macweather,hello-mac}/ are still
  // canonical sources for CI's boot-disk build.
  //
  // wasm-hello — first project that compiles end-to-end in the
  // browser (cv-mac #64). Single hello.c, no .r resources, no CMake
  // / CI build. The playground's Build & Run path uses compileToBin()
  // to produce the MacBinary directly in the user's browser.
  ...["hello.c"].map((f) => ({
    project: "wasm-hello",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-hello", f),
  })),
  // wasm-hello-multi — multi-file in-browser-compile demo (cv-mac #100
  // Phase A). main.c + greet.c + greet.h; exercises compileToBin's new
  // multi-source path.
  ...["main.c", "greet.c", "greet.h"].map((f) => ({
    project: "wasm-hello-multi",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-hello-multi", f),
  })),
  // wasm-hello-window — mixed C + .r in-browser-compile demo (cv-mac
  // #100 Phase B). .c compiles via wasm-cc1; .r compiles via WASM-Rez;
  // spliceResourceFork merges the two forks.
  ...["hello.c", "hello.r"].map((f) => ({
    project: "wasm-hello-window",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-hello-window", f),
  })),
  // wasm-snake — Phase D demo. A playable Snake clone with arrow-key
  // input, TickCount-driven movement, win/lose/restart state. Uses
  // the same mixed C + .r path as wasm-hello-window.
  ...["snake.c", "snake.r"].map((f) => ({
    project: "wasm-snake",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-snake", f),
  })),
  // wasm-textedit — TextEdit demo (#125). Foundation toward a word
  // processor: window + TEHandle + TEClick/TEKey/TEIdle.
  ...["textedit.c", "textedit.r"].map((f) => ({
    project: "wasm-textedit",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-textedit", f),
  })),
  // wasm-notepad — TextEdit + real Mac menu bar (#125). Adds MBAR /
  // MenuSelect / MenuKey dispatch, Apple/File/Edit menus, and an
  // ALRT-based About dialog on top of the textedit foundation.
  ...["notepad.c", "notepad.r"].map((f) => ({
    project: "wasm-notepad",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-notepad", f),
  })),
  // wasm-stickynote — small floating sticky-note window (#125). Smaller
  // than wasm-notepad: no menubar, no scrap. Pale-yellow paper field
  // and a single TextEdit exercising RGBBackColor / RGBForeColor —
  // colour QuickDraw is unique to this project in the wasm-* shelf.
  ...["stickynote.c", "stickynote.r"].map((f) => ({
    project: "wasm-stickynote",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-stickynote", f),
  })),
  // wasm-clock — analog desk clock with digital readout (#125). New
  // Toolbox slice for the shelf: GetDateTime + SecondsToDate, idle-tick
  // redraw loop, all QuickDraw drawing, hand-rolled sin/cos table.
  ...["clock.c", "clock.r"].map((f) => ({
    project: "wasm-clock",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-clock", f),
  })),
  // wasm-multiwin — three windows, one event loop. Every other sample
  // on the shelf is single-window; this one demonstrates the
  // front-window dispatch model (SelectWindow on back-window clicks,
  // refCon-stashed per-window state, last-close exits).
  ...["multiwin.c", "multiwin.r"].map((f) => ({
    project: "wasm-multiwin",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-multiwin", f),
  })),
  // wasm-cursor — Cursor Manager / region-driven cursor swap.
  ...["cursor.c", "cursor.r"].map((f) => ({
    project: "wasm-cursor",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-cursor", f),
  })),
  // wasm-files — File I/O via StandardGetFile / StandardPutFile.
  ...["files.c", "files.r"].map((f) => ({
    project: "wasm-files",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-files", f),
  })),
  // wasm-gworld — modern NewGWorld + LockPixels + CopyBits double-buffer.
  ...["gworld.c", "gworld.r"].map((f) => ({
    project: "wasm-gworld",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-gworld", f),
  })),
  // wasm-wordpad — Mini word processor (#125). Font / Size / Style
  // menus driving a monostyle TextEdit; the next ladder rung after
  // Notepad. The last item in the #125 sprint.
  ...["wordpad.c", "wordpad.r"].map((f) => ({
    project: "wasm-wordpad",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-wordpad", f),
  })),
  // wasm-calculator — 4-function calculator (#125). Different surface
  // from the TextEdit ladder: hand-drawn buttons + PtInRect hit-testing
  // + NumToString display. No TextEdit, no scrap.
  ...["calc.c", "calc.r"].map((f) => ({
    project: "wasm-calculator",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-calculator", f),
  })),
  // wasm-scribble — mouse-tracking draw demo (#125). StillDown /
  // GetMouse / LineTo loop. Different Toolbox surface from the
  // TextEdit + Calculator samples.
  ...["scribble.c", "scribble.r"].map((f) => ({
    project: "wasm-scribble",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-scribble", f),
  })),
  // wasm-scrollwin — Controls / scroll-bar demo (#125). NewControl
  // (scrollBarProc) + TrackControl + actionProc. Fills the Controls
  // coverage gap flagged by the post-#144 review.
  ...["scrollwin.c", "scrollwin.r"].map((f) => ({
    project: "wasm-scrollwin",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-scrollwin", f),
  })),
  // wasm-patterns — QuickDraw 8x8 dither-pattern gallery (#125).
  // Fills the Bitmaps / Pattern coverage gap. Hand-rolled patterns +
  // QuickDraw's system globals (gray/ltGray/dkGray/white).
  ...["patterns.c", "patterns.r"].map((f) => ({
    project: "wasm-patterns",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-patterns", f),
  })),
  // wasm-bounce — offscreen BitMap + CopyBits double-buffer (#125).
  // Fills the GWorld/CopyBits gap. Bouncing ball, no flicker.
  ...["bounce.c", "bounce.r"].map((f) => ({
    project: "wasm-bounce",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-bounce", f),
  })),
  // wasm-debug-console — exercises the Output panel's Console tab
  // via cvm_log() (writes to /Shared/__cvm_console.log; the watcher
  // surfaces new lines in near-real-time). cvm_log.h is mounted as
  // a system header by cc1.ts, so it isn't bundled as a project
  // file.
  ...["console.c", "console.r"].map((f) => ({
    project: "wasm-debug-console",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-debug-console", f),
  })),
  // wasm-dialog — ModalDialog with EditText (#125). Fills the
  // "modal dialogs with editable fields" gap.
  ...["dialog.c", "dialog.r"].map((f) => ({
    project: "wasm-dialog",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-dialog", f),
  })),
  // wasm-sound — Sound Manager SysBeep demo (#125). Fills the
  // Sound Manager gap with the simplest, always-available trap.
  ...["sound.c", "sound.r"].map((f) => ({
    project: "wasm-sound",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-sound", f),
  })),
  // wasm-color — Color QuickDraw RGBForeColor demo (#125).
  ...["color.c", "color.r"].map((f) => ({
    project: "wasm-color",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-color", f),
  })),
  // wasm-arkanoid — first ★★★★★ demo (cv-mac #233 Option A).
  // Multi-file C (main + engine + render + header) plus a Rez file
  // with an embedded ICN# 128 — the "binary asset" the top tier
  // demonstrates.
  ...["main.c", "engine.c", "engine.h", "render.c", "arkanoid.r"].map((f) => ({
    project: "wasm-arkanoid",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-arkanoid", f),
  })),
  // wasm-icon-gallery — first ★★★★★★ demo (cv-mac #233 6-star tier).
  // Multi-file C + external binary asset (icons.rsrc.bin) shipped on
  // the disk alongside the app and loaded at runtime via OpenResFile.
  // icons.rsrc.bin is generated offline by
  // scripts/build-icon-gallery-rsrc.mjs and committed as a binary;
  // the seed plugin copies it to public/sample-projects/ as bytes
  // (not utf8-round-tripped — see the readSeedContents binary handling).
  ...["main.c", "gallery.c", "gallery.h", "render.c", "gallery.r", "icons.rsrc.bin"].map((f) => ({
    project: "wasm-icon-gallery",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-icon-gallery", f),
  })),
  // wasm-glypha3 — first real period app onboard (cv-mac #233 Phase 2).
  // John Calhoun's 1992 side-scroller, source released under MIT.
  // 9 .c files + 1 shared header = ~6600 LOC + a minimal Rez stub
  // (the upstream's 2.7 MB resource fork is its own follow-up).
  // Vendored verbatim from softdorothy/Glypha3 with a small
  // compatibility shim in Externs.h to bridge Universal-Headers gaps;
  // see the patch block at the top of Externs.h for details.
  ...[
    "Main.c", "Enemy.c", "Graphics.c", "Interface.c",
    "Play.c", "Prefs.c", "SetUpTakeDown.c", "Sound.c", "Utilities.c",
    "Externs.h", "glypha3.r",
  ].map((f) => ({
    project: "wasm-glypha3",
    filename: f,
    sourcePath: join(REPO_ROOT, "src", "app", "wasm-glypha3", f),
  })),
];

/** Files with these suffixes are treated as binary blobs (read with
 *  no encoding, hashed by their raw bytes, written verbatim) instead
 *  of utf8-round-tripped through string. cv-mac #233 6-star tier:
 *  .rsrc.bin files contain Mac resource forks (non-text bytes) that
 *  the app loads via OpenResFile at runtime; utf8 corruption breaks
 *  the format. */
function isBinarySeed(filename: string): boolean {
  return /\.(rsrc\.bin|bin|pict|snd|png|jpg|jpeg)$/i.test(filename);
}


function readSeedContents(): {
  contents: Map<string, string>;
  binaries: Map<string, Buffer>;
  hash: string;
} {
  const contents = new Map<string, string>();
  const binaries = new Map<string, Buffer>();
  const hasher = createHash("sha256");
  for (const spec of SEED_FILES) {
    const key = `${spec.project}/${spec.filename}`;
    hasher.update(`${key}\n`);
    if (isBinarySeed(spec.filename)) {
      const body = existsSync(spec.sourcePath)
        ? readFileSync(spec.sourcePath)
        : Buffer.alloc(0);
      binaries.set(key, body);
      hasher.update(body);
    } else {
      const body = existsSync(spec.sourcePath)
        ? readFileSync(spec.sourcePath, "utf8")
        : "";
      contents.set(key, body);
      hasher.update(body);
    }
    hasher.update("\n--\n");
  }
  return { contents, binaries, hash: hasher.digest("hex").slice(0, 16) };
}

// Hash the wasm-cc1 toolchain bundle (cc1/as/ld/Elf2Mac + sysroot blobs).
// BUNDLE_VERSION only covers the C sample sources, so toolchain-only
// updates (e.g. a new ld script vendored from wasm-retro-cc) don't show
// up there. This produces a separate stamp the user can grep for in the
// console log: "did my browser actually get the new toolchain?"
const TOOLCHAIN_FILES = [
  "cc1.wasm",
  "as.wasm",
  "ld.wasm",
  "Elf2Mac.wasm",
  "sysroot.bin",
  "sysroot.index.json",
  "sysroot-libs.bin",
  "sysroot-libs.index.json",
];

function readToolchainHash(): string {
  const hasher = createHash("sha256");
  for (const f of TOOLCHAIN_FILES) {
    const p = join(PUBLIC_DIR, "wasm-cc1", f);
    if (!existsSync(p)) continue;
    hasher.update(`${f}\n`);
    hasher.update(readFileSync(p));
    hasher.update("\n--\n");
  }
  return hasher.digest("hex").slice(0, 16);
}

function writeSeedToPublic(
  contents: Map<string, string>,
  binaries: Map<string, Buffer>,
): void {
  for (const [key, body] of contents) {
    const out = join(PUBLIC_DIR, "sample-projects", key);
    mkdirSync(dirname(out), { recursive: true });
    let needsWrite = true;
    try {
      const existing = readFileSync(out, "utf8");
      if (existing === body) needsWrite = false;
    } catch {
      /* file doesn't exist */
    }
    if (needsWrite) writeFileSync(out, body, "utf8");
  }
  for (const [key, body] of binaries) {
    const out = join(PUBLIC_DIR, "sample-projects", key);
    mkdirSync(dirname(out), { recursive: true });
    let needsWrite = true;
    try {
      const existing = readFileSync(out);
      if (existing.equals(body)) needsWrite = false;
    } catch {
      /* file doesn't exist */
    }
    if (needsWrite) writeFileSync(out, body);
  }
}

function playgroundSeedPlugin(): Plugin {
  let bundleHash = "dev";
  return {
    name: "cvm-playground-seed",
    enforce: "pre",
    config() {
      const { contents, binaries, hash } = readSeedContents();
      bundleHash = hash;
      writeSeedToPublic(contents, binaries);
      return {
        define: {
          __CVM_BUNDLE_VERSION__: JSON.stringify(hash),
          __CVM_BUILT_AT__: JSON.stringify(new Date().toISOString()),
          __CVM_TOOLCHAIN_VERSION__: JSON.stringify(readToolchainHash()),
        },
      };
    },
    configureServer(server) {
      // Re-seed if the source files change. The dev server's HMR will
      // notice the public-dir change and full-reload the page.
      const watcher = server.watcher;
      for (const spec of SEED_FILES) {
        if (existsSync(spec.sourcePath)) {
          try {
            watcher.add(spec.sourcePath);
          } catch {
            // best-effort
          }
        }
      }
      const onChange = (path: string) => {
        if (SEED_FILES.some((s) => s.sourcePath === path)) {
          const { contents, binaries, hash } = readSeedContents();
          bundleHash = hash;
          writeSeedToPublic(contents, binaries);
          server.ws.send({ type: "full-reload" });
        }
      };
      watcher.on("change", onChange);
      watcher.on("add", onChange);
    },
    // Surface the hash in build logs so it's visible to humans.
    closeBundle() {
      // eslint-disable-next-line no-console
      console.log(`[cvm-playground] bundleVersion=${bundleHash}`);
    },
  };
}

export default defineConfig({
  base,
  plugins: [playgroundSeedPlugin()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split heavyweight third-party deps into their own chunks so the
        // page-shell remains small and the editor + zip code can be cached
        // independently of the chrome.
        //
        // Function form (not the {chunk: [modules]} object form) because
        // Vite 6+ removed the object convenience and calls manualChunks
        // as a function only — see https://vite.dev/guide/migration.html.
        // The function form has always worked in Vite 5 too, so this is
        // a forward-compatible no-behaviour-change conversion (#107
        // unblocker for the dependabot major-Vite bump).
        manualChunks: (id) => {
          if (
            id.includes("/@codemirror/state/") ||
            id.includes("/@codemirror/view/") ||
            id.includes("/@codemirror/commands/") ||
            id.includes("/@codemirror/language/") ||
            id.includes("/@codemirror/lang-cpp/")
          ) {
            return "cvm-codemirror";
          }
          if (id.includes("/jszip/")) {
            return "cvm-jszip";
          }
          return undefined;
        },
      },
    },
    // TODO (build pipeline): after `vite build`, the CI workflow should copy
    // the freshly-built `app.dsk` (produced by scripts/build-disk-image.sh)
    // into `src/web/dist/` so it sits next to index.html and gets served by
    // GitHub Pages at `/app.dsk`. The emulator config in `src/emulator.ts`
    // expects to fetch it from that path. We deliberately do NOT use Vite's
    // `publicDir` for app.dsk because the disk image is generated outside the
    // web tree — it's a CI artifact, not a source asset.
  },
  server: {
    port: 5173,
    // BasiliskII (Infinite Mac WASM build) uses SharedArrayBuffer for the
    // shared input/video buffer between main thread and emulator worker.
    // SharedArrayBuffer requires cross-origin isolation, which requires
    // both COOP and COEP headers on the document response.
    //
    // Dev: Vite sets these on its dev server below.
    //
    // Production / GitHub Pages: Pages cannot set response headers (it's a
    // pure static host with no _headers/wrangler-style config). The chosen
    // workaround is `coi-serviceworker` (https://github.com/gzuidhof/coi-serviceworker),
    // which registers a service worker that re-issues every navigation
    // request with COOP/COEP headers attached. The shim is ~3KB, MIT-licensed,
    // and the standard fix for SharedArrayBuffer-on-Pages. We do not yet
    // ship it; once the boot disk plumbing lands (see emulator-config.ts)
    // and the worker actually needs SAB, the shim ships as a vendored
    // copy under public/ and a single <script> tag in index.html.
    //
    // Fallback if the shim ever proves problematic: BasiliskII has a non-SAB
    // mode (jsfrequentreadinput=false in BasiliskIIPrefs) that uses
    // service-worker-mediated message passing. Slower input latency, but no
    // isolation requirement. Listed here so the next agent doesn't have to
    // re-derive it.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      // `credentialless` instead of `require-corp` so the worker can
      // make cross-origin fetches (e.g. api.open-meteo.com for
      // MacWeather) without the remote needing to opt in via a
      // Cross-Origin-Resource-Policy header. Same SAB guarantees;
      // browsers also strip cookies on the cross-origin fetch.
      // Production keeps `require-corp` via coi-serviceworker which
      // rewrites response headers, so cross-origin fetches there pass
      // through the shim.
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
