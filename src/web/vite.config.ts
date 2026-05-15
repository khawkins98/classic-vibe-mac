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
];


function readSeedContents(): { contents: Map<string, string>; hash: string } {
  const contents = new Map<string, string>();
  const hasher = createHash("sha256");
  for (const spec of SEED_FILES) {
    let body = "";
    if (existsSync(spec.sourcePath)) {
      body = readFileSync(spec.sourcePath, "utf8");
    }
    contents.set(`${spec.project}/${spec.filename}`, body);
    hasher.update(`${spec.project}/${spec.filename}\n`);
    hasher.update(body);
    hasher.update("\n--\n");
  }
  return { contents, hash: hasher.digest("hex").slice(0, 16) };
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

function writeSeedToPublic(contents: Map<string, string>): void {
  for (const [key, body] of contents) {
    const out = join(PUBLIC_DIR, "sample-projects", key);
    mkdirSync(dirname(out), { recursive: true });
    // Write only if changed to keep Vite's fs watcher quiet.
    let needsWrite = true;
    try {
      const existing = readFileSync(out, "utf8");
      if (existing === body) needsWrite = false;
    } catch {
      // file doesn't exist
    }
    if (needsWrite) writeFileSync(out, body, "utf8");
  }
}

function playgroundSeedPlugin(): Plugin {
  let bundleHash = "dev";
  return {
    name: "cvm-playground-seed",
    enforce: "pre",
    config() {
      const { contents, hash } = readSeedContents();
      bundleHash = hash;
      writeSeedToPublic(contents);
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
          const { contents, hash } = readSeedContents();
          bundleHash = hash;
          writeSeedToPublic(contents);
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
        manualChunks: {
          "cvm-codemirror": [
            "@codemirror/state",
            "@codemirror/view",
            "@codemirror/commands",
            "@codemirror/language",
            "@codemirror/lang-cpp",
          ],
          "cvm-jszip": ["jszip"],
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
