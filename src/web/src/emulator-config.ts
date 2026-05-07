/**
 * Emulator configuration — what the (not-yet-wired) BasiliskII loader will use.
 *
 * Why this lives in its own file: the actual loader implementation will be
 * imported lazily once we've pulled in the Infinite Mac worker code, but the
 * config shape is stable and lets the build pipeline + CI reason about which
 * files need to be present in `dist/`.
 *
 * Next steps to make this real:
 *   1. Add a build script (e.g. scripts/fetch-emulator-core.sh) that pulls
 *      `BasiliskII.wasm` and `BasiliskII.js` from
 *      raw.githubusercontent.com/mihaip/infinite-mac/main/src/emulator/worker/emscripten/
 *      into `src/web/public/emulator/` (so Vite serves them as static assets).
 *      Pin a commit SHA, not `main`, once we know the version we want.
 *   2. Port the minimal slice of Infinite Mac's `emulator-ui.ts` /
 *      `emulator-worker.ts` we need to drive BasiliskII. Strip CD-ROM,
 *      library browser, etc. Keep the Apache-2.0 LICENSE + NOTICE.
 *   3. Wire SharedArrayBuffer / cross-origin isolation for GitHub Pages —
 *      Pages can't set headers, so we'll need a coi-serviceworker shim.
 *   4. Replace the placeholder render in `main.ts` with the real <canvas>
 *      mount and the worker bootstrap.
 */
export interface EmulatorConfig {
  /** Where the BasiliskII core lives once fetched/copied into dist/. */
  emulatorCoreUrl: string;
  emulatorJsUrl: string;
  /** System 7.5.5 boot disk — served from Infinite Mac's existing infra. */
  bootDiskUrl: string;
  /** Our custom app disk produced by scripts/build-disk-image.sh. */
  appDiskUrl: string;
}

export const emulatorConfig: EmulatorConfig = {
  emulatorCoreUrl: "./emulator/BasiliskII.wasm",
  emulatorJsUrl: "./emulator/BasiliskII.js",
  // TODO: confirm the exact public URL Infinite Mac serves the System 7.5.5
  // chunked disk manifest from. If CORS blocks GitHub Pages -> infinitemac.org
  // requests, fall back to bundling a freely-redistributable System 7 image
  // ourselves (per PRD risk table).
  bootDiskUrl: "https://infinitemac.org/disks/system-7.5.5.json",
  appDiskUrl: "./app.dsk",
};
