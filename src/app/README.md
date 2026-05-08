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

## Multi-app structure

```
src/app/
├── CMakeLists.txt          (aggregator: add_subdirectory(reader), etc.)
├── reader/
│   ├── reader.c
│   ├── reader.r
│   ├── html_parse.{c,h}
│   └── CMakeLists.txt
└── macweather/
    ├── macweather.c
    ├── macweather.r
    ├── weather_parse.{c,h}
    ├── weather_glyphs.{c,h}
    └── CMakeLists.txt
```

Each app has its own creator code (Reader=`CVMR`, MacWeather=`CVMW`),
its own `add_application()` call, and its own resource fork. Outputs land
in `build/<appname>/<App>.{bin,dsk,APPL}`. CI uploads everything from
`build/` so adding a new app just means `add_subdirectory(<name>)`
above and a directory next to the others.

## Apps

### Reader (`reader/`)

A small HTML viewer. Reads files from a Mac volume named `Shared`
(baked onto the boot disk by `scripts/build-boot-disk.sh`), renders a
sensible subset of HTML to the screen with QuickDraw, follows links
between files. Loads `:Shared:index.html` on launch.

Supported HTML: `<p>`, `<br>`, `<h1>`-`<h3>`, `<b>`/`<strong>`,
`<i>`/`<em>`, `<ul>`/`<li>` (one level), `<a href>`, `<pre>`, the
common entities. Out of scope (deliberately): images, tables, CSS,
forms, JavaScript, real network fetching.

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
