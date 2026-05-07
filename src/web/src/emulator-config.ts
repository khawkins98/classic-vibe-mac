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
};
