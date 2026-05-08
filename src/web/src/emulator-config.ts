/**
 * Emulator configuration — typed shape consumed by emulator-loader.ts.
 *
 * Files referenced here are placed by `scripts/fetch-emulator.sh` (binaries),
 * `scripts/build-disk-image.sh` (app.dsk), and `scripts/build-boot-disk.sh`
 * (system755-vibe.dsk). The build pipeline copies the .dsk artifacts next
 * to index.html post-`vite build`. Everything is served as static GH Pages
 * assets at the Vite `base` path.
 */
export interface EmulatorConfig {
  /** BasiliskII Emscripten loader (.js). Sibling-loads the .wasm. */
  coreUrl: string;
  /** BasiliskII WebAssembly module. */
  wasmUrl: string;
  /**
   * Boot disk for System 7.5.5.
   *
   * Points at our self-hosted, app-pre-installed System 7.5.5 disk image
   * (built by scripts/build-boot-disk.sh in CI). The loader actually
   * fetches `${bootDiskUrl}.json` (the chunked manifest) and individual
   * chunks from `${bootDiskUrl-without-.dsk}-chunks/`, NOT the single-file
   * .dsk — the .dsk URL is preserved for HEAD-checking and as the
   * canonical "show this in the JSON config preview" path. The chunking
   * is required because the BasiliskII WASM core consumes disks through
   * EmulatorWorkerChunkedDisk (worker/chunked-disk.ts upstream).
   */
  bootDiskUrl: string | null;
  /** Our generated app.dsk (HFS, ~1MB) — sits next to index.html. */
  appDiskUrl: string;
  /** Logical screen size for the emulated Mac. 512x342 = original Mac. */
  screen: { width: number; height: number };
  /**
   * Static seed for the `Shared` Mac volume.
   *
   * BasiliskII's `extfs /Shared/` pref (see BASE_PREFS in emulator-worker.ts)
   * exposes whatever lives at `/Shared/` in the Emscripten in-memory FS as a
   * Mac volume named "Shared". We populate that directory at boot by
   * fetching each entry below and writing it to FS via `FS.createDataFile`
   * inside the Module's preRun hook.
   *
   * The Reader app (src/app/reader.c) reads `:Shared:index.html` on launch
   * and resolves links by name against `:Shared:`, so the file names listed
   * here must include `index.html` plus any pages the Reader links to.
   *
   * URLs are absolute or relative-to-page paths; the worker resolves them
   * against `self.location.href` before fetching.
   */
  sharedFolder: {
    /** List of files to seed under `/Shared/`. `name` is what the Mac sees
     * (`:Shared:<name>`), `url` is where the worker fetches the bytes. */
    files: Array<{ name: string; url: string }>;
  };
}

// import.meta.env.BASE_URL is the Vite `base` setting at build time, e.g.
// "/classic-vibe-mac/" on GH Pages and "/" in dev. Always trailing slash.
const BASE = import.meta.env.BASE_URL;

export const emulatorConfig: EmulatorConfig = {
  coreUrl: `${BASE}emulator/BasiliskII.js`,
  wasmUrl: `${BASE}emulator/BasiliskII.wasm`,
  // Loader resolves `${bootDiskUrl}.json` for the chunked manifest and
  // `${bootDiskUrl-without-.dsk}-chunks/<sig>.chunk` for chunk fetches.
  bootDiskUrl: `${BASE}system755-vibe.dsk`,
  appDiskUrl: `${BASE}app.dsk`,
  screen: { width: 640, height: 480 },
  // Sample HTML content seeded by the C-side Reader app's prerequisite
  // (commit 46fe8c4). These files live under src/web/public/shared/ and
  // are served by Vite at `${BASE}shared/<name>` in dev/production. The
  // worker fetches them and copies their bytes into the Emscripten FS at
  // `/Shared/<name>` on boot, which BasiliskII then surfaces to System 7
  // as the `Shared` Mac volume via the `extfs /Shared/` pref.
  sharedFolder: {
    files: [
      { name: "index.html", url: `${BASE}shared/index.html` },
      { name: "about.html", url: `${BASE}shared/about.html` },
      { name: "credits.html", url: `${BASE}shared/credits.html` },
      { name: "inside-macintosh.html", url: `${BASE}shared/inside-macintosh.html` },
      { name: "lorem.html", url: `${BASE}shared/lorem.html` },
    ],
  },
};
