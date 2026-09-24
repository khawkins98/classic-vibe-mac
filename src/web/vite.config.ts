import { defineConfig, type Plugin } from "vite";
import { createHash } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
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

// Auto-discovered: every `src/app/wasm-*/` directory is a playground
// sample, and every file in it whose name matches SEED_FILE_PATTERN is
// seeded to `/sample-projects/<project>/<filename>`. Adding a sample no
// longer needs an edit here: drop the directory in and register it in
// SAMPLE_PROJECTS (src/web/src/playground/types.ts).
//
// Inclusion rules (derived from the hand-maintained list this replaced):
//   - C sources and headers (.c / .h), Rez sources (.r), and binary
//     resource-fork assets (.rsrc.bin, e.g. wasm-icon-gallery's
//     icons.rsrc.bin, loaded at runtime via OpenResFile).
//   - Everything else in the directory is ignored: upstream READMEs /
//     licences / pre-patch originals (wasm-glypha3's "Glypha III Read
//     Me.txt", LICENSE.upstream, Prefs.c.upstream), etc.
//
// The legacy splice-path projects (reader / macweather / hello-mac)
// don't match `wasm-*` and stay unseeded (removed 2026-05-15, cv-mac
// #100); their dirs remain canonical sources for CI's boot-disk build.
const SEED_FILE_PATTERN = /\.(c|h|r|rsrc\.bin)$/;

/** Files that match SEED_FILE_PATTERN but must NOT be bundled, keyed
 *  as `<project>/<filename>`. */
const SEED_EXCLUDES = new Set<string>([
  // cvm_log.h is mounted as a system header by cc1.ts (so
  // `#include <cvm_log.h>` works in any project); the copy in
  // wasm-debug-console is reference only, not a project file.
  "wasm-debug-console/cvm_log.h",
]);

const APP_DIR = join(REPO_ROOT, "src", "app");

function discoverSeedFiles(): SeedSpec[] {
  const specs: SeedSpec[] = [];
  const projects = readdirSync(APP_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("wasm-"))
    .map((d) => d.name)
    .sort();
  for (const project of projects) {
    const dir = join(APP_DIR, project);
    const files = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && SEED_FILE_PATTERN.test(d.name))
      .map((d) => d.name)
      .filter((f) => !SEED_EXCLUDES.has(`${project}/${f}`))
      .sort();
    for (const filename of files) {
      specs.push({ project, filename, sourcePath: join(dir, filename) });
    }
  }
  return specs;
}

let SEED_FILES: SeedSpec[] = discoverSeedFiles();

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
      // Watch src/app too so a file (or whole sample dir) added while
      // the dev server is running gets discovered without a restart.
      try {
        watcher.add(APP_DIR);
      } catch {
        // best-effort
      }
      const onChange = (path: string) => {
        if (path.startsWith(APP_DIR)) SEED_FILES = discoverSeedFiles();
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
