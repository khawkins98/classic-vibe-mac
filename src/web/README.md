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

The landing page chrome is built — a System 7-flavored desktop with menu
bar, windowed Read Me, and a placeholder "Macintosh" window where the
emulator canvas will mount. The emulator core itself is not yet wired:
inside the platinum window you'll see a "TODO: BasiliskII goes here"
inset where the real `<canvas>` will go.

See `src/emulator-config.ts` for the concrete next-step checklist (fetch
BasiliskII core, port minimal worker glue from Infinite Mac, set up
cross-origin isolation for GitHub Pages). The DOM hook the integrator
will replace is `#emulator-canvas-mount` inside the `.inset` element in
`src/main.ts`.

## Files

- `index.html` — entry point, links to `src/style.css`.
- `src/main.ts` — renders the menu bar, the Read Me window, and the
  emulator window stub.
- `src/style.css` — System 7 chrome (platinum bevels, striped title bars,
  window styling). No CSS framework; period authenticity is by hand.
- `src/emulator-config.ts` — config object the future BasiliskII loader
  will consume.
