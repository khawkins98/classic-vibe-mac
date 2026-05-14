# tools/

Local debug utilities. Not part of the production build; not run in CI.

## `test-demo.sh` — automated prebuilt-demo boot tester

Drives one prebuilt demo button (`hello-toolbox`, `hello-bare`,
`hello-initgraf`) through the playground UI and captures:

- the `[prebuilt-demo]` console log (binary SHA + `Last-Modified` —
  the canonical version check),
- a viewport screenshot of the emulator after a configurable wait,
- a JSON summary of all browser console messages during the run.

Implements the spec in [issue #71](https://github.com/khawkins98/classic-vibe-mac/issues/71).
The tooling exists because the [boot-test bug hunt in #64](https://github.com/khawkins98/classic-vibe-mac/issues/64)
was bottlenecked on the manual click-and-screenshot step.

### Usage

```bash
# Against deployed Pages (default — quickest)
tools/test-demo.sh hello-bare

# Against local `vite preview` build
tools/test-demo.sh hello-toolbox --site=preview

# Longer wait if the cache is cold and BasiliskII boots slowly
tools/test-demo.sh hello-initgraf --boot-wait=60
```

### Output

Artefacts land under `tests/e2e/screenshots/`:

- `<demo-id>-<iso-timestamp>.png` — the captured viewport.
- `<demo-id>-<iso-timestamp>.json` — `{ demoId, sha256Prefix, durationMs,
  prebuiltDemoConsoleLine, consoleLogs[] }`.

### How to read the screenshot

- **Bomb icon + "Sorry, a system error occurred"** → system-level crash
  (CHK / type-1 / etc).
- **Hand-stop + "The application 'X' has unexpectedly quit"** →
  per-app crash caught by Process Manager.
- **Emulated desktop with the app icon visible** → loader succeeded;
  if no text was drawn, the app crashed silently OR exited cleanly.
- **Visible drawn text** → the app actually got to its `DrawString`.

### What's deliberately NOT here

- Automated pass/fail on the screenshot. Today this is purely an
  artefact-capture tool; the human (or AI agent) interpreting the
  image is the assert step. Once the boot test passes we can add
  pixel-diff or OCR for regression coverage.
- CI gating. The 30s+ runtime per demo, plus emulator boot variance,
  makes this unsuitable as a per-PR gate.
