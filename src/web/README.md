# Web frontend

Vite + TypeScript shell that hosts a stripped-down BasiliskII WASM core
(from [Infinite Mac](https://github.com/mihaip/infinite-mac),
Apache-2.0), boots a System 7.5.5 disk with our two demo apps
preinstalled, and renders an in-page playground (read / edit / Build) for
the same C and Rez sources running above.

## Dev workflow

From the repo root:

```sh
npm install
npm run fetch:emulator   # one-time: pulls BasiliskII WASM into public/emulator/
npm run dev
```

That starts Vite on http://localhost:5173.

`npm run build` produces static output in `src/web/dist/`. CI runs
the cross-compile + boot-disk pipeline first, then this Vite build,
then copies the disk images and the precompiled `.code.bin` files
into `dist/` before publishing to GitHub Pages. See
`.github/workflows/build.yml`.

## Status

Production: System 7.5.5 boots in-page, Reader and MacWeather
auto-launch from `:System Folder:Startup Items:`, the playground panel
below the Mac lets visitors read and edit the apps' C and Rez sources,
and the Build button compiles edited resource forks via WASM-Rez and
downloads a complete MacBinary `.bin`. Hot-loading the build back into
the running Mac is Phase 3 (in flight).

## Files

- `index.html` — entry point, links to `src/style.css`.
- `src/main.ts` — renders the menu bar, the Read Me window, the
  "Macintosh" emulator window, the playground panel, and hands
  `#emulator-canvas-mount` to the loader.
- `src/style.css` — System 7 chrome plus loader UI (platinum bevels,
  striped title bars, beveled progress bar). No CSS framework; period
  authenticity is by hand.
- `src/settings.ts` — user-facing settings (e.g. pause-on-hidden) with
  localStorage persistence.
- `src/emulator-config.ts` — typed config object consumed by the loader.
- `src/emulator-loader.ts` — boot lifecycle: fetch core, render
  progress, allocate SharedArrayBuffers, spawn the worker.
- `src/emulator-worker.ts` — runs BasiliskII.js inside a Web Worker;
  owns the chunked-disk reader, prefs render, framebuffer blits.
- `src/emulator-worker-types.ts` — shared lock-state and message-shape
  constants between the UI thread and the worker.
- `src/emulator-input.ts` — pointer + keyboard capture; writes to the
  worker's shared input ring.
- `src/weather-poller.ts` — polls open-meteo on the host page and
  drops the response into the Mac via the extfs-mounted `:Unix:`
  volume so MacWeather can render live data.
- `src/playground/` — in-page editor + persistence + WASM-Rez build
  pipeline:
  - `editor.ts` — CodeMirror 6 wiring.
  - `persistence.ts` — IndexedDB seed + read/write of project files.
  - `error-markers.ts` — surfacing Rez diagnostics inside the editor.
  - `preprocessor.ts` — pure-TypeScript C preprocessor for `.r` files.
  - `vfs.ts` — virtual filesystem composing IDB project files with the
    bundled RIncludes headers.
  - `rez.ts` — WASM-Rez glue: invokes the Emscripten module on the
    preprocessed source.
  - `build.ts` — MacBinary header + CRC + resource-fork merge that
    splices the user's freshly-compiled fork onto the precompiled
    `.code.bin`.
  - `types.ts` — playground-side type declarations.
- `public/emulator/` — populated by `scripts/fetch-emulator.sh`.
  Binaries are gitignored; LICENSE + NOTICE travel with them.
- `public/wasm-rez/` — vendored prebuilt WASM-Rez (`wasm-rez.js`,
  `wasm-rez.wasm`) plus the multiversal `RIncludes/` headers.
- `public/sample-projects/` — copied at build time from `src/app/<project>/`
  by the `cvm-playground-seed` Vite plugin (see `vite.config.ts`).
- `public/precompiled/` — copied at build time from
  `build/<project>/<App>.code.bin` (CMake's Retro68 `add_application`
  output). Used as the splice target for the playground Build button.
