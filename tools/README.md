# tools/

Local debug + toolchain utilities. Not part of the production build;
not run in CI (except where noted).

## `tools/wasm-rez/`

Source for the in-browser Rez compiler — the wasm build of Retro68's
Rez, vendored from upstream + slightly trimmed (mini-Rez). Built
locally via `scripts/build-wasm-rez.sh`; the resulting
`wasm-rez.{js,wasm}` is committed under `src/web/public/wasm-rez/`
so production deploys don't need a wasm toolchain. See the README
in that directory for the build recipe.

The wasm-rez source is the canonical artefact — changes to
`MiniLexer.cc` / `Rez_main.cc` / the bundled retro68 sources should
round-trip through the build script and the resulting prebuilt blobs
get re-committed. The corresponding GitHub Actions step is currently
a no-op verification stub.

## `tools/m68k-runner/`

Native Musashi-based 68k boot tracer. The MVP that paid for itself
within an hour and became the backbone of cv-mac's toolchain testing
(see LEARNINGS.md Key Story #1). Loads a wasm-built MacBinary into a
Musashi CPU emulator with minimal Mac OS stubs, walks the
instruction trace + A-line trap dispatcher, and reports where the
binary actually dies — without the 15-30 minute deploy-and-eyes-on
cycle. See `tools/m68k-runner/README.md` for the build + usage
recipe.

## See also

The companion script suite under `scripts/` covers the local-dev
loops on top of these toolchain pieces:

- `scripts/audit-wasm-samples.mjs` — `.c` half of the local audit
- `scripts/audit-wasm-rez.mjs` — `.r` half
- `scripts/audit-wasm-e2e.mjs` — both halves, combined report
- `scripts/splice-bin.mjs` — offline reproducer of the browser's
  `spliceResourceFork` for inspecting what's in the final `.bin`
- `scripts/extract-resource-fork.mjs` — MacBinary resource-fork
  inspector (built for #284's Path B work)
- `scripts/build-wasm-rez.sh` — rebuilds `tools/wasm-rez/` and
  vendors the result into `src/web/public/wasm-rez/`

See [`docs/DEBUGGING-VENDORED-APPS.md`](../docs/DEBUGGING-VENDORED-APPS.md)
for the recipe that ties these tools together when a vendored Mac
app fails silently.
