# Development flow

How to actually iterate on `classic-vibe-mac` without losing a day to the
toolchain. This doc is the "what to type when" companion to the project's
other docs — see [Reference links](#reference-links) at the bottom for the
deeper material.

## The big picture

You write classic Mac C, a cross-compiler turns it into a 68k Mac binary,
that binary gets injected into the boot disk's `:System Folder:Startup
Items:`, and the disk boots inside a WebAssembly Basilisk II in a normal
browser tab.

```text
       host machine                                    browser tab
  +----------------------+    +-------------------+   +---------------+
  | src/app/*.c, *.r     |--->| Retro68 (Docker   |   | Vite dev page |
  | src/web/src/*.ts     |    | or CI container)  |   |  + COI shim   |
  | src/web/public/      |    |  cmake --build    |   |               |
  +----------------------+    +-------------------+   |  +---------+  |
            |                          |              |  |Basilisk |  |
            v                          v              |  |II WASM  |  |
  +----------------------+    +-------------------+   |  | (System |  |
  | npm run test:unit    |    | Reader.bin (both  |   |  |  7.5.5) |  |
  | (host gcc, sub-sec)  |    | forks, MacBinary) |   |  | -> your |  |
  +----------------------+    +---------+---------+   |  |   app   |  |
                                        |             |  +---------+  |
                                        v             +-------^-------+
                              +-------------------+           |
                              | scripts/build-    |           |
                              | boot-disk.sh      |           |
                              | (hfsutils, chunk) |-----------+
                              +-------------------+
```

There are three loops you'll move between:

1. **Fast (sub-second).** Edit pure-C engine, run `npm run test:unit`.
   No emulator, no browser.
2. **Slow (~1-3 min).** Edit Toolbox shell or resource fork, cross-compile,
   rebuild boot disk, hard-reload the dev server.
3. **Slowest (~5-10 min).** Push, let CI build, deploy lands on Pages.

Pick the fastest loop that exercises the change. Most logic should be
testable in loop 1.

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

You also need a compiled Mac binary and a boot disk under
`src/web/public/`. Either:

- **Pull the latest CI artifact** (faster — see [Loop 2 → Pull from CI](#path-a-pull-the-binary-from-ci)),
  or
- **Build the binary locally** with the Retro68 Docker image (see
  [Loop 2 → Build locally](#path-b-build-locally-with-docker)).

If you skip both, the page still loads — the loader falls into a stub
state that renders chrome but no emulator. That's fine for iterating on
the page itself (loop 3.5 below).

## Loop 1 — the fast inner loop: edit, host-test, repeat

Use this whenever the change lives in pure C with no Toolbox calls — the
HTML parser, layout math, future game logic, anything that doesn't import
`<QuickDraw.h>` / `<Windows.h>` / `<Events.h>` / `<MacTypes.h>`.

```sh
# Edit src/app/html_parse.c (or your engine equivalent)
# Edit tests/unit/test_html_parse.c (add an assertion)
npm run test:unit
```

Build + run is sub-second on any modern host. The Makefile in
`tests/unit/` compiles `html_parse.c` with the host `cc`. No Retro68, no
Docker, no emulator.

### Worked example: add a feature, write a test, see it pass

Say you want `<code>` to render in monospace alongside `<pre>`. The pure-C
half is the tokenizer:

```c
// src/app/html_parse.c — inside the tag-dispatch table
{ "code",   TAG_CODE,   true  },  // inline monospace
```

Then in `tests/unit/test_html_parse.c`:

```c
static void test_code_tag_emits_monospace_run(void) {
    HtmlDocument doc;
    html_parse(&doc, "<p>x <code>foo</code> y</p>", strlen(...));
    /* assert: token stream contains a monospace-styled "foo" run */
}
```

Iterate: `npm run test:unit` until green. Total round-trip per change is
under a second. You don't have to think about Mac fonts, Toolbox
initialization, or memory alignment until later.

The same pattern applies to anything else you push behind the
`html_parse.{c,h}` boundary: file format readers, a board-game move
generator, a Markdown-to-HTML preprocessor. See
[`src/app/README.md`](../src/app/README.md#architectural-pattern-toolbox-shell--pure-c-engine)
for the architectural reasoning.

## Loop 2 — the slow loop: cross-compile and boot in the browser

Use this when the change is in `reader.c` (or your Toolbox shell), in
`reader.r` (resource fork), or in anything else that has to actually run
on a 68k Mac. There are two paths.

### Path A — pull the binary from CI

Cheapest if your change is in JS/TS or you just want to run someone
else's branch.

```sh
# Push your branch, let CI build it. Then grab the artifact:
gh run download \
  "$(gh run list --branch "$(git branch --show-current)" \
       --workflow Build --limit 1 --json databaseId -q '.[0].databaseId')" \
  -D /tmp/cvm-artifact

