# Tests

Three layers of testing for `classic-vibe-mac`. Each layer answers a
different question and runs independently.

| Layer | Lives in | Run with | What it tests |
|-------|----------|----------|---------------|
| Unit (host C) | `tests/unit/` | `npm run test:unit` | Pure-C game logic, host-compiled |
| E2E (Playwright) | `tests/e2e/` | `npm run test:e2e` | Web frontend in a real browser |
| Vision (Claude) | `tests/visual/` | `npm run test:visual` | Semantic checks on emulator screenshots |

`npm test` runs all three in order.

---

## Why three layers?

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
- **Vision:** "is the app actually running and showing the right thing?"
  needs to read pixels from the canvas. We send screenshots to a vision LLM
  and ask in natural language. Pixel-diff snapshots are the obvious wrong
  answer here — emulator timing variance flakes them.

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

Today the unit suite covers `html_parse.c` (the pure-C HTML tokenizer
+ layout used by Reader) and `weather_parse.c` (the open-meteo JSON
parser used by MacWeather). The Toolbox-shell sources `reader.c` /
`macweather.c` are NOT host-compilable. There's also a Node-side
unit test for the playground's TypeScript preprocessor at
`tests/unit/preprocessor.test.mjs` (`npm run test:unit:js`); the
`test:unit` script runs both the C tests and the JS test.

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

For anything that needs to verify what's *inside* the canvas, escalate to
Layer 3.

**Chromium only on purpose.** The emulator needs `SharedArrayBuffer`
(cross-origin isolation) and behaves most consistently in chromium. Cross-
browser parity is not a POC concern.

**Requires:** `npm install` to pull `@playwright/test`, and
`npx playwright install chromium` once for the browser binary.

---

## Layer 3: Vision assertions (Claude API)

```bash
ANTHROPIC_API_KEY=sk-... npm run test:visual
```

The novel layer. `tests/visual/vision-assert.ts` exposes a single helper:

```ts
import { visionAssert } from "./vision-assert";

const result = await visionAssert(
  "test-results/boot.png",
  "a System 7 desktop is visible with a window titled 'Reader'",
);
expect(result.pass, result.reasoning).toBe(true);
```

It sends the screenshot + the natural-language assertion to
`claude-haiku-4-5-20251001` (chosen for speed/cost) and parses a strict JSON
verdict out of the response.

**Why not pixel-diff?** The emulator's frame timing varies run-to-run (cursor
blink, boot animation, scheduler jitter). Pixel-diff baselines flake.
Semantic vision checks are robust to those — they ask "does this look right
to a human?" instead of "are these bytes identical?".

**Auto-skip when no key is set.** Tests use
`test.skip(!hasVisionApiKey(), ...)`, so CI runs without the key won't fail —
they just report skipped. Set `ANTHROPIC_API_KEY` in repo secrets to enable.

**Cost note.** Haiku is cheap (~fractions of a cent per assertion) but it's
not free. Don't put the vision layer on a per-commit watch loop — run it on
PRs and on demand.

**Requires:** `@anthropic-ai/sdk` (declared in root `package.json`) and an
`ANTHROPIC_API_KEY` env var.

---

## CI

`.github/workflows/test.yml` runs unit + e2e on every PR. Vision is gated on
`secrets.ANTHROPIC_API_KEY` being present in the repo.

## Output

- `test-results/` — Playwright traces, screenshots from failed runs
- `playwright-report/` — HTML reports (open with `npx playwright show-report`)
- `test-results-visual/` — vision-layer outputs (model reasoning attachments)

All three are gitignored.
