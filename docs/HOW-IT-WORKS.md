# How It Works

_Last updated: 2026-05-15._

A guided tour for the curious developer. What actually happens when
you load `https://khawkins98.github.io/classic-vibe-mac/`, what you
can build with this stack today, and where it stops being practical.

For the engineering deep-dive, jump to
[`ARCHITECTURE.md`](./ARCHITECTURE.md). For the playground design
rationale, [`PLAYGROUND.md`](./PLAYGROUND.md). This doc sits one
layer above both of those.

---

## Part 1: From URL to running Mac

Seven steps. ~10 seconds wall-clock on a warm cache, top to bottom.

### 1. Static fetch from GitHub Pages

Navigation hits `index.html` on GitHub Pages. There is no server
logic, no backend, no relay, no auth — just static files served from
the `gh-pages` branch. Every byte the visitor receives runs in their
own tab from this point on. The deploy artifact is one Vite build
plus a chunked HFS disk image plus a Quadra-650 ROM.

### 2. Service worker installs for cross-origin isolation

The page needs `SharedArrayBuffer` for the emulator's video
framebuffer and input ring. SAB requires `crossOriginIsolated`,
which requires COOP `same-origin` + COEP `require-corp` headers —
which GitHub Pages can't set. So `coi-serviceworker.min.js` loads
as the first non-module `<script>`, registers a service worker, and
triggers exactly one page reload. The second navigation has the
required headers faked client-side. After that, `crossOriginIsolated
=== true` and `new SharedArrayBuffer(...)` works.

### 3. Vite-built host mounts the desktop and a canvas

`src/web/src/main.ts` paints a System 7 desktop in plain HTML/CSS —
striped title bar, menu bar, period background. `emulator-loader.ts`
mounts a period progress bar inside `#emulator-canvas-mount`,
HEAD-checks the chunked manifest at `${bootDiskUrl}.json`, then
spawns `emulator-worker.ts` as a `type: 'module'` Web Worker and
hands it the canvas via `OffscreenCanvas`.

### 4. Worker boots BasiliskII against System 7.5.5

The worker allocates three SharedArrayBuffers — video framebuffer,
videoMode metadata, and a 256-byte input ring whose offsets match
Infinite Mac's `InputBufferAddresses` byte-for-byte. It fetches the
Quadra-650 ROM, renders a prefs template (`modelid 30`, load-bearing
— see [`LEARNINGS.md`](../LEARNINGS.md)), mounts the boot disk via
the chunked-disk reader (256 KiB chunks fetched via synchronous XHR
from inside Wasm), and `import('/emulator/BasiliskII.js')`. The
Emscripten ES-module factory hands control to the WASM core, which
boots System 7.5.5 normally. Total wall time: ~5–10s on a warm
cache.

```text
+-------------------- visitor's tab --------------------+
|  index.html  -> coi-serviceworker (1 reload)          |
|  main.ts     -> System 7 chrome + canvas              |
|  emulator-worker.ts (SAB framebuffer + input ring)    |
|       |                                               |
|       v                                               |
|  BasiliskII.wasm (Quadra 650, 68040)                  |
|       |                                               |
|       v                                               |
|  System 7.5.5 boot disk (HFS, chunked)                |
|     :System Folder:Startup Items: Reader, MacWeather, |
|     Hello Mac, Pixel Pad, Markdown Viewer             |
|     :Applications: re-launchable copies               |
|     :Shared: HTML pages baked at build time           |
+-------------------------------------------------------+
```

### 5. Five apps auto-launch