# The artifact name carries the SHA. Resolve it:
ART="$(echo /tmp/cvm-artifact/classic-vibe-mac-*)"
ls "$ART"
#   build/reader/Reader.bin       build/reader/Reader.{dsk,APPL}
#   build/macweather/MacWeather.{bin,dsk,APPL}
#   dist/app.dsk       dist/system755-vibe.dsk   dist/system755-vibe.dsk.json
#   dist/system755-vibe-chunks/

# Bake the boot disk + chunks into src/web/public/. This is the only
# step that has to run on the host (CI does the same thing, but its
# output is ready-to-deploy). The script takes a comma-separated list
# of .bin paths so all apps land on the same boot disk.
bash scripts/build-boot-disk.sh \
  "$ART/build/reader/Reader.bin,$ART/build/macweather/MacWeather.bin,$ART/build/hello-mac/HelloMac.bin,$ART/build/pixelpad/PixelPad.bin,$ART/build/markdownviewer/MarkdownViewer.bin" \
  src/web/public/system755-vibe.dsk

# Copy the secondary app.dsk (the loader HEAD-checks for it).
cp "$ART/dist/app.dsk" src/web/public/app.dsk

# Run.
npm run dev
# open http://localhost:5173/
```

`scripts/build-boot-disk.sh` is idempotent: it downloads the System 7.5.5
image once into `.cache/boot-disk/` (~24 MB), verifies the SHA-256, copies
the cached blob to the output path, mounts it via hfsutils, drops the
MacBinary into `:System Folder:Startup Items:`, and re-chunks the result
into the manifest format the WASM disk reader consumes. Re-running it
takes a couple of seconds after the first download.

The script also asserts the resource fork is non-zero — a defense against
the silent-rsrc-loss class of bugs documented in
[`LEARNINGS.md`](../LEARNINGS.md) (`hls -l` columns gotcha).

### Path B — build locally with Docker

Use this when CI is red, when you don't want a network round-trip per
change, or when you want to bisect with edits that aren't ready to push.

```sh
docker run --rm -v "$PWD:/work" -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
```

The first run pulls the ~2 GB Retro68 image (one time). After that the
build itself is on the order of 10-20 seconds for the small demo apps.

Outputs land under `build/<app>/` — one subdirectory per app:

| File | What it is |
|------|------------|
| `build/reader/Reader.bin` | MacBinary, both forks. Feed to `build-boot-disk.sh`. |
| `build/reader/Reader.dsk` | Standalone HFS image with just the app inside. Useful for sanity. |
| `build/reader/Reader.APPL` | Data fork only. Often 0 bytes — that's normal. |
| `build/macweather/MacWeather.{bin,dsk,APPL}` | Same outputs for MacWeather. |

Then bake the boot disk the same way Path A does — pass all
`.bin` paths comma-separated so every app lands on the same disk:

```sh
bash scripts/build-boot-disk.sh \
  "build/reader/Reader.bin,build/macweather/MacWeather.bin,build/hello-mac/HelloMac.bin,build/pixelpad/PixelPad.bin,build/markdownviewer/MarkdownViewer.bin" \
  src/web/public/system755-vibe.dsk

# app.dsk is also produced by CI; if you don't have it locally, the
# loader will tolerate its absence on dev (it's required on prod).
# To produce it locally:
bash scripts/build-disk-image.sh build/reader/Reader.bin src/web/public/app.dsk
```

Then `npm run dev`.

> **Tip.** If you're iterating on the C code, you can keep `npm run dev`
> running in another terminal. After each rebuild + `build-boot-disk.sh`,
> a hard reload (Cmd-Shift-R) in the browser is enough — Vite's HMR does
> not see the .dsk change otherwise.

## Loop 3 — ship via CI

For anything you want on the deployed site:

```sh
git checkout -b feat/your-thing
# ... edits, commits with Conventional Commits style ...
git push -u origin feat/your-thing
gh pr create --fill
```

`.github/workflows/build.yml` cross-compiles in the
`ghcr.io/autc04/retro68:latest` container, packs the disks, builds the
Vite frontend, and uploads to GitHub Pages — but only when the PR is
merged into `main` (the deploy job is gated on
`github.ref == 'refs/heads/main' && github.event_name != 'pull_request'`).
PRs run the build for CI signal but don't deploy.

Branching, commit, and merge conventions live in
[`CONTRIBUTING.md`](../CONTRIBUTING.md): Conventional Commits, squash-merge
default, Conventional-Commits squash messages.

### Loop 3.5 — iterate on the page chrome

The web shell (Vite + TypeScript) hot-reloads cleanly. If your change is
purely in `src/web/src/` or `src/web/public/`:

```sh
npm run dev
# edit files; Vite HMR refreshes the browser automatically
```

You don't need to rebuild the Mac binary or the boot disk for this.

## Common-task recipes

### Change app behavior

Toolbox-side change (event handling, menu, drawing). Loop 2.

```sh
# 1. Edit src/app/reader.c — add a menu item, or change the View menu.
# 2. (optional) Add a unit test for any pure-C function you touched.
npm run test:unit
# 3. Cross-compile (Path A or Path B above).
docker run --rm -v "$PWD:/work" -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
# 4. Rebuild the boot disk and reload (pass every app's .bin).
bash scripts/build-boot-disk.sh \
  "build/reader/Reader.bin,build/macweather/MacWeather.bin,build/hello-mac/HelloMac.bin,build/pixelpad/PixelPad.bin,build/markdownviewer/MarkdownViewer.bin" \
  src/web/public/system755-vibe.dsk
