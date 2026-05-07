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
   * This points at our self-hosted, app-pre-installed System 7.5.5 disk
   * (built by scripts/build-boot-disk.sh in CI). It is the *bootable*
   * volume — its System Folder is blessed and contains a Startup Items
   * folder with our compiled Minesweeper inside, so once the emulator is
   * driving this disk the Finder will auto-launch the app on every boot
   * without any post-boot scripting.
   *
   * NOTE — this is currently shipped but NOT YET WIRED. The Infinite
   * Mac BasiliskII WASM core (which we vendor) does not consume a
   * single-file disk URL: ALL disk access flows through their
   * `EmulatorWorkerChunkedDisk` API backed by an `EmulatorChunkedFileSpec`
   * (read-side: chunked-disk.ts; consumer: worker.ts), and that API in
   * turn requires a fully-formed `EmulatorWorkerConfig` and a
   * `globalThis.workerApi` exposing the video/input/audio/files/clipboard
   * surfaces. Until we port that worker glue, the loader does not start
   * the emulator — see emulator-loader.ts and LEARNINGS.md
   * 2026-05-08 ("BasiliskII WASM init contract"). The disk is shipped
   * now so it's ready when the port lands.
   *
   * Reference: mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12
   *   src/emulator/worker/worker.ts            EmulatorWorkerApi.constructor
   *   src/emulator/worker/chunked-disk.ts      EmulatorWorkerChunkedDisk
   *   src/emulator/common/common.ts            EmulatorWorkerConfig type
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
  // The disk is shipped at this URL by CI but the loader will still drop
  // into STUB mode until the worker glue is ported (see the long comment
  // on `bootDiskUrl` above). The HEAD-check in the loader uses this URL
  // to verify the disk built and uploaded correctly even before the boot
  // path itself works.
  bootDiskUrl: `${BASE}system755-vibe.dsk`,
  appDiskUrl: `${BASE}app.dsk`,
  screen: { width: 640, height: 480 },
};
