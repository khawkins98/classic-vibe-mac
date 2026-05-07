# Web frontend

Vite + TypeScript shell that will host a stripped-down BasiliskII WASM core
(pulled from [Infinite Mac](https://github.com/mihaip/infinite-mac), Apache-2.0)
and mount our generated `app.dsk` as a secondary drive.

## Dev workflow

From the repo root:

```sh
npm install
npm run dev
```

That starts Vite on http://localhost:5173.

`npm run build` produces static output in `src/web/dist/`. CI is responsible
for copying the freshly-built `app.dsk` into `dist/` next to `index.html`
before publishing to GitHub Pages.

## Status

This iteration is the **scaffold only**. `index.html` renders a placeholder
and prints the planned emulator config. See `src/emulator-config.ts` for
the concrete next-step checklist (fetch BasiliskII core, port minimal worker
glue from Infinite Mac, set up cross-origin isolation for GitHub Pages).
