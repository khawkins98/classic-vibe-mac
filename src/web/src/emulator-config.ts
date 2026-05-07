/**
 * Emulator configuration — typed shape consumed by emulator-loader.ts.
 *
 * Files referenced here are placed by `scripts/fetch-emulator.sh` (binaries)
 * and by the build pipeline (app.dsk, copied from `dist/app.dsk` next to
 * `index.html` post-`vite build`). Everything is served as static GH Pages
 * assets at the Vite `base` path.
 *
 * The boot disk is the messy one. See the long comment on `bootDiskUrl`.
 */
export interface EmulatorConfig {
  /** BasiliskII Emscripten loader (.js). Sibling-loads the .wasm. */
  coreUrl: string;
  /** BasiliskII WebAssembly module. */
  wasmUrl: string;
  /**
   * Boot disk for System 7.5.5.
   *
   * Open question / blocker (see LEARNINGS.md 2026-05-08):
   * Infinite Mac does NOT serve a single-file System 7.5.5 disk. Their
   * worker.ts loads a *chunked* disk via a JSON manifest at build time
   * (e.g. `@/Data/System 7.5.5 HD.dsk.json`), with the binary chunks
   * served from a private Cloudflare R2 bucket bound to system7.app etc.
   * That manifest is build-generated and not committed; the chunk URLs
   * have no documented public schema.
   *
   * Until we either (a) host our own chunked manifest+blobs, or (b)
   * negotiate / replicate a public URL pattern with mihaip, this URL
   * will resolve to nothing and the loader will fall back to its
   * "stub" mode (loader UI shows but emulator does not boot). The
   * mount point preserved here is what we'd point at once unblocked.
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
  // Intentionally null until the chunked-disk plumbing is figured out.
  // emulator-loader.ts treats `null` as "skip boot, render stub overlay".
  bootDiskUrl: null,
  appDiskUrl: `${BASE}app.dsk`,
  screen: { width: 640, height: 480 },
};