# (npm run dev in another terminal — hard-reload the tab)
```

### Add an HTML page Reader can show

The `:Shared:` volume is seeded from `src/web/public/shared/`. Any file
you drop in there appears inside the Mac at `:Shared:<name>` after a
boot. From inside the Mac, Reader picks it up via the host's
`extfs` mount. See the
[`LEARNINGS.md` entry on extfs seeding](../LEARNINGS.md) for the
mechanism.

```sh
# Add the file.
cp my-doc.html src/web/public/shared/my-doc.html

# Make sure something links to it — e.g. add an <a href="my-doc.html">
# in src/web/public/shared/index.html.

# Reload the dev page. Reader sees the new file at :Shared:my-doc.html.
```

No rebuild needed — these are static assets the dev server hands the
emulator at boot. You do need to reload the page (the volume is seeded
once per emulator session, in the worker's `preRun`).

### Replace the demo app with your own

See [`src/app/README.md`](../src/app/README.md#how-to-add-a-new-app).
The short version: replace `reader.c` / `reader.r`, keep the
Toolbox-shell + pure-C-engine split, update `CMakeLists.txt`'s
`add_application(...)` target, update `tests/unit/Makefile`, and check
`scripts/build-boot-disk.sh` + `scripts/build-disk-image.sh` +
`.github/workflows/build.yml` for any hardcoded `Reader` strings.

### Debug a runtime crash inside the Mac

The Mac doesn't give you a stack trace. The classic bomb dialog tells
you a category ("unimplemented trap", "address error", "bus error") and
nothing else. The pattern that worked for us is **bisection by deletion**:

1. Reduce `reader.c` (or whatever your shell is) to the smallest possible
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

The other tool worth knowing about is the visual test layer
([`tests/README.md`](../tests/README.md#layer-3-vision-assertions-claude-api)),
which lets you ask a vision model "is the bomb dialog visible?" or "is
the Reader window showing the index page?" against a screenshot. Useful
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
2. **CI build status.** If CI is red, the boot disk you just downloaded
   was either the previous green build's, or the disk packing step ran
   on a missing/empty `.bin` and now the resource fork is gone. The
   defensive check in `scripts/build-boot-disk.sh` (resource fork
   non-zero) catches the second case.
3. **The app is actually in `:System Folder:Startup Items:` on the boot
   volume.** Mount the disk and check:
   ```sh
   hmount src/web/public/system755-vibe.dsk
   hls -l ":System Folder:Startup Items:"
   humount src/web/public/system755-vibe.dsk
   ```
   `hls -l` columns are `<flag>  <TYPE>/<CREATOR>  <rsrc>  <data>  <date>  <name>` —
   a non-trivial `<rsrc>` and `Type=APPL` mean the install is correct.
   (`hls -l` columns are listed `rsrc data`, not `data rsrc` —
   `LEARNINGS.md` covers the day we got that backwards.)

### "My Reader changes don't show up"

Almost always one of:

- You forgot to rebuild the boot disk after re-cross-compiling. The
  disk in `src/web/public/` still has the old binary baked in. Re-run
  `scripts/build-boot-disk.sh`.
- You forgot to hard-reload the browser tab. Vite HMR doesn't see
  `.dsk` changes.
- The browser cached the chunked manifest aggressively. Open devtools,
  check the network tab for 304s on `system755-vibe.dsk.json` and the
  chunks under `system755-vibe-chunks/`. Disable cache (devtools →
  Network → "Disable cache" while open) for development sessions.

### "CI says `Controls.h` not found" (or another Retro68 header)

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

### "Retro68 Docker image build fails locally with `permission denied`"

The container runs as root and writes into the bind-mounted `/work`. If
your local repo is on a filesystem that doesn't allow that (some Docker
Desktop setups, or some BSD hosts), build to a path inside the container
and copy out:

```sh
docker run --rm -v "$PWD:/work" -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B /tmp/build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build /tmp/build --parallel \
    && cp /tmp/build/Reader.bin /work/build/"
```

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
- [`PRD.md`](../PRD.md) — architecture intent, milestones, risks
  register.
- [`docs/NETWORKING.md`](./NETWORKING.md) — deploying the optional
  Cloudflare DO Ethernet relay for `?zone=` networking.
