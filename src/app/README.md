# `src/app/`: the Mac sample programs

Everything here is classic Mac C (plus Rez `.r` resource files) that runs
inside the emulated System 7.5.5 Macintosh. Nothing in this directory is
cross-compiled ahead of time. When a visitor picks a sample in the
playground and clicks **Build & Run**, the browser compiles it with the
wasm build of the Retro68 toolchain (cc1 → as → ld → Elf2Mac for the C,
WASM-Rez for the `.r`), splices the two forks together and hot-loads the
result into the emulator.

The older boot-disk apps (Reader, MacWeather, Hello Mac, Pixel Pad,
Markdown Viewer) and their per-app CMake builds were retired in #276.
Every sample now lives in a `wasm-<name>/` directory.

## What's here

26 samples, listed roughly from beginner to advanced using the
`complexity` rating (1–6 stars) each one carries in
[`SAMPLE_PROJECTS`](../web/src/playground/types.ts). The picker shows
them in `SAMPLE_PROJECTS` order, not this one.

| ★ | Directory | What it shows |
| --- | --- | --- |
| 1 | `wasm-hello/` | Smallest possible build: one `hello.c`, no resources, no window. |
| 1 | `wasm-hello-window/` | Mixed C + `.r` build: a `WIND` resource loaded with `GetNewWindow`. |
| 2 | `wasm-stickynote/` | Floating sticky note: one TextEdit field on pale-yellow Color QuickDraw paper. |
| 2 | `wasm-clock/` | Analog clock plus digital readout via `GetDateTime`/`SecondsToDate` and a hand-rolled sin/cos table. |
| 2 | `wasm-cursor/` | Cursor Manager: four quadrants that swap the cursor with `GetCursor`/`SetCursor`. |
| 2 | `wasm-scribble/` | Drag to draw using the `StillDown`/`GetMouse`/`LineTo` loop. |
| 2 | `wasm-patterns/` | The system patterns plus hand-rolled 8×8 `Pattern` bitmaps drawn with `FillRect`. |
| 2 | `wasm-sound/` | Sound Manager at its simplest: `SysBeep`. |
| 2 | `wasm-color/` | The Macintosh II six-colour palette via `RGBForeColor` and `PaintRect`. |
| 3 | `wasm-snake/` | Playable Snake: `TickCount` game loop, keyboard events, QuickDraw grid. |
| 3 | `wasm-textedit/` | Editable TextEdit field in a draggable window. |
| 3 | `wasm-notepad/` | TextEdit with a real menu bar (`MBAR`), ⌘-key shortcuts, cut/copy/paste and an About alert. |
| 3 | `wasm-wordpad/` | Small word processor: Font/Size/Style menus restyling monostyle TextEdit. |
| 3 | `wasm-files/` | File I/O round trip with `StandardGetFile`/`StandardPutFile`, `FSpCreate`, `FSRead`/`FSWrite`. |
| 3 | `wasm-gworld/` | Flicker-free animation with `NewGWorld` + `CopyBits` (the System 7 way). |
| 3 | `wasm-calculator/` | Four-function calculator: hand-drawn buttons, `PtInRect` hit-testing, `NumToString`. |
| 3 | `wasm-scrollwin/` | Scrolling list with a real scroll bar: `NewControl(scrollBarProc)` + `TrackControl`. |
| 3 | `wasm-bounce/` | Flicker-free animation with a hand-built offscreen `BitMap` (the pre-GWorld way). |
| 3 | `wasm-debug-console/` | Reference for `cvm_log()`, which prints to the playground's Output → Console tab. |
| 3 | `wasm-dialog/` | `ModalDialog` with an EditText field, built from `DLOG`/`DITL` resources. |
| 4 | `wasm-hello-multi/` | Multi-file C (`main.c` + `greet.c` + `greet.h`) linked by `ld`. No resources. |
| 4 | `wasm-mdpad/` | Split-pane Markdown editor with live preview and Open/Save to `:Shared:`. |
| 4 | `wasm-multiwin/` | Three windows, one event loop, per-window state in the `refCon`. |
| 5 | `wasm-arkanoid/` | Brick-breaker split into engine/render/main files, with an `ICN#` defined in the `.r`. |
| 6 | `wasm-icon-gallery/` | Ships a prebuilt `icons.rsrc.bin` next to the app and opens it at runtime with `OpenResFile`. |
| 6 | `wasm-glypha3/` | John Calhoun's 1992 arcade game (MIT), vendored whole, including its 2.7 MB upstream `.r`. |

`CMakeLists.txt` is an empty aggregator with no `add_subdirectory()`
calls. The `Build` workflow
(`.github/workflows/build.yml`) still configures and builds it with the
Retro68 Docker image so the CMake path doesn't rot, but it produces
nothing and none of the samples depend on it. Don't add samples there.

