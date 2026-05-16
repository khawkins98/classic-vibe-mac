# `src/app/` — the Mac apps

This is what runs **inside** the emulated Macintosh. The Vite page hosts
the emulator and the chrome around it, but everything in this directory
gets cross-compiled into 68k Mac binaries by Retro68 in CI, packed into
the boot disk, and auto-launched by the Finder when the System 7.5.5
desktop appears.

You write classic Mac C against the System 7-era Toolbox APIs (QuickDraw,
Window Manager, Menu Manager, Event Manager, Dialog Manager, Resource
Manager). Each app lives in its own subdirectory; the top-level
`CMakeLists.txt` is a tiny aggregator.

There are two parallel app shelves:

1. **CMake / Retro68 apps** — full Mac apps cross-compiled in CI,
   baked into the boot disk, auto-launched at startup. The longer-form
   showcase apps (Reader, MacWeather, Hello Mac, Pixel Pad, Markdown
   Viewer). All have their own `CMakeLists.txt` and unit tests on the
   host.

2. **Wasm-shelf samples** (under `wasm-*/`) — small focused demos that
   the in-browser playground compiles end-to-end client-side via
   wasm-retro-cc (cc1 + as + ld + Elf2Mac) and, where present, WASM-Rez
   for the resource fork. No CMake. No CI step. Visitors pick them
   from the project picker, edit, click Build & Run, and the emulator
   reboots with the new binary in ~1 s. Section ["Wasm-shelf samples"
   below](#wasm-shelf-samples) covers the inventory.

## Multi-app structure

```
src/app/
├── CMakeLists.txt          (aggregator for the CI apps below)
│
├── reader/                 (CMake apps — boot-disk auto-launch)
│   ├── reader.c            ├── reader.r
│   ├── html_parse.{c,h}    └── CMakeLists.txt
├── macweather/
│   ├── macweather.c        ├── macweather.r
│   ├── weather_parse.{c,h} ├── weather_glyphs.{c,h}
│   └── CMakeLists.txt
├── hello-mac/              ├── hello-mac.c + .r + CMakeLists.txt
├── pixelpad/               ├── pixelpad.c + .r + CMakeLists.txt
├── markdownviewer/         ├── markdownviewer.c + .r + markdown_parse.{c,h} + CMakeLists.txt
│
├── wasm-hello/             (Wasm-shelf — in-browser compile only)
│   └── hello.c
├── wasm-hello-multi/       ├── main.c + greet.c + greet.h
├── wasm-hello-window/      ├── hello.c + hello.r
├── wasm-snake/             ├── snake.c + snake.r
├── wasm-textedit/          ├── textedit.c + textedit.r
├── wasm-notepad/           ├── notepad.c + notepad.r
├── wasm-stickynote/        ├── stickynote.c + stickynote.r
├── wasm-wordpad/           ├── wordpad.c + wordpad.r
├── wasm-clock/             ├── clock.c + clock.r
├── wasm-multiwin/          ├── multiwin.c + multiwin.r
├── wasm-cursor/            ├── cursor.c + cursor.r
├── wasm-files/             ├── files.c + files.r
├── wasm-gworld/            ├── gworld.c + gworld.r
├── wasm-calculator/        ├── calc.c + calc.r
├── wasm-scribble/          ├── scribble.c + scribble.r
├── wasm-scrollwin/         ├── scrollwin.c + scrollwin.r
├── wasm-patterns/          ├── patterns.c + patterns.r
├── wasm-bounce/            ├── bounce.c + bounce.r
├── wasm-dialog/            ├── dialog.c + dialog.r
├── wasm-sound/             ├── sound.c + sound.r
└── wasm-color/             └── color.c + color.r
```

CMake apps have their own creator code (Reader=`CVMR`, MacWeather=`CVMW`,
HelloMac=`CVHM`, PixelPad=`CVMP`, MarkdownViewer=`CVMD`), their own
`add_application()` call, and their own resource fork. Outputs land in
`build/<appname>/<App>.{bin,dsk,APPL}`. CI uploads everything from
`build/` so adding a new CMake app just means `add_subdirectory(<name>)`
above and a directory next to the others.

Wasm-shelf samples don't touch CMake — they're registered in
[`src/web/src/playground/types.ts`](../web/src/playground/types.ts)
and surfaced by the picker in
[`src/web/src/projectPicker.ts`](../web/src/projectPicker.ts). The Vite
plugin in [`src/web/vite.config.ts`](../web/vite.config.ts)'s
`SEED_FILES` copies their sources into `public/sample-projects/` at
build time so the playground can fetch them.

## Apps

### Reader (`reader/`)

A small HTML viewer. Reads files from a Mac volume named `Shared`
(baked onto the boot disk by `scripts/build-boot-disk.sh`), renders a
sensible subset of HTML to the screen with QuickDraw, follows links
between files. Loads `:Shared:index.html` on launch.

Also has a **URL bar**: the user types a URL (CORS-permissive sources
only), Reader writes a request file to `:Unix:__url-request.txt`, the
host JS fetches the URL via `fetch()` on the main thread, and writes
the result HTML back to `:Unix:__url-result-<id>.html`. Reader polls
for the result. Request-ID correlation prevents stale results.

Supported HTML: `<p>`, `<br>`, `<h1>`-`<h3>`, `<b>`/`<strong>`,
`<i>`/`<em>`, `<ul>`/`<li>` (one level), `<a href>`, `<pre>`, the
common entities. Out of scope (deliberately): images, tables, CSS,
forms, JavaScript.

### MacWeather (`macweather/`)

A tiny live-data app. Reads `:Unix:weather.json` (the Emscripten
`/Shared/` tree, mounted by BasiliskII's extfs as `Unix:` — see
`LEARNINGS.md`), parses the open-meteo response shape with a hand-rolled
JSON parser, and draws the current conditions plus a 3-day forecast
with pixel-art QuickDraw glyphs.

The JS host (`src/web/src/weather-poller.ts`) polls
`api.open-meteo.com` every 15 minutes and writes the JSON to
`/Shared/weather.json`. MacWeather watches the modtime and redraws on
change. Cmd-R force-refreshes. No JSON library; the parser is bounded
to open-meteo's specific shape and lives in `weather_parse.c`.

### Hello Mac (`hello-mac/`)

The simplest possible Toolbox application: a single window, "Hello,
World!" drawn in the center via QuickDraw, a Quit command in the Apple
menu, and nothing else. ~200 lines of C total.

Start here if you're new to classic Mac Toolbox programming. It's also
the default sample the in-browser playground opens when a user first
visits.

### Pixel Pad (`pixelpad/`)

A QuickDraw freehand drawing app. The user draws with the mouse in a
64×64 canvas area. When the user saves (Cmd-S or the Save menu item),
Pixel Pad writes a 512-byte 1-bit bitmap (`MSB-first`, 0=white, 1=black)
to `:Unix:__drawing.bin` via `FSWrite`.

The JS host (`src/web/src/drawing-watcher.ts`) polls this file via the
worker's `poll_drawing` postMessage, receives the raw bytes, converts
them to a PNG using a Canvas 2D context, and renders a live preview
below the emulator. The round-trip from Save to preview update is
approximately one polling interval (500ms).

This demonstrates the **Mac → JS** extfs data bridge in reverse compared
to MacWeather (which is JS → Mac).

### Markdown Viewer (`markdownviewer/`)

Reads `.md` files from the `:Shared:` folder on the boot disk and
renders them using a hand-rolled C Markdown parser (`markdown_parse.{c,h}`).
Supports headings (`#`–`###`), paragraphs, bold, italic, inline code,
fenced code blocks, unordered lists, and horizontal rules. Links between
`.md` files in `:Shared:` work; external URLs are not fetched.

The same `:Shared:` mechanism Reader uses — files baked onto the boot
disk at build time by `scripts/build-boot-disk.sh`. To add your own
`.md` files to the viewer, copy them into `src/web/public/shared/` before
running the boot-disk build script.

## Wasm-shelf samples

These are the in-browser-buildable demos the playground surfaces in
its picker. The picker reads
[`SAMPLE_PROJECTS`](../web/src/playground/types.ts) for the list;
[`projectPicker.ts`](../web/src/projectPicker.ts) holds the per-sample
icon + blurb. Each one is deliberately small and picks a *distinct*
Toolbox surface so the shelf reads as a progression rather than
variations on a theme.

| Sample | Files | Toolbox surfaces exercised | LOC (≈) |
| --- | --- | --- | --- |
| `wasm-hello/` | `hello.c` | `InitGraf`, `DrawString` — minimum-viable in-browser build | 30 |
| `wasm-hello-multi/` | `main.c` + `greet.c` + `greet.h` | Multi-TU link path (`ld` two `.o`s + libs) | 30 |
| `wasm-hello-window/` | `hello.c` + `.r` | `GetNewWindow` (WIND resource), `BeginUpdate`/`EndUpdate` | 50 |
| `wasm-snake/` | `snake.c` + `.r` | `TickCount` game loop, `WaitNextEvent` keyboard, `EraseRect`+`PaintRect` grid | 230 |
| `wasm-textedit/` | `textedit.c` + `.r` | `TENew`/`TEClick`/`TEKey`/`TEUpdate`/`TEIdle`/`TESelect` | 130 |
| `wasm-notepad/` | `notepad.c` + `.r` | `MBAR`/`MenuSelect`/`MenuKey`, `TECut`/`TECopy`/`TEPaste` (system scrap), `StopAlert` dialogs | 180 |
| `wasm-stickynote/` | `stickynote.c` + `.r` | Pale-yellow `RGBBackColor` + `EraseRect` paper, single TextEdit field, draggable noGrowDocProc window — the colour-QuickDraw entry in the TextEdit ladder | 150 |
| `wasm-wordpad/` | `wordpad.c` + `.r` | Mini word processor — Font/Size/Style menus driving monostyle TextEdit via `txFont`/`txSize`/`txFace` + `TECalText`. Bold/Italic/Underline accelerators (⌘B/⌘I/⌘U), live menu check marks. Next rung after Notepad | 260 |
| `wasm-clock/` | `clock.c` + `.r` | `GetDateTime` + `SecondsToDate`, 60-tick idle redraw, `FrameOval`/`MoveTo`/`LineTo`/`FillOval` analog face, hand-rolled 60-entry sin/cos table (no libm) | 190 |
| `wasm-multiwin/` | `multiwin.c` + `.r` | Three windows, one event loop — `SelectWindow` on back-window clicks, refCon-stashed per-window state (`SetWRefCon`/`GetWRefCon`), `FillRect` with QDGlobals patterns. Last close exits | 140 |
| `wasm-cursor/` | `cursor.c` + `.r` | Region-driven Cursor Manager — four labelled quadrants, `GetCursor` + `SetCursor` to swap among arrow / I-beam / watch / cross-hair on `nullEvent` ticks. The Mac has no enter/leave events — poll the mouse, debounce on change | 150 |
| `wasm-files/` | `files.c` + `.r` | File I/O round-trip — `StandardGetFile` / `StandardPutFile` for the dialogs, `FSpCreate` + `FSpOpenDF` + `FSRead`/`FSWrite` + `SetEOF` for the bytes. Three-button bar (Open / Save / Quit) above a 32 KB-capped TextEdit | 280 |
| `wasm-gworld/` | `gworld.c` + `.r` | Modern `NewGWorld` + `GetGWorldPixMap` + `LockPixels` + `CopyBits` double-buffer. Four shapes bounce around a 320×200 scene — the clean System 7+ upgrade path from `wasm-bounce`'s hand-rolled `NewPtr`+`SetPortBits` BitMap | 200 |
| `wasm-calculator/` | `calc.c` + `.r` | Hand-drawn `FrameRoundRect` buttons, `PtInRect` hit-test, `NumToString` display, `InvertRoundRect` press feedback | 170 |
| `wasm-scribble/` | `scribble.c` + `.r` | `StillDown`/`GetMouse`/`LineTo` mouse-tracking — the IM ch. 1 drag-to-draw loop | 150 |
| `wasm-scrollwin/` | `scrollwin.c` + `.r` | `NewControl(scrollBarProc)`, `TrackControl` with live actionProc, `Get`/`SetControlValue` | 200 |
| `wasm-patterns/` | `patterns.c` + `.r` | `Pattern` (8x8 bitmap), `FillRect` with custom + system patterns (white/ltGray/gray/dkGray) | 165 |
| `wasm-bounce/` | `bounce.c` + `.r` | Hand-built offscreen `BitMap` (NewPtr buffer + SetPortBits), `CopyBits` double-buffer, `TickCount`-paced animation | 180 |
| `wasm-dialog/` | `dialog.c` + `.r` | `DLOG` + `DITL` (StaticText + EditText + 2 Buttons), `GetNewDialog` / `ModalDialog` / `GetDialogItem` / `GetDialogItemText` / `SelectDialogItemText` (modern Universal Headers names — in-browser libInterface dropped the legacy aliases) | 180 |
| `wasm-sound/` | `sound.c` + `.r` | `SysBeep(duration)` — the simplest, oldest Sound Manager entry-point | 140 |
| `wasm-color/` | `color.c` + `.r` | Color QuickDraw `RGBColor`, `RGBForeColor`, `PaintRect` — the 1990 Macintosh II 6-colour palette | 140 |

**Coverage gaps worth filling next** — surfaces no sample exercises:

- **`SndPlay` on an `'snd '` resource** — the richer Sound Manager path past SysBeep
- **Multi-style TextEdit** (`TEStyleNew` + per-run formatting) — the missing rung between WordPad's monostyle and a real word processor

### Adding a wasm-shelf sample

Different flow from the CMake apps — no CMake, no CI, no boot disk:

1. Create `src/app/wasm-<name>/<name>.c` (+ optional `<name>.r`).
2. Add a `SEED_FILES` entry in [`src/web/vite.config.ts`](../web/vite.config.ts) so Vite copies the sources into `public/sample-projects/` at dev/build time.
3. Add a `SAMPLE_PROJECTS` entry in [`src/web/src/playground/types.ts`](../web/src/playground/types.ts) — set `rezFile` to your `.r` (or `null` for a C-only sample) and pick a 4-letter creator code.
4. Add a `PICKER_ENTRIES` blurb in [`src/web/src/projectPicker.ts`](../web/src/projectPicker.ts) (emoji + one-line description).
5. `npm run build` from `src/web/` — done. The picker now lists your sample.

> **CI caveat for wasm-shelf samples.** The repo's `Cross-compile
> classic Mac apps (68k)` job builds against Retro68's Docker image
> (the same toolchain CMake uses for the boot-disk apps), **not**
> against the in-browser wasm-retro-cc sysroot. So passing CI on a
> wasm-* sample only proves the source is structurally valid. Whether
> it actually links in the browser depends on what's vendored in the
> wasm-retro-cc sysroot — some Toolbox surfaces (e.g. full Sound
> Manager `SndPlay`, `NewGWorld`) may need additional library glue.
> The honest test is: click Build & Run in the playground. If you
> hit a link error, file it in the
> [wasm-retro-cc tracker](https://github.com/khawkins98/wasm-retro-cc/issues)
> as a missing-symbol report. Cv-mac's #125 issue links examples.

#### In-browser sysroot quirks worth knowing

The in-browser cc1 ships only the consolidated `Multiverse.h` (every
Toolbox prototype in one file), not Retro68's per-API umbrella headers.
Practical implications when writing wasm-shelf samples:

- **Headers that work** — `<Types.h>`, `<Quickdraw.h>`, `<Fonts.h>`,
  `<Windows.h>`, `<Menus.h>`, `<TextEdit.h>`, `<Dialogs.h>`,
  `<Events.h>`, `<Memory.h>`, `<OSUtils.h>`. These are present and
  pull in Multiverse.h transitively.
- **Headers that *don't* exist as separate files** in the in-browser
  sysroot — `<Controls.h>`, `<Lists.h>`, `<Scrap.h>` and similar
  fine-grained Toolbox subsystem headers. Their APIs are still available
  via the cascading inclusion above; omit the explicit include rather
  than fight it. The native CMake build *does* have these as separate
  files, so dual-purpose code can include them under
  `#ifndef __wasm__` (any sentinel works — the native path won't see it).
- **API name drift** — `libInterface.a` in the in-browser bundle
  exports only the modern Universal Headers names. The legacy aliases
  (`SelIText` → `SelectDialogItemText`, `GetIText` → `GetDialogItemText`,
  etc.) are not in there. Use the modern names — they work on both
  paths.
- **`FALSE` / `TRUE`** at file scope (e.g. `static Boolean done = FALSE;`)
  isn't always exposed across SDK variants. Either use `0`/`1` directly
  or guard with `#ifndef FALSE / #define FALSE 0`.

These all surfaced in the #125 audit; every existing wasm-* sample
either avoids the issue or has the workaround in place.

## Architectural pattern: Toolbox shell + pure-C engine

Every app is split deliberately:

- **Pure-C engine** (`html_parse.{c,h}` for Reader, `weather_parse.{c,h}`
  for MacWeather) does all the actual logic that would be testable on a
  modern machine. No `MacTypes.h`, no `QuickDraw.h`, no `WaitNextEvent`.
  Compiles with both the Retro68 cross-compiler and your host's `gcc`.
- **Toolbox shell** (`reader.c`, `macweather.c`) owns the platform:
  event loop, drawing, menus, file dialogs. Calls into the pure-C
  engine for the substance.

The payoff: `tests/unit/` runs the engines on the host in
milliseconds. You can iterate on the parser, the layout algorithm, the
JSON shape, whatever it is — without ever booting an emulator.

The split also makes the Toolbox surface very thin and easy to read.
If you want to learn classic Mac programming, `reader.c` and
`macweather.c` are small on-ramps.

## How to build locally

You don't need to. CI builds the binaries on every push and you can
pull the artifacts (see the project's main `README.md`). But if you
want to iterate locally, the cheapest path is the Retro68 Docker image:

```sh
docker run --rm -v $PWD:/work -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
```

Outputs land in `build/<app>/`:

- `Reader.bin`, `MacWeather.bin` — MacBinary, both forks. What
  `scripts/build-boot-disk.sh` consumes.
- `*.dsk` — small standalone HFS disk images per app.
- `*.APPL` — data fork only (often 0 bytes for resource-only apps).

## How to run unit tests

From the repo root:

```sh
npm run test:unit
```

Or directly:

```sh
make -C tests/unit run
```

Pure-C tests build with the host `cc`/`gcc` in under a second. They
exercise both `html_parse.c` (tokenizer, layout, link regions,
word-wrap, nested formatting) and `weather_parse.c` (JSON parsing,
rounding, ISO-date day-of-week, wind-direction octant mapping).

## How to add a new app

1. Make a directory under `src/app/` with `<myapp>.c`, `<myapp>.r`,
   any pure-C engine modules, and a `CMakeLists.txt` that calls
   `add_application(<MyApp> CREATOR XXXX <sources>)` with a fresh
   creator code.
2. Add `add_subdirectory(<myapp>)` to `src/app/CMakeLists.txt`.
3. Add a target to `tests/unit/Makefile` if your app has any
   host-testable pure-C modules.
4. Add the binary to `scripts/build-boot-disk.sh`'s comma-separated
   list in CI (`.github/workflows/build.yml`).
5. Push. CI compiles, packs the boot disk, deploys.

## Toolbox notes worth knowing

- **Pascal strings.** Toolbox APIs take `Str255`/`StringPtr`. Use
  `\p"…"` literals in source (Retro68 supports them) and `c2pstr` /
  `p2cstr` only when interfacing with C-string code.
  **Caveat**: `Str63 foo = "\p..."` doesn't compile at file scope —
  Retro68's GCC won't implicitly cast a `"\p..."` char-array literal
  into the `unsigned char` Str63 type. Initialize at runtime with
  `PStrCopy()` instead.
- **Memory Manager.** `NewHandle`/`DisposeHandle`,
  `HLock`/`HUnlock` around dereferences. Call `MoreMasters()` four to
  six times right after `InitDialogs` to expand the master pointer
  block.
- **Resource Manager.** UI elements (`WIND`, `MENU`, `DLOG`, `ALRT`,
  `CNTL`, `STR#`, etc.) belong in `<app>.r`, compiled to the resource
  fork by Rez.
- **No POSIX.** No `stdio`, no `unistd`, no `malloc`. File I/O goes
  through `FSpOpenDF` / `FSRead` / `FSWrite` (or older `PBOpenSync`).
  We use `HOpen` to read from `:Shared:` and `:Unix:`.
- **Fonts.** Retro68's `Fonts.h` exposes `applFont` and `systemFont`
  but not the per-family aliases like `geneva` or `monaco` — use the
  numeric ID directly. On a default System 7 install, `applFont`
  resolves to Geneva, which is what you want for body text.
- **Controls API in Windows.h.** There is no standalone `Controls.h`
  in Retro68's multiversal interfaces — `NewControl` / `TrackControl`
  / `GetControlValue` are pulled in via `Windows.h`.
- **Finder-binding resources as raw `data` blobs.** Retro68's
  RIncludes don't ship `Finder.r` macros for `BNDL`/`FREF`/`ICN#`. The
  apps emit the on-disk wire format longhand. See `reader.r` for the
  byte-layout comments.

Good external references when you want to go deeper: *Inside Macintosh*
(scanned at archive.org and pagetable.com), Apple's *Macintosh Human
Interface Guidelines* (1992), and the Retro68 sample apps under
`autc04/Retro68/Samples/` for the canonical patterns used here.
