# Tests

Two layers of testing for `classic-vibe-mac`. Each layer answers a
different question and runs independently.

| Layer | Lives in | Run with | What it tests |
|-------|----------|----------|---------------|
| Unit (host C) | `tests/unit/` | `npm run test:unit` | Pure-C game logic, host-compiled |
| E2E (Playwright) | `tests/e2e/` | `npm run test:e2e` | Web frontend in a real browser |

`npm test` runs both in order.

---

## Why two layers?

The app runs inside an emulated 68k Mac (BasiliskII WASM) which renders to a
`<canvas>`. Once the emulator boots, normal DOM-based tools can't see what's
inside the canvas — there's no React tree, no accessibility tree, just pixels.

Each layer is the right tool for a different scope:

- **Unit:** any pure-C function (no Mac Toolbox calls) is fastest tested by
  compiling with the host `gcc`/`clang` and asserting directly. No emulator,
  no browser, no network. Sub-second feedback.
- **E2E:** the web shell that hosts the emulator (page loads, COOP/COEP
  headers, WASM bootstraps, the canvas mounts) is testable with Playwright
  the normal way.

Neither layer reads pixels inside the running emulator. What an app draws
is checked by hand in the browser; pixel-diff snapshots are deliberately
avoided because emulator timing variance (cursor blink, boot animation,
scheduler jitter) flakes them. (An LLM-vision layer, `tests/visual/`,
existed until #364; it was removed because CI never had an API key, so
it only ever reported skipped.)

---

## Layer 1: Unit tests (host-compiled C)

**Convention:** any function in `src/app/` that does NOT call Mac Toolbox
APIs (QuickDraw, Window Manager, Events, etc.) is testable here.

When real app logic lands, factor pure C into something like
`src/app/html_parse.{c,h}` and `#include` it from `tests/unit/test_*.c`.
The `Makefile` already wires `-I../../src/app`.

```bash
npm run test:unit            # runs make -C tests/unit run
make -C tests/unit clean     # clean up binaries
```

The host C suite (`tests/unit/Makefile` + `tests/unit/*.c`) is small.
Today it covers `wasm-arkanoid/engine.c` (`test_arkanoid_engine.c`):
paddle/brick bounce directions plus a "perfect paddle never loses a
life" simulation. Mac headers a pure-logic file includes for types
(`<Types.h>`, `<Quickdraw.h>`, `<Events.h>`) are stubbed in
`tests/unit/stubs/`; add to those stubs rather than pulling in real
Toolbox code. (It used to carry `html_parse.c` + `weather_parse.c`
for the Reader and MacWeather apps; both retired in #276.)

The Node-side suite (`npm run test:unit:js`) is where most of the
real coverage lives now:

- `tests/unit/preprocessor.test.mjs` — the playground's TS
  preprocessor for `.r` files (#83 territory)
- `tests/unit/hfs-patcher.test.mjs` — HFS catalog patcher round-trip
  against hfsutils ground truth
- `tests/unit/resource-fork-merger.test.mjs` — pure-JS resource-fork
  merger (#285)
- `tests/unit/wasm-rez-stack.test.mjs` — regression guard for the
  wasm-rez parser-stack overflow fixed in #287; compiles the vendored
  Glypha `.r` every PR
- `tests/unit/shared-poller.test.mjs` — polled-file watcher (the
  `cvm_log` Console-tab plumbing)

`npm run test:unit` runs both the C and JS suites. For end-to-end
checks on a wasm-* sample's build, use the combined audit:
`npm run audit:wasm-e2e -- <sample>` (or no arg for all 26).

**Requires:** a host C compiler (`cc` / `gcc` / `clang`). Standard on macOS
and Ubuntu CI runners. No Retro68 needed.

---

## Layer 2: E2E (Playwright)

```bash
npm run test:e2e
```

Boots `npm run dev` (Vite on `:5173`), runs Playwright against it in
chromium. Config in `playwright.config.ts` at the repo root.

Today the only test asserts the placeholder page renders and captures a
screenshot. As the emulator integration lands, this should grow to:

- wait for the BasiliskII canvas to mount
- wait for SharedArrayBuffer / COOP+COEP to be in place
- exercise basic keyboard/mouse routing into the canvas

What's *inside* the canvas is out of scope for this layer — keep app
logic in pure-C engines so Layer 1 can cover it.

**Chromium only on purpose.** The emulator needs `SharedArrayBuffer`
(cross-origin isolation) and behaves most consistently in chromium. Cross-
browser parity is not a POC concern.

**Requires:** `npm install` to pull `@playwright/test`, and
`npx playwright install chromium` once for the browser binary.

---

## CI

`.github/workflows/test.yml` runs unit + e2e on every PR.

## Output

- `test-results/` — Playwright traces, screenshots from failed runs
- `playwright-report/` — HTML reports (open with `npx playwright show-report`)

Both are gitignored.
