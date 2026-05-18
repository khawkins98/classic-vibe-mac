# Web frontend

Vite + TypeScript shell that hosts a stripped-down BasiliskII WASM core
(from [Infinite Mac](https://github.com/mihaip/infinite-mac),
Apache-2.0), boots a System 7.5.5 disk on demand, and renders the
in-page IDE: project picker, CodeMirror editor, build pipeline, Mac
canvas, Output panel.

## Dev workflow

From the repo root:

```sh
npm install
npm run fetch:emulator   # one-time: pulls BasiliskII WASM into public/emulator/
npm run dev
```

That starts Vite on http://localhost:5173.

`npm run build` produces static output in `src/web/dist/`. CI runs
this Vite build and publishes to GitHub Pages — there's no longer a
cross-compile loop in CI (samples compile in-browser via wasm-cc1 +
wasm-rez, not via Retro68 at build time; the precompiled-app path
was retired in #276). See `.github/workflows/build.yml`.

For pre-push smoke-testing a sample change, run the combined audit:
`npm run audit:wasm-e2e -- <sample>` (or no arg for all 26).

## Status

Production: the IDE renders on first paint with the Mac canvas in a
"Welcome to Macintosh" placeholder state (deferred-boot UX, #279).
Picking a sample + clicking Build & Run compiles its C through
in-browser `cc1` → `as` → `ld` → `Elf2Mac`, compiles its `.r`
through WASM-Rez, splices the two into a MacBinary, mounts it on a
fresh secondary disk, and boots System 7.5.5 with the app's disk on
the desktop. Subsequent Build & Runs reuse the cached toolchain +
warm boot disk and finish in ~1 second. Per-project file persistence
+ edits in IndexedDB; first-run welcome modal greets new visitors
(#307); Apple → "Welcome to classic-vibe-mac…" re-opens it on demand.

## Files

- `index.html` — entry point, links to `src/style.css`.
- `src/main.ts` — boot orchestration: mounts the menubar, the four
  docked IDE panes (Project / Playground / Macintosh / Output), wires
  the palettes (About, Help, Preferences, Welcome, Toolbox Reference),
  hands `#emulator-canvas-mount` to the loader.
- `src/style.css` — Mac OS 8 platinum chrome (palettes, panes,
  buttons, scrollbars, sample cards). No CSS framework; period
  authenticity is by hand.
- `src/aboutPalette.ts` / `src/helpPalette.ts` /
  `src/preferencesPalette.ts` / `src/welcomePalette.ts` — singleton
  WinBox palettes triggered from the menubar.
- `src/projectPicker.ts` — richer-than-the-dropdown project chooser
  ("File → Open Project…").
- `src/zipImport.ts` — `?import=` URL flow + drag-and-drop zip import.
- `src/menubarMenus.ts` — top menubar (Apple / File / Edit / View /
  Special / Windows / Help) wiring.
- `src/idePanes.ts` — the four docked WinBox panes; reset-layout
  affordance.
- `src/settings.ts` — user-facing settings (pause-on-hidden etc) with
  localStorage persistence.
- `src/winboxChrome.ts` — Mac OS 8 chrome enhancements for WinBox
  (shade-to-titlebar, paper title field).
- `src/emulator-config.ts` — typed config object consumed by the
  loader.
- `src/emulator-loader.ts` — boot lifecycle: fetch core, render
  progress, allocate SharedArrayBuffers, spawn the worker.
- `src/emulator-worker.ts` — runs BasiliskII.js inside a Web Worker;
  owns the chunked-disk reader, prefs render, framebuffer blits.
- `src/emulator-worker-types.ts` — shared lock-state and message-shape
  constants between the UI thread and the worker.
- `src/emulator-input.ts` — pointer + keyboard capture; writes to the
  worker's shared input ring.
- `src/console-watcher.ts` / `src/pollingWatcher.ts` /
  `src/shared-poller.ts` — polled extfs-file watchers that surface
  Mac-side `cvm_log()` output in the Output panel's Console tab.
- `src/ethernet.ts` / `src/ethernet-provider.ts` — opt-in AppleTalk
  zone networking via the `?zone=` URL flow.
- `src/playground/` — in-page editor + persistence + build pipeline:
  - `editor.ts` — CodeMirror 6 wiring, project / file / tab management.
  - `persistence.ts` — IndexedDB seed + per-project file overrides.
  - `cc1.ts` / `rez.ts` / `compilePipeline.mjs` — in-browser toolchain
    wrappers (cc1 → as → ld → Elf2Mac for C, wasm-rez for `.r`).
  - `build.ts` — MacBinary header + CRC + resource-fork splice that
    combines the cc1-produced `.code.bin` (CODE / DATA / RELA from
    Elf2Mac) with the wasm-rez output (the user's MENU / WIND / PICT
    / `snd ` etc).
  - `resourceForkMerger.mjs` — pure-JS resource-fork merger reused
    by `precompiledForkAssets` and `scripts/splice-bin.mjs`.
  - `preprocessor.ts` — pure-TypeScript C preprocessor for `.r` files.
  - `vfs.ts` — virtual filesystem composing IDB project files with the
    bundled RIncludes headers.
  - `buildProgressWindow.ts` — Mac OS 8-style progress modal during
    Build & Run, with per-phase timing.
  - `error-markers.ts` — surfacing Rez diagnostics inside the editor.
  - `toolchain.ts` / `compileArgs.mjs` — shared compile flags.
  - `toolbox-reference-window.ts` / `build-explainer.ts` — pinned
    reference + Build log explainer palettes.
  - `lang-m68k.ts` — CodeMirror language mode for the Show ASM panel.
  - `types.ts` — playground-side type declarations + `SAMPLE_PROJECTS`.
- `public/emulator/` — populated by `scripts/fetch-emulator.sh`.
  Binaries are gitignored; LICENSE + NOTICE travel with them.
- `public/wasm-cc1/` — vendored prebuilt wasm-cc1 + wasm-as + wasm-ld
  + wasm-Elf2Mac (`cc1.{js,wasm}`, `as.{js,wasm}`, `ld.{js,wasm}`,
  `Elf2Mac.{js,wasm}`) plus the sysroot blobs.
- `public/wasm-rez/` — vendored prebuilt WASM-Rez (`wasm-rez.{js,wasm}`)
  plus the multiversal `RIncludes/` headers.
- `public/sample-projects/` — copied at build time from
  `src/app/<project>/` by the `cvm-playground-seed` Vite plugin
  (see `vite.config.ts`).