## Adding a sample

1. **Create the directory.** `src/app/wasm-<name>/` with `<name>.c` and,
   usually, `<name>.r`. Copying `wasm-hello-window/` is the easiest start.
   You don't need to list the files anywhere for seeding:
   [`src/web/vite.config.ts`](../web/vite.config.ts) globs every
   `src/app/wasm-*/` directory and copies its `.c`, `.h`, `.r` and
   `.rsrc.bin` files to `public/sample-projects/<name>/`. Anything else
   (READMEs, licences, `*.upstream` originals) is ignored. If a matching
   file shouldn't ship, add `<name>/<file>` to `SEED_EXCLUDES` there.
2. **Register it.** Add a `SampleProject` to `SAMPLE_PROJECTS` in
   [`src/web/src/playground/types.ts`](../web/src/playground/types.ts):
   `id` (the directory name), `label`, `files` (in the order you want
   them revealed), `rezFile` (the `.r`, or `null` for C only),
   `outputName`, `appType: "APPL"`, a four-character `appCreator`, and
   `complexity`. `tryNext` prompts are optional but worth adding.
3. **Give it a picker blurb.** Add an emoji and a one-paragraph
   description to `PICKER_ENTRIES` in
   [`src/web/src/projectPicker.ts`](../web/src/projectPicker.ts). Without
   one the picker falls back to the label and file list.
4. **Audit it.** `npm run audit:wasm-e2e -- wasm-<name>` from the repo
   root (details below).

## Conventions

- **Pascal strings.** Toolbox calls take `Str255`/`ConstStr255Param`.
  Samples use either `"\p..."` literals or an explicit
  length-prefixed `unsigned char` array (see `wasm-hello/hello.c`). A
  `"\p..."` literal can't initialise a `Str63` at file scope, so copy it
  in at runtime instead.
- **Signature and SIZE resources.** Each `.r` declares an owner-signature
  resource whose type matches `appCreator` (for example
  `data 'CVWW' (0, "Owner signature")`) and a `SIZE -1` resource that sets
  the heap size and the 32-bit-clean flag. See `wasm-hello-window/hello.r`
  for a commented minimal version. Pick a creator code that isn't already
  in use; `CVSN` and `CVCR` are each already shared by two samples.
- **Debug logging.** `#include <cvm_log.h>` and call `cvm_log(...)` to
  print to the Output → Console tab. The header lives in
  `wasm-debug-console/` but the compiler mounts it as a system header for
  every project, so any sample can include it.
- **Headers.** The in-browser sysroot ships the consolidated
  `Multiverse.h`, not Retro68's per-subsystem headers. `<Types.h>`,
  `<Quickdraw.h>`, `<Fonts.h>`, `<Windows.h>`, `<Menus.h>`,
  `<TextEdit.h>`, `<Dialogs.h>`, `<Events.h>`, `<Memory.h>` and
  `<OSUtils.h>` exist; `<Controls.h>`, `<Lists.h>` and `<Scrap.h>` don't,
  but their APIs arrive through the others. Leave those includes out.
- **Modern Toolbox names only.** `libInterface.a` exports the Universal
  Headers names (`GetDialogItemText`, `SelectDialogItemText`), not the
  legacy aliases (`GetIText`, `SelIText`).
- **`TRUE`/`FALSE`** aren't reliably defined at file scope. Use `1`/`0`
  or guard them with `#ifndef`.
- **No POSIX.** No `stdio`, no `malloc`. Use `NewPtr`/`NewHandle` and the
  File Manager (`FSpOpenDF`, `FSRead`, `FSWrite`).
- **Fonts.** Use numeric font IDs or `applFont`/`systemFont`; the
  per-family constants like `geneva` aren't defined.

## Verifying

From the repo root:

```sh
npm run audit:wasm-shelf        # compile every sample's C (cc1 → as → ld → Elf2Mac)
npm run audit:wasm-rez          # run every sample's .r through WASM-Rez
npm run audit:wasm-e2e          # both, as one pass/fail table
npm run audit:wasm-e2e -- wasm-snake   # just one sample
```

These run the same vendored toolchain the browser uses (from
`src/web/public/wasm-cc1/`) under Node, so a pass here means the Build
button will compile the sample. CI runs only `audit:wasm-shelf`, as the
`wasm-shelf-audit` job in `.github/workflows/test.yml`. The `.r` audit
is local-only, so run `audit:wasm-rez` or `audit:wasm-e2e` yourself
before pushing a resource change.

To see it actually run, `npm run dev`, pick the sample in the playground
and click **Build & Run**.

## References

*Inside Macintosh* (scans on archive.org), the 1992 *Macintosh Human
Interface Guidelines*, and the samples in `autc04/Retro68/Samples/`.
