# Development flow

How to actually iterate on `classic-vibe-mac` without losing a day to the
toolchain. This doc is the "what to type when" companion to the project's
other docs — see [Reference links](#reference-links) at the bottom for the
deeper material.

## The big picture

You write classic Mac C (plus an optional Rez `.r` resource file). A
WebAssembly build of the Retro68 toolchain (cc1 + as + ld + Elf2Mac,
plus wasm-rez for resources) compiles it **in the browser tab**, the
page patches the resulting MacBinary onto a small HFS floppy image,
and that floppy is hot-loaded into a WebAssembly Basilisk II running
System 7.5.5.

```text
  src/app/wasm-<name>/*.c, *.r
            |
            |  vite.config.ts auto-discovers + copies sources into
            |  public/sample-projects/ at dev/build time
            v
  +------------------------ browser tab -------------------------+
  |  playground editor (IndexedDB-backed working copy)           |
  |        |  Build & Run                                        |
  |        v                                                     |
  |  wasm-cc1 -> as -> ld -> Elf2Mac   (+ wasm-rez for the .r)   |
  |        |                                                     |
  |        v                                                     |
  |  MacBinary .bin -> patched into empty-secondary.dsk (HFS)    |
  |        |                                                     |
  |        v                                                     |
  |  Basilisk II (wasm) booted from system755-vibe.dsk,          |
  |  floppy mounted, app auto-launched                           |
  +--------------------------------------------------------------+
```

There is no host-side cross-compile any more. The CMake/Retro68
apps (Reader, MacWeather, HelloMac, PixelPad, MarkdownViewer) were
retired in #276, and every app the playground ships compiles
in-browser. `src/app/CMakeLists.txt` is kept as empty scaffolding.

There are **three** loops you'll move between, ordered from fastest
to slowest:

0. **In-browser (~1-2 s, no install).** Open the live page or
   `npm run dev`, edit `.c` or `.r` source in the playground panel,
   click Build & Run. The first click takes a few seconds longer
   (it lazy-loads the brotli toolchain bundle and boots the Mac);
   warm rebuilds are ~1-1.5 s. This is the loop for almost every
   sample change. See
   [LEARNINGS Key Story #6](../LEARNINGS.md#6-closed-as-infeasible-epics-describe-a-path-not-the-universal-answer--survey-alternative-paths-before-locking-the-closure-rationale-in-as-wisdom)
   for how it came about.
1. **Node-side audits and unit tests (seconds).**
   `npm run audit:wasm-e2e -- <sample>` compiles a sample's `.c` and
   `.r` headless through the same vendored toolchain;
   `npm run test:unit` runs the JS pipeline unit tests (HFS patcher,
   preprocessor, resource-fork merger, wasm-rez stack). No browser.
2. **Ship via CI (~5-10 min).** Push, open a PR, let CI go green,
   squash-merge; the deploy lands on Pages.

## First-time setup

The [README's "Try it" section](../README.md#try-it) is the
authoritative version of this. Quick pass:

```sh
brew install hfsutils                    # macOS; on Debian: apt-get install hfsutils
git clone https://github.com/<your-fork>/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run fetch:emulator                   # vendors BasiliskII.wasm + Quadra-650.rom
npx playwright install chromium          # only needed for E2E + visual tests
```

CI uses Node 20; any current LTS works locally.

To boot the Mac locally you also need the chunked System 7.5.5 boot
disk under `src/web/public/` (gitignored). Build it once:

```sh
NO_STARTUP_ITEMS=1 bash scripts/build-boot-disk.sh "" \
  src/web/public/system755-vibe.dsk
```

The first argument is the (now empty) list of MacBinaries to
pre-install. The script downloads the System 7.5.5 image once into
`.cache/boot-disk/` (~24 MB), verifies its SHA-256, and writes
`system755-vibe.dsk` plus the `system755-vibe.dsk.json` manifest and
the `system755-vibe-chunks/` directory the wasm disk reader consumes.
Re-running it takes a couple of seconds. Alternatively, download the
`Build` workflow's `classic-vibe-mac-<sha>` artifact from any green
CI run and copy its `dist/system755-vibe*` files into
`src/web/public/`.

Without the boot disk the page still loads: the loader HEAD-checks
the manifest and falls into a stub state that renders the IDE chrome
but no emulator. That's fine for iterating on the page itself. There
is no `app.dsk` any more. The loader stopped looking for it when the
precompiled apps were retired (#276); Build & Run patches the
committed `src/web/public/playground/empty-secondary.dsk` template
instead.

```sh
npm run dev                              # http://localhost:5173
```

## Loop 0 — edit a sample in the browser

Pick a sample (welcome gallery, the Project pane dropdown, or
**File → Open Project…** / ⌘O), edit, **Build & Run**. Your edits
live in IndexedDB; the files under `src/app/wasm-<name>/` are only
the *seed*. If you edit a sample's source on disk while the dev
server is running, hard-reload the tab and use the toolbar's
**Reset** to discard the browser copy and re-seed from disk.

[`HANDBOOK.md`](./HANDBOOK.md) documents every button, menu and
shortcut.

## Loop 1 — audits and unit tests

```sh
npm run audit:wasm-e2e -- wasm-mdpad   # one sample, .c + .r, a few seconds
npm run audit:wasm-e2e                  # every sample
npm run test:unit                       # JS pipeline unit tests
```

`test:unit` also runs `make -C tests/unit run` for host-compiled C
tests. That list is currently empty (the pure-C engines it covered
belonged to the retired CMake apps), but the harness is kept: if you
split a sample into a Toolbox shell plus a pure-C engine, host tests
for the engine go there — see
[`src/app/README.md`](../src/app/README.md#architectural-pattern-toolbox-shell--pure-c-engine).

## Loop 2 — ship via CI

```sh
git checkout -b my-change
# ... edits ...
git push -u origin my-change
gh pr create --fill                     # PR title in Conventional Commits form
```

Two workflows run on every PR:

- **`tests`** (`.github/workflows/test.yml`) — unit tests, the
  wasm-shelf compile audit (`scripts/audit-wasm-samples.mjs`),
  Playwright e2e, and the vision-LLM tests (skipped on fork PRs and
  when `ANTHROPIC_API_KEY` isn't set).
- **`Build`** (`.github/workflows/build.yml`) — builds the vanilla
  boot disk in the Retro68 container (the CMake configure/build step
  there is now a no-op), builds the Vite frontend, and on pushes to
  `main` deploys to GitHub Pages. The deploy job is gated on
  `github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`.

A third, **`lint-markdown`**, link-checks every `*.md` file with
lychee, so a broken relative link fails the PR.

Branching, commit, and merge conventions live in
[`CONTRIBUTING.md`](../CONTRIBUTING.md): Conventional Commits PR
titles, squash-merge always.

## Common-task recipes

### Smoke-test a sample change before pushing

The combined `.c` + `.r` audit runs both halves of the in-browser
build locally — what you want before opening a PR that touches any
`wasm-*` sample:

```sh
npm run audit:wasm-e2e -- wasm-mdpad   # one sample
npm run audit:wasm-e2e                  # every sample
```

If a sample fails on the `.r` side, re-run that half alone for full
diagnostics: `node scripts/audit-wasm-rez.mjs <sample>`. Same for
the `.c` side via `node scripts/audit-wasm-samples.mjs <sample>`.
For deeper "did the splice produce the expected resource fork?"
work see [`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md).

### Add a new sample to the shelf

A sample needs a source directory plus two registrations. Skip
`SAMPLE_PROJECTS` and it doesn't appear; skip `PICKER_ENTRIES` and the
picker shows a generic blurb (the label and file list).

1. **Source.** Create `src/app/wasm-<name>/<name>.c` (plus an
   optional `<name>.r`, and any extra `.c`/`.h` files). Start by
   copying the closest existing sample. Seeding is automatic:
   [`src/web/vite.config.ts`](../src/web/vite.config.ts) copies every
   `.c`, `.h`, `.r` and `.rsrc.bin` file in each `src/app/wasm-*/`
   directory into `public/sample-projects/wasm-<name>/` at dev/build
   time. Other files (READMEs, licences) are skipped; to skip a
   matching file, add it to `SEED_EXCLUDES` in the same file.
2. **`SAMPLE_PROJECTS`** in
   [`src/web/src/playground/types.ts`](../src/web/src/playground/types.ts)
   — `id` (`wasm-<name>`), `label`, `files`, `rezFile` (your `.r`, or
   `null`), `outputName`, `appType`/`appCreator` (a 4-char creator
   code), `complexity` (1-6 stars), and optionally `tryNext` prompts
   for the post-build "Try this next" cards.
3. **`PICKER_ENTRIES`** in
   [`src/web/src/projectPicker.ts`](../src/web/src/projectPicker.ts)
   — emoji + one-line description for the Open Project picker.

Then verify:

```sh
npm run audit:wasm-e2e -- wasm-<name>   # headless compile of .c + .r
npm run dev                              # pick it, Build & Run
```

The CI wasm-shelf audit picks up every `src/app/wasm-*` directory
automatically. Add a row to the sample table in
[`src/app/README.md`](../src/app/README.md). If the sample is a port
of a third-party period app, follow
[`VENDORING-A-MAC-APP.md`](./VENDORING-A-MAC-APP.md) instead; it
covers licensing, precompiled resource forks, and the extra
`precompiledForkAssets` wiring.

### Debug a runtime crash inside the Mac

The Mac doesn't give you a stack trace. The classic bomb dialog tells
you a category ("unimplemented trap", "address error", "bus error") and
nothing else. The pattern that worked for us is **bisection by deletion**:

1. Reduce your sample's main `.c` to the smallest possible
   Toolbox app that still crashes. `InitGraf` / `InitFonts` / `InitWindows`
   / `InitMenus` / `TEInit` / `InitDialogs` / `InitCursor` /
   `MoreMasters() x4` / `WaitNextEvent` loop. If that bombs, the bug is
   not in your code.
2. Strip the `.r` file similarly. Drop everything but `vers` and `SIZE`.
   If it still bombs, the bug is not in the resource fork.
3. At this point the bug is somewhere upstream — Retro68 runtime,
   ROM/trap-table mismatch, SIZE flag combination, MacBinary
   Type/Creator handling, or BasiliskII config.

The full worked-example saga is
[`LEARNINGS.md`](../LEARNINGS.md) — five or so consecutive 2026-05-08
entries — culminating in the `modelid` fix
(`gestaltID − 6`, not gestaltID itself). Read those entries before
starting your own bisection; the first three rounds were chasing a
wrong-gestalt artifact, and the lesson ("when porting an emulator config,
copy the formula, not the constant") generalises.

For silent failures (no bomb, just nothing happening), instrument
with `cvm_log()` and watch the Output pane's **Console** tab; the
recipes are in [`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md).

The other tool worth knowing about is the visual test layer
([`tests/README.md`](../tests/README.md#layer-3-vision-assertions-claude-api)),
which lets you ask a vision model "is the bomb dialog visible?" or "is
my app's window showing?" against a screenshot. Useful
when you're iterating on something that's hard to scrape from the canvas.

### Iterate on the page chrome

`src/web/src/` — Vite + TypeScript, HMR, normal frontend dev:

```sh
npm run dev
# edit src/web/src/main.ts, src/web/src/style.css, etc.
# saved files reload immediately
```

For E2E smoke tests against the dev server:

```sh
npm run test:e2e          # Playwright, chromium-only
```

Vision assertions on actual emulator screenshots
(`tests/visual/vision-assert.ts`) require an
`ANTHROPIC_API_KEY` env var; without it the vision tests auto-skip (no CI
failure). See [`tests/README.md`](../tests/README.md) for the cost notes.

## Common failure modes mapped to fixes

> **Quick reference:** see [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
> for the searchable symptom → cause → fix table. Detailed walkthroughs
> are below and duplicated there.

### "Page shows the chrome but no canvas / console errors about SharedArrayBuffer"

You're not in a cross-origin-isolated context. Two cases:

- **Local dev.** Vite sets COOP/COEP for you (see
  `src/web/vite.config.ts`). If you're seeing the error, you may have
  opened a non-Vite preview (e.g. a static `dist/` server). Switch back
  to `npm run dev`.
- **Production (GitHub Pages).** GH Pages can't set custom headers, so
  we ship a `coi-serviceworker.min.js` that re-fetches the page and
  injects the COOP/COEP headers on the way back. **The first load is
  expected to be in the wrong state and reload itself once.** A
  forced reload (Cmd-Shift-R) on the second visit confirms COI is
  installed. See `LEARNINGS.md` (2026-05-08, GH Pages COOP/COEP).

### "BasiliskII bombs at launch with 'unimplemented trap'"

Three things to check, in order:

1. **`modelid`.** It must be `gestaltID − 6`, i.e. `30` for Quadra 650.
   The constant lives in `src/web/src/emulator-worker.ts`. The wrong
   value makes Gestalt report a bogus machine type, System 7.5.5 skips a
   chunk of its trap-patch ladder, and bootstrap calls land in the
   "unimplemented trap" handler. Full story in `LEARNINGS.md`.
2. **The resource fork made it.** If your sample has a `.r`, run
   `node scripts/audit-wasm-rez.mjs <sample>` and check it compiles;
   a missing or truncated fork (no `CODE`, no `SIZE`) bombs at launch.
   `DEBUGGING-VENDORED-APPS.md` has the offline splice repro.
3. **Inspecting a disk by hand.** For any HFS image (the boot disk,
   or a floppy you saved out), hfsutils lists files with their forks:
   ```sh
   hmount src/web/public/system755-vibe.dsk
   hls -l ":System Folder:"
   humount
   ```
   `hls -l` columns are `<flag>  <TYPE>/<CREATOR>  <rsrc>  <data>  <date>  <name>`
   — `rsrc data`, not `data rsrc`; `LEARNINGS.md` covers the day we
   got that backwards.

### "My on-disk sample edits don't show up"

Almost always one of:

- The browser is still using its IndexedDB copy of the project. Your
  edits in `src/app/wasm-<name>/` are only the seed; click **Reset**
  in the Playground toolbar to discard the browser copy and re-seed.
- You added or renamed a file but didn't update `files` in the
  project's `SAMPLE_PROJECTS` entry (`src/web/src/playground/types.ts`),
  or the file's extension isn't one the seeder picks up (`.c`, `.h`,
  `.r`, `.rsrc.bin`; see `SEED_FILE_PATTERN` in
  `src/web/vite.config.ts`).
- The browser cached the chunked manifest aggressively. Open devtools,
  check the network tab for 304s on `system755-vibe.dsk.json` and the
  chunks under `system755-vibe-chunks/`. Disable cache (devtools →
  Network → "Disable cache" while open) for development sessions.

### "`Controls.h` not found" (or another Retro68 header)

Retro68's universal interfaces don't ship every header. The fix is
usually one of:

- The header is genuinely not in Retro68's tree — find the trap or
  type definition you actually need and pull it from a different
  header (`Windows.h`, `Quickdraw.h`, `MacTypes.h`).
- The header is included indirectly via another umbrella — check what
  the Retro68 sample apps include.

If you discover a Retro68 quirk worth remembering, add it to
[`LEARNINGS.md`](../LEARNINGS.md) — the "hfsutils-vs-hfsprogs",
"`hls -l` columns", and "`modelid = gestaltID − 6`" entries are the kind
of thing this file exists to capture.

### "`hls` says no such file or directory"

`hfsutils` paths are Mac-style. The volume root is `:` or the empty
string, not `/`. `hls /` resolves to nothing. Use `hls` (no arg, or `:`)
for the root, `hls ":System Folder:"` for a subdirectory. See
`LEARNINGS.md` (2026-05-08).

## Reference links

- [`README.md`](../README.md) — what the project is, how to run the
  deployed page, how to use the template.
- [`src/app/README.md`](../src/app/README.md) — what runs inside the
  emulated Mac, the Toolbox-shell + pure-C-engine pattern, replacement
  guide.
- [`tests/README.md`](../tests/README.md) — three-layer testing strategy
  (unit / E2E / vision) and what each layer is for.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — Conventional Commits, branch
  naming, squash-merge policy.
- [`LEARNINGS.md`](../LEARNINGS.md) — running log of gotchas. Worth
  skimming once; very worth searching when something behaves oddly.
- [`docs/archive/PRD.md`](./archive/PRD.md) — the original product
  plan and risks register (archived; historical only).
- [`docs/NETWORKING.md`](./NETWORKING.md) — deploying the optional
  Cloudflare DO Ethernet relay for `?zone=` networking.
- [`docs/HANDBOOK.md`](./HANDBOOK.md) — end-user manual for the
  playground: every button, every shortcut (⌘P, Routines popup,
  Build & Run, Debug Console), where files live, how to fork a
  sample as your own project. Start here if you don't know what
  something *does*.
- [`docs/VENDORING-A-MAC-APP.md`](./VENDORING-A-MAC-APP.md) — recipe
  for adding a third-party period Mac app to the sample shelf so it
  builds + runs in the playground end-to-end.
- [`docs/DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md) —
  for when a vendored app fails silently (`cvm_log` instrumentation,
  `ResError` + `FreeMem` capture, offline splice repro via
  `scripts/splice-bin.mjs`).
