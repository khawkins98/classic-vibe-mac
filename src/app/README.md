# `src/app/` — the Mac app

This is what runs **inside** the emulated Macintosh. The Vite page hosts
the emulator and the chrome around it, but everything in this directory
gets cross-compiled into a 68k Mac binary by Retro68 in CI, packed into
the boot disk's `:System Folder:Startup Items:`, and auto-launched by
the Finder when the System 7.5.5 desktop appears.

You write classic Mac C against the System 7-era Toolbox APIs (QuickDraw,
Window Manager, Menu Manager, Event Manager, Dialog Manager, Resource
Manager). Forks replace this folder with their own app and get the
whole pipeline for free.

## Current app: Reader

A small HTML viewer. Reads files from a Mac volume named `Shared`,
renders a sensible subset of HTML to the screen with QuickDraw, and
follows links between files. Loads `:Shared:index.html` on launch.

The `Shared` volume is wired up by the host JS via Basilisk II's
`extfs` mechanism — files placed in `src/web/public/shared/` on the
host appear inside the Mac at `:Shared:`. That makes the host page a
content provider for the Mac app, which is the whole point: the Mac
app isn't a sandbox, it's a participant.

### Supported HTML subset

- `<p>`, `<br>` — paragraphs and line breaks with word-wrap
- `<h1>`, `<h2>`, `<h3>` — larger / bolder headings
- `<b>` / `<strong>`, `<i>` / `<em>` — bold and italic
- `<ul>` / `<li>` — bulleted lists (one level of nesting)
- `<a href="other.html">` — clickable links to other files in `:Shared:`
- `<pre>` — monospace blocks (Monaco font)
- Entities: `&amp;` `&lt;` `&gt;` `&quot;` `&apos;` `&nbsp;`

Out of scope (deliberately): images, tables, CSS, forms, JavaScript,
real network fetching.

### Files

| File | Role |
|---|---|
| `reader.c` | Toolbox UI shell — event loop, menus, scroll bar, link click handling, file I/O via `:Shared:` |
| `reader.r` | Rez resources — `WIND` (document window), `MBAR`+`MENU` (Apple/File/Edit/View), `ALRT`/`DITL` (About), `STR#`, `vers`, `SIZE` |
| `html_parse.c`, `html_parse.h` | Pure-C tokenizer + layout. **No Toolbox includes.** Compiles with host `gcc` for unit tests. |
| `CMakeLists.txt` | Retro68 build config (`add_application(Reader …)`) |

## Architectural pattern: Toolbox shell + pure-C engine

The app is split deliberately:

- **Pure-C engine** (`html_parse.{c,h}` here, was `game_logic.{c,h}` for
  Minesweeper) does all the actual logic that would be testable on a
  modern machine. No `MacTypes.h`, no `QuickDraw.h`, no `WaitNextEvent`.
  Compiles with both the Retro68 cross-compiler and your host's `gcc`.
- **Toolbox shell** (`reader.c`) owns the platform: event loop, drawing,
  menus, file dialogs. Calls into the pure-C engine for the substance.

The payoff: `tests/unit/` runs the engine on the host in milliseconds.
You can iterate on the parser, the game rules, the layout algorithm,
whatever it is — without ever booting an emulator.

The split also makes the Toolbox surface very thin and easy to read. If
you want to learn classic Mac programming, `reader.c` is a small
on-ramp.

## How to build locally

You don't need to. CI builds the binary on every push and you can pull
the artifact (see the project's main `README.md`). But if you want to
iterate locally, the cheapest path is the Retro68 Docker image:

```sh
docker run --rm -v $PWD:/work -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
```

Outputs land in `build/`:

- `Reader.bin` — MacBinary, both forks. This is what `scripts/build-boot-disk.sh` consumes.
- `Reader.dsk` — small standalone HFS disk image with the app.
- `Reader.APPL` — data fork only (often 0 bytes for resource-only apps).

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
exercise `html_parse.c` (tokenizer, layout, link regions, word-wrap,
nested formatting). See `tests/unit/test_html_parse.c`.

## How to replace this app with your own

This repo is a template. To build a different Mac app:

1. Replace `reader.c`, `reader.r`, and the `html_parse.*` engine with
   your own C source and resources. Keep the `Toolbox shell + pure-C
   engine` split if you can — it's the difference between a
   maintainable app and a tangle.
2. Update `CMakeLists.txt`: change `add_application(Reader …)` to your
   app's name and the source list.
3. Update `tests/unit/Makefile` and write tests against your engine.
4. Decide whether you still want the `:Shared:` extfs hookup. If your
   app is self-contained (like Minesweeper was), you can drop it from
   `src/web/src/emulator-worker.ts`.
5. Push. CI compiles, packs the boot disk, deploys.

If your app's name changes, also check `scripts/build-boot-disk.sh`,
`scripts/build-disk-image.sh`, and `.github/workflows/build.yml` for
any hardcoded `Reader` references — they should match the
`add_application()` target name.

## Toolbox notes worth knowing

- **Pascal strings.** Toolbox APIs take `Str255`/`StringPtr`. Use
  `\p"…"` literals in source (Retro68 supports them) and `c2pstr` /
  `p2cstr` only when interfacing with C-string code.
- **Memory Manager.** `NewHandle`/`DisposeHandle`,
  `HLock`/`HUnlock` around dereferences. Call `MoreMasters()` four to
  six times right after `InitDialogs` to expand the master pointer
  block — without it, low-memory situations corrupt the heap and
  surface as mysterious crashes long after the trigger.
- **Resource Manager.** UI elements (`WIND`, `MENU`, `DLOG`, `ALRT`,
  `CNTL`, `STR#`, etc.) belong in `reader.r`, compiled to the resource
  fork by Rez. Don't hardcode UI in C if a resource type covers it.
- **No POSIX.** No `stdio`, no `unistd`, no `malloc`. File I/O goes
  through `FSpOpenDF` / `FSRead` / `FSWrite` (or older `PBOpenSync`).
  We use `HOpen` here for cross-volume reads from `:Shared:`.
- **Fonts.** Retro68's `Fonts.h` exposes `applFont` and `systemFont`
  but not the per-family aliases like `geneva` (a misleading
  surface — the older Inside Macintosh listings reference them). On
  a default System 7 install, `applFont` resolves to Geneva, which is
  what you want for body text.

Good external references when you want to go deeper: *Inside Macintosh*
(scanned at archive.org and pagetable.com), Apple's *Macintosh Human
Interface Guidelines* (1992), and the Retro68 sample apps under
`autc04/Retro68/Samples/` for the canonical patterns used here.