System 7's Startup Items folder now contains five real 68k binaries —
`Reader`, `MacWeather`, `Hello Mac`, `Pixel Pad`, and `Markdown Viewer`
— all cross-compiled by [Retro68](https://github.com/autc04/Retro68)
in CI, so all five auto-launch when the desktop comes up. Each app is a
CMake target under `src/app/`, usually splitting cleanly into a Toolbox
shell (`<app>.c`) and a pure-C engine that also compiles with the host
`cc` so unit tests run in milliseconds. The build still emits
`BNDL`/`FREF`/`ICN#` resources by hand from `<app>.r` because Retro68's
RIncludes don't ship `Finder.r` macros. See
[`src/app/README.md`](../src/app/README.md).

`Pixel Pad` also shows the simplest Mac→host data bridge in the repo.
The app exports its 64×64 1-bit drawing to `:Unix:__drawing.bin`, and a
main-thread watcher notices that file change and renders a live PNG
preview beside the emulator. It's still just a file handoff, which is
why it feels period-correct while staying easy to reason about.

`Reader` now has the matching two-way bridge for its URL bar. The Mac
writes a request file to `:Unix:__url-request.txt`, the host fetches the
page, then writes the result back as `:Unix:__url-result-<id>.html`.
Each request carries an ID so stale responses don't win, and each host
fetch gets its own `AbortController`, which keeps the flow simple even
when the visitor changes their mind mid-load.

### 6. The IDE: four draggable WinBox panes + a real menubar

The page is a classic-Mac IDE. A fixed menubar across the top
(Apple / File / Edit / View / Special / Windows / Help) drops down
real Mac-OS-8-style pull-down menus — Apple opens the About box,
Edit opens Preferences, File hosts project actions, Windows lists
every open window, Help opens the help palette.

Under the menubar, four docked windows tile the viewport at first
load: **Project** (file list + project switcher), **Playground**
(CodeMirror 6 editor + Build / Build & Run / Download / Reset
toolbar), **Macintosh** (the live emulator), and **Output** (build
log + console). Each is a real
[WinBox](https://nextapps-de.github.io/winbox/) window with the Mac
OS 8 striped titlebar + recessed paper title field + diagonal grow
box + Platinum scrollbars — fully draggable, resizable,
raise-on-click, and shade-on-double-click (titlebar collapse).
View → Reset window layout snaps them back to the tiled grid.
The menubar's right edge carries a `cv-mac <hash>` build stamp
(click to open About) and the current date.

The Playground toolbar's **Reset** button discards local IDB edits
and re-fetches every file for the current project from the bundled
defaults — useful when the sample sources are updated server-side.
The **Download** button packages the current project as a `.zip` the
user can re-import via File → Open .zip.

The CodeMirror editor inside Playground (minimalSetup + the C
language pack + the search panel) seeds from
`src/web/public/sample-projects/` on first load and rehydrates from
IndexedDB on subsequent loads, so edits survive reloads. ⌘F opens
the search panel; ⌘G / ⇧⌘G walk matches; ⌘⌥F switches to
find-and-replace. UI state (open file, cursor position) is
persisted on a 1 s debounce. Build Log entries are clickable —
click a `file:line:col` diagnostic to jump the editor's cursor
there. See [`PLAYGROUND.md`](./PLAYGROUND.md) Phase 1.

Per-build telemetry surfaces as `[build-c] …` lines (per-stage cc1
/ as / ld / Elf2Mac timings) and a `[cvm-stats] session: N builds,
Xs spent compiling (avg Yms), Z cache hits (saved Ws)` summary
after every build, so the in-memory build artefact cache's
session-level payoff is observable.

### 7. Build & Run: the full toolchain runs in the tab

Click Build. The page does, for every sample project in the picker:

1. Reads the user's source from IndexedDB.
2. Compiles every `.c` through the in-browser toolchain
   ([wasm-retro-cc](https://github.com/khawkins98/wasm-retro-cc)'s
   Retro68 GCC ported to wasm): cc1 → as → ld → Elf2Mac, yielding a
   complete MacBinary II APPL.
3. If the project has an `.r` file (e.g. `wasm-hello-window`,
   `wasm-snake`, `wasm-textedit`), compiles it through the
   ~100 KB Apple Rez wasm and splices the resulting resource fork
   over the C-built fork — user resources (WIND, MENU, SIZE) win
   on (type, id) collision.
4. Patches the merged MacBinary into an in-memory HFS disk image
   (template-splice path: ship one empty `.dsk` as a CI artifact,
   patch the catalog leaf + bitmap + MDB to insert one file).
5. Calls the emulator worker's `dispose()` + `boot()` to re-spawn
   BasiliskII on the new disk.

Warm round trip: **~820 ms in production today**, well under the
"sub-second" goal. First click after page load is ~1.5 s (WASM-Rez
instantiation + RIncludes parse).

That's the loop. Edit a string, watch the Mac re-launch with your
change. Single tab, no install, no auth, no server.

#### How the C compile path works (shipped 2026-05-15)

The page reaches into the wasm toolchain like so:

1. Reads all `.c` source files from IndexedDB.
2. Loads four wasm modules — the Retro68 toolchain Emscripten-built
   in the sibling [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)
   repo:
   - `cc1.wasm` (~3.3 MB brotli) — GCC's C compiler proper
   - `as.wasm` (~270 KB brotli) — GNU `as`, the assembler
   - `ld.wasm` (~304 KB brotli) — GNU `ld`, the linker
   - `Elf2Mac.wasm` (~80 KB brotli) — Retro68's ELF → MacBinary
     converter
   Total in-browser toolchain: **~3.9 MB brotli**, lazy-loaded on
   first Build click; cached thereafter.
3. Pipes each `.c` through `cc1` → `.s`, then `as` → `.o`. All
   via MEMFS — no real filesystem.
4. Calls `ld` with all `.o` files + the bundled archives
   (`libretrocrt.a`, `libInterface.a`, `libc.a`, `libm.a`,
   `libgcc.a`) + the multi-segment ld script from `wasm-retro-cc`,
   producing an ELF.
5. Calls `Elf2Mac` to convert the ELF into MacBinary II APPL
   format with proper CODE-resource segmentation, jump table, A5
   world setup, and `RELA` runtime-relocation entries (the latter
   was the hard-won discovery — see
   [LEARNINGS Key Story #5](../LEARNINGS.md#5-the-canonical-build-diff-is-the-highest-leverage-diagnostic-when-bypassing-the-gcc-driver--use-it-first-not-last)).
6. Splices a default SIZE resource (libretrocrt needs the heap
   sized properly).
7. Hands the resulting `.bin` to the same in-memory HFS patcher
   the `.r` path uses, calls `dispose()` + `boot()` on the worker.

Warm round trip: **~1.5s** (cc1+as+ld+Elf2Mac runs in 30-50ms
total once the modules are loaded; the rest is HFS-patch + worker
respawn). Cold first-click: ~3-5s (lazy-load the toolchain).

The orchestration layer is `src/web/src/playground/cc1.ts`'s
`compileToBin()` function. The wasm modules themselves come from
[`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc) and
are vendored as binary assets under
`src/web/public/wasm-cc1/`. The cv-mac side does not implement
the compiler; it orchestrates four modules someone else's Retro68
project produced, in the same way GCC's driver normally
orchestrates them on a desktop system.

This is the capability Epic #19 originally closed as "4-9
engineer-months." It shipped in ~2 weeks once the path was
reframed as "wasm-compile the existing tools" instead of "port
GCC's fork/exec model." See
[LEARNINGS Key Story #6](../LEARNINGS.md#6-closed-as-infeasible-epics-describe-a-path-not-the-universal-answer--survey-alternative-paths-before-locking-the-closure-rationale-in-as-wisdom)
for the closed-as-infeasible retrospective.

---

## Part 2: What you can build, and where it stops

### What's tractable today

This stack is genuinely good for a specific shape of project. If
your idea fits one of these, you'll have fun:

- **Tiny utility apps.** Calculator, clock, dice roller, unit
  converter, password generator. Anything that fits in ~100KB
  compiled, draws with QuickDraw, and uses Toolbox dialogs/menus
  from `Inside Macintosh`. The two shipped sample apps (Reader and
  MacWeather) are both under 50KB of compiled 68k code each.
- **Demo / portfolio apps you can link from a website.** "Here's a
  thing I made; click the URL, it boots in your browser, no
  install." That's the whole pitch. Great for talks, blog posts,
  job-application novelty links.
- **Educational pieces about classic Mac development.** Resource
  forks, the System 7 Toolbox, MacBinary, BNDL/FREF/ICN# Finder
  binding, the event loop — all visible and inspectable here in a
  way they're not on a real machine in a museum.
- **Interactive content rendered through the Mac.** An HTML viewer
  (Reader does this — it parses a tiny HTML subset and renders with
  QuickDraw), a Markdown viewer, a Lisp REPL, a small game with
  arrow-key controls. The Mac is the "screen" for content the host
  page hands it via `:Shared:`.
- **Peer-to-peer AppleTalk apps.** If you deploy the optional
  Cloudflare zone relay (see [`docs/NETWORKING.md`](./NETWORKING.md)),
  multiple visitors can join a shared zone for Mac-to-Mac networking.
  That keeps the internet-facing part on the host side while still
  letting the guest Macs talk to each other like Macs.
- **QuickDraw period-art experiments.** 1-bit dithered glyphs,
  patterns, fills, the QuickDraw region calculus. The MacWeather
  app's `weather_glyphs.c` is exactly this — sun/cloud/rain icons
  drawn pixel-by-pixel with `MoveTo` + `Line` + `PaintRect`.
- **Anything where the aesthetic _is_ the message.** A System 7
  About box for your portfolio site. A 1-bit dithered headline. A
  "this looks like 1993 because it _is_ running 1993" demo. The
  emulator running real System 7 is the entire point.

### Compared to modern web/native dev

If you're coming from React + npm + WebGPU, here's the honest
trade.

**You give up:**

- **The GPU.** No WebGL, no WebGPU, no shaders. QuickDraw is
  software rendering at 1× a 640×480 framebuffer.
- **The npm ecosystem.** No `npm install left-pad`. Your
  dependencies are: the Mac Toolbox (frozen 1993), Retro68's
  RIncludes, what you write yourself in C.
- **RAM.** ~16 MB for the whole guest Mac. Each app gets a
  partition declared in `SIZE -1`; Reader runs with ~512KB
  preferred. There is no garbage collector, no
  malloc-without-thinking-about-it.
- **Build speed.** The 68k cross-compile in CI is ~3-4 minutes end
  to end. The in-browser Rez loop is ~1s for resource edits;
  **the in-browser C compile loop is ~1.5s warm** (cold first-click
  is ~3-5s for the lazy-load of the 3.9 MB brotli toolchain). For
  the bundled boot-disk apps (Reader, MacWeather, etc.) C source
  changes still go through CI — they're built into the boot disk
  before the page boots. For in-browser projects like `wasm-hello`,
  everything is in-tab.
- **`console.log`.** No stdout in System 7. Debugging is
  `DebugStr`, `MoveTo` + `DrawString` to a debug window, or
  recompile-and-launch.
- **POSIX file I/O.** Files have a data fork _and_ a resource
  fork. `fopen` doesn't exist. You use `HOpen`, `FSRead`,
  `FSWrite` against `FSSpec`s.

**You keep:**

- **A modern editing experience.** CodeMirror 6 with C
  highlighting, IndexedDB persistence, download-as-zip. Edit in
  the same tab as the running Mac.
- **A real CI pipeline.** Push to `main`, GitHub Actions runs
  Retro68 in a container, builds the boot disk with `hfsutils`,
  Vite-builds the page, deploys to Pages. ~3-4 minutes end to end.
- **The URL-anyone-can-visit endpoint.** No "send me your
  binary," no "pull my repo and run `make`," no "install
  Mini vMac and download a ROM." Just a link.

### Compared to "real" classic Mac development

If you want to do this _properly_, the established paths today are:

- **Full local emulator + classic IDE.** Mini vMac or BasiliskII
  on your real machine, hosting CodeWarrior, Think C, or MPW from
  inside a System 7 / Mac OS 8 boot disk you keep around. This is
  what the Mac dev community used in 1995 and it still works.
  Massive APIs, real debugger, real linker, full Inside Macintosh.
- **Retro68 + your own toolchain.** Cross-compile from modern
  Linux/macOS using [Retro68](https://github.com/autc04/Retro68)
  (which is what this project's CI uses), then test in a local
  emulator. Full control, headless CI-friendly, no in-browser
  constraints. You can build apps of any size.

**Where this project sits on that spectrum:** a _playground_, not
a dev environment. You can poke at and rebuild the resource fork
of a tightly-scoped sample app with a ~1-second loop, in a single
browser tab, with zero install. That's the differentiator.

What you **can't** do here today:

- ~~**Edit C source and recompile from scratch in-browser.**~~
  This used to be "killed in Epic #19" — 4-9 engineer-months
  to port GCC + linker to WASM. **Shipped 2026-05-15** via a
  different path (wasm-compile Retro68's existing toolchain
  instead of porting GCC from scratch). For projects like
  `wasm-hello` you can now edit C source and rebuild end-to-end
  in the browser in ~1.5s. The bundled boot-disk apps still go
  through CI (their resource forks have CMake recipes the
  in-browser path doesn't yet handle) — see
  [#100](https://github.com/khawkins98/classic-vibe-mac/issues/100)
  for the mixed C + `.r` roadmap.
- **Multi-file C projects, mixed C + `.r` in one in-browser build.**
  Single C source file in, single MacBinary II out — the current
  limit of the in-browser pipeline. Multi-file support is the next
  step ([#100](https://github.com/khawkins98/classic-vibe-mac/issues/100)).
- **Debug with breakpoints.** No source-level debugger. Add
  `DrawString` calls or run the binary under MacsBug locally.
- **Use Inside Macintosh's full API surface interactively.** You
  have what Retro68's headers ship — most of QuickDraw, Toolbox,
  Memory Manager, File Manager. Less common managers (Sound,
  PowerPC native APIs, ColorSync, AppleScript) are absent or
  partial.
- **Ship apps over a few hundred KB.** Bundle size matters when
  the boot disk is part of the deploy. Multi-megabyte apps work
  but inflate the `.dsk` and slow first paint.
- **Talk to the network from the Mac side.** No TCP stack inside
  the guest — see Epic #12's graveyard in [`PLAYGROUND.md`](./PLAYGROUND.md#closed-epic-graveyard).
  The host JS does HTTP; the Mac reads files the host wrote.

If any of those constraints is a deal-breaker for what you're
building, the right answer is: fork this repo, keep the CI flow,
and use a local IDE alongside it. CI does the heavy lifting; the
in-browser playground becomes a _showcase_ for the result, not the
authoring environment.

---

## Part 3: Reading order for going deeper

If something above caught your interest, here's the path through
the rest of the docs:

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — Engineer-deep-dive.
  The boot pipeline, the SAB layout, the `:Shared:` two-way data
  flow, the chunked-disk format, the CI pipeline, the browser APIs
  we depend on. Read this if you want to modify the host-side TS
  or understand why the worker is structured the way it is.
- [`docs/PLAYGROUND.md`](./PLAYGROUND.md) — The playground design
  rationale (Epic #21), the five-reviewer pass that produced
  option 2F, the open child issues, and the closed-Epic graveyard
  (Epic #12 real-TCP, Epic #19 in-browser GCC — note that #19's
  *compilation* capability shipped 2026-05-15 via a different
  path; see § Epic #19 follow-up). Read this if you want to
  extend the editor or build pipeline, or before you propose
  anything that smells like "what if we just added a backend."
- [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc) —
  Sister repo. The wasm-built toolchain (cc1 + as + ld + Elf2Mac)
  consumed by the in-browser C compile path. Read this if you're
  modifying the toolchain itself or want to understand how
  Retro68 → WASM was approached.
- [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md) — Iterating locally.
  How to run the dev server, how to rebuild the boot disk, how to
  test against the chunked manifest, how to use the host-testable
  pure-C engines. Read this first if you're cloning the repo.
- [`docs/NETWORKING.md`](./NETWORKING.md) — Deploying and using the
  optional AppleTalk zone relay.
- [`docs/AGENT-PROCESS.md`](./AGENT-PROCESS.md) — The
  agent-driven workflow this project has converged on (the
  five-reviewer pass for Epics, the CI-as-source-of-truth rule).
  Useful context if you want to understand how design decisions
  get made here.
- [`LEARNINGS.md`](../LEARNINGS.md) — Running gotcha log.
  `modelid 30`, BNDL/FREF/ICN# raw bytes, COEP `credentialless` in
  dev, extfs surfacing as `Unix:`, the input-ring lock layout.
  Skim this before you debug anything weird.
- [`src/app/README.md`](../src/app/README.md) — Per-app
  explanation. How `add_application()` wires creator codes through
  Rez, how to add a new app to the boot disk, how the Toolbox
  shell + pure-C engine split works in practice.

That should be enough to get from "I read the doc on the home page"
to "I'm modifying the worker and the boot disk." Have fun. Don't
forget to read [`LEARNINGS.md`](../LEARNINGS.md) before you debug.
