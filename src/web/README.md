# Web frontend

Vite + TypeScript shell that will host a stripped-down BasiliskII WASM core
(pulled from [Infinite Mac](https://github.com/mihaip/infinite-mac), Apache-2.0)
and mount our generated `app.dsk` as a secondary drive.

## Dev workflow

From the repo root:

```sh
npm install
npm run fetch:emulator   # one-time: pulls BasiliskII WASM into public/emulator/
npm run dev
```

That starts Vite on http://localhost:5173.

`npm run build` produces static output in `src/web/dist/`. CI runs
`fetch:emulator` before `build`, then copies the freshly-built `app.dsk`
into `dist/` next to `index.html` before publishing to GitHub Pages.

## Status

The landing page chrome is built and the emulator loader is wired
end-to-end through the WASM fetch step. Open the page and you'll see:

1. Real progress UI inside the platinum "Macintosh" window as
   `BasiliskII.js` and `BasiliskII.wasm` stream in.
2. A "Welcome to Macintosh" stub message once the binaries are loaded —
   the actual boot is **stubbed** until the System 7.5.5 boot disk
   plumbing is unblocked. See `LEARNINGS.md` (2026-05-08, "Boot disk
   plumbing") for the blocker and the recommended unblock path.

The DOM integration point remains `#emulator-canvas-mount` inside the
`.inset` element in `src/main.ts`; the loader (`src/emulator-loader.ts`)
owns rendering inside that node from page load onward.

## Files

- `index.html` — entry point, links to `src/style.css`.
- `src/main.ts` — renders the menu bar, the Read Me window, the
  "Macintosh" emulator window, and hands `#emulator-canvas-mount` to the
  loader.
- `src/style.css` — System 7 chrome plus loader UI (platinum bevels,
  striped title bars, beveled progress bar). No CSS framework; period
  authenticity is by hand.
- `src/emulator-config.ts` — typed config object consumed by the loader.
- `src/emulator-loader.ts` — boot lifecycle: fetch core, render progress,
  mount canvas (or fall back to stub state).
- `src/emulator-input.ts` — pointer + keyboard event capture scaffold,
  ready to wire to the BasiliskII shared input buffer once the worker
  is running.
- `public/emulator/` — populated by `scripts/fetch-emulator.sh`.
  Binaries are gitignored; LICENSE + NOTICE travel with them.
