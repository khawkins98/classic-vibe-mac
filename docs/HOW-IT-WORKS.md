# How It Works

_Last updated: 2026-09-24._

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
spawns `emulator-worker.ts` as a `type: 'module'` Web Worker. The
canvas stays on the main thread: a `requestAnimationFrame` loop copies
the worker's SAB framebuffer into an `ImageData` and `putImageData`s
it.

### 4. Worker boots BasiliskII against System 7.5.5

The worker allocates three SharedArrayBuffers — video framebuffer,
videoMode metadata, and a 400-byte (100 × Int32) input ring whose offsets match
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
|     :System Folder:Startup Items: (empty — visitor    |
|       picks a sample and clicks Build & Run; the      |
|       compiled .bin mounts on a fresh secondary disk) |
+-------------------------------------------------------+
```

### 5. The user picks a sample and clicks Build & Run

The Mac canvas opens in a "Welcome to Macintosh" placeholder
(deferred-boot UX, #279). No app auto-launches on first paint — the
visitor picks a sample from the picker on the left, hits **Build &
Run**, and only then does the System 7 boot sequence kick off with
the sample's freshly-compiled `.bin` on a secondary disk that mounts
alongside the System disk. Subsequent Build & Runs reuse the warm
boot disk and finish in ~1 second.

26 wasm-* samples ship today — a Toolbox-surface ladder from
`wasm-hello` (one `DrawString`) through `wasm-mdpad` (split-pane
Markdown editor + live preview) up to `wasm-glypha3` (John Calhoun's
1992 arcade game, ~6,300 lines of C across nine files plus a 2.7 MB
upstream `.r`, vendored whole). Each sample is a
self-contained subdirectory under `src/app/wasm-<name>/` with C
source + an optional `.r` resource file + occasionally a precompiled
binary resource file shipped beside the app (`binaryAssets`, e.g.
`wasm-icon-gallery`'s `icons.rsrc.bin`). See
[`src/app/README.md`](../src/app/README.md) for the per-sample
matrix.

The simplest Mac→host data bridge in the repo is the
[`cvm_log`](../src/app/wasm-debug-console/cvm_log.h) Debug Console:
samples write log lines through extfs to `:Unix:__cvm_console.log`
and the Output panel's Console tab polls + surfaces them. The
`wasm-bounce` sample uses it to live-trace ball positions; the
recipe is documented in
[`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md)
Recipe 1.

The same `:Shared:` / `:Unix:` pattern handles the modern-Markdown
round-trip in `wasm-mdpad` (#305) — File → Save lands a `.md` file
on the host, with CR→LF translation at the boundary.

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

The CodeMirror editor inside Playground seeds from
`/sample-projects/<project>/<file>` on first load (a Vite plugin in
`src/web/vite.config.ts` copies those out of `src/app/wasm-*/` at
build time; they aren't checked in) and rehydrates from
IndexedDB on subsequent loads, so edits survive reloads. Editor
niceties land via the standard CodeMirror 6 extension stack:
syntax highlighting for `.c` and `.r` (warm earth-tone palette
matching the m68k assembly viewer), bracket matching, auto-close
brackets/parens/quotes, fold gutter for collapsing functions and
`#if 0` blocks, indent-on-input, active-line highlight, and
selection-match highlighting. ⌘F opens the search panel; ⌘G /
⇧⌘G walk matches; ⌘⌥F switches to find-and-replace. UI state
(open file, cursor position) is persisted on a 1 s debounce.
Build Log entries are clickable — click a `file:line:col`
diagnostic to jump the editor's cursor there. See
[`PLAYGROUND.md`](./PLAYGROUND.md) Phase 1.

Hover a Toolbox call (`NewGWorld`, `WaitNextEvent`, `TEKey`, etc.)
and a Mac-OS-8-styled card pops with the Inside-Macintosh
signature, a one-paragraph description, and a "See also" list.
⌘-click the same call to open a pinned WinBox reference window
with clickable See-Also navigation — same data, persistent. Also
reachable from <em>Help → Toolbox Reference…</em>. Coverage is
~80 entries today (the Toolbox surface the bundled
<code>wasm-*</code> samples actually touch); adding entries is a
one-line edit to
[`src/web/src/playground/toolbox-reference.json`](../src/web/src/playground/toolbox-reference.json).

Per-build telemetry surfaces as `[build-c] …` lines (per-stage cc1
/ as / ld / Elf2Mac timings) and a `[cvm-stats] session: N builds,
Xs spent compiling (avg Yms), Z cache hits (saved Ws)` summary
after every build, so the in-memory build artefact cache's
session-level payoff is observable.

### 7. Build & Run: the full toolchain runs in the tab

Click Build. For the project open in the editor, the page:

1. Collects the project's `.c`/`.h` files: the open file straight
   from the editor buffer, the rest from IndexedDB (seeded from the
   bundled defaults on first touch).
2. Compiles every `.c` through the in-browser toolchain
   ([wasm-retro-cc](https://github.com/khawkins98/wasm-retro-cc)'s
   Retro68 GCC ported to wasm): cc1 → as → ld → Elf2Mac, yielding a
   complete MacBinary II APPL.
3. If the project has an `.r` file (most do — `wasm-hello-window`,
   `wasm-snake`, `wasm-textedit`, `wasm-mdpad`, `wasm-glypha3`, etc),
   runs it through a small TypeScript preprocessor (`preprocessor.ts`,
   for `.r` files only; cc1 does its own C preprocessing), compiles
   it through the ~100 KB Apple Rez wasm, and splices the
   resulting resource fork over the C-built fork — user resources
   (WIND, MENU, SIZE) win on (type, id) collision. Vendored apps
   can also declare a precompiled resource bundle (`precompiledForkAssets`
   in `SAMPLE_PROJECTS`) that gets merged in underneath the user's
   fork; no sample uses it today — see
   [`ARCHITECTURE.md`'s vendored-app section](./ARCHITECTURE.md#vendored-app-fork-composition-pathb).
4. Patches the merged MacBinary into an in-memory HFS disk image
   (template-splice path: fetch the committed
   `playground/empty-secondary.dsk`, patch the catalog leaf + bitmap +
   MDB to insert one file; see `hfs-patcher.ts`). Any `binaryAssets`
   the project declares go onto the same disk as separate files.
5. Hands the disk bytes to the emulator handle's `boot()` (in
   `emulator-loader.ts`), which terminates the running worker outright
   and spawns a fresh one with the new disk mounted as a secondary.

For a resource-only edit the warm round trip was measured at
**~820 ms**; first click after page load is ~1.5 s (WASM-Rez
instantiation + RIncludes parse). When C changed too, expect the
~1.5 s warm figure in the next section. An unchanged C source set
skips the compile entirely: `editor.ts` keeps an in-memory cache
(`cBuildCache`) keyed on a SHA-256 of the sources + optimisation
level, which is where the `[cvm-stats]` "cache hits" come from.

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
   the `.r` path uses, then `boot()`s the emulator on the result.

Warm round trip: **~1.5s** (cc1+as+ld+Elf2Mac runs in 30-50ms
total once the modules are loaded; the rest is HFS-patch + worker
respawn). Cold first-click: ~3-5s (lazy-load the toolchain).

The entry point is `compileToBin()` in
`src/web/src/playground/cc1.ts`, which takes a list of source files,
so multi-file projects like `wasm-glypha3` go through the same path
(#100). It loads the wasm modules and hands the per-stage sequencing
to `runCompilePipeline()` in `compilePipeline.mjs` (#271), which is
plain JS so the Node-side audit scripts can drive the same code.
`toolchain.ts` wraps all of this behind a small backend interface
(`getToolchain()`, one `retro68-68k` entry today) so a second
toolchain could slot in later. The wasm modules themselves come from
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
  from `Inside Macintosh`. Most samples on the shelf land in the
  12-18 KB range — `wasm-clock`, `wasm-calculator`, `wasm-dialog`
  are concrete examples. The upper end is `wasm-glypha3`, a vendored
  6,600-LOC period game that compiles to ~110 KB of code + a 540 KB
  resource fork.
- **Demo / portfolio apps you can link from a website.** "Here's a
  thing I made; click the URL, it boots in your browser, no
  install." That's the whole pitch. Great for talks, blog posts,
  job-application novelty links.
- **Educational pieces about classic Mac development.** Resource
  forks, the System 7 Toolbox, MacBinary, BNDL/FREF/ICN# Finder
  binding, the event loop — all visible and inspectable here in a
  way they're not on a real machine in a museum.
- **Interactive content rendered through the Mac.** A Markdown
  editor with live preview (`wasm-mdpad`), an HTML viewer (the retired
  Reader app parsed a tiny HTML subset and rendered it with QuickDraw),
  a Lisp REPL, a small game with arrow-key controls (`wasm-snake`,
  `wasm-arkanoid`). The Mac is the "screen" for content the host page
  hands it via extfs.
- **Peer-to-peer AppleTalk apps.** If you deploy the optional
  Cloudflare zone relay (see [`docs/NETWORKING.md`](./NETWORKING.md)),
  multiple visitors can join a shared zone for Mac-to-Mac networking.
  That keeps the internet-facing part on the host side while still
  letting the guest Macs talk to each other like Macs.
- **QuickDraw period-art experiments.** 1-bit dithered glyphs,
  patterns, fills, the QuickDraw region calculus. `wasm-patterns`
  and `wasm-scribble` are small examples; the retired MacWeather
  app drew its sun/cloud/rain icons pixel-by-pixel with `MoveTo` +
  `Line` + `PaintRect`.
- **Anything where the aesthetic _is_ the message.** A System 7
  About box for your portfolio site. A 1-bit dithered headline. A
  "this looks like the '90s because it _is_ running the '90s" demo. The
  emulator running real System 7 is the entire point.

### Compared to modern web/native dev

If you're coming from React + npm + WebGPU, here's the honest
trade.

**You give up:**

- **The GPU.** No WebGL, no WebGPU, no shaders. QuickDraw is
  software rendering at 1× a 640×480 framebuffer.
- **The npm ecosystem.** No `npm install left-pad`. Your
  dependencies are: the Mac Toolbox (frozen mid-90s), Retro68's
  RIncludes, what you write yourself in C.
- **RAM.** ~16 MB for the whole guest Mac. Each app gets a
  partition declared in `SIZE -1`; most shelf samples ask for a few
  hundred KB. There is no garbage collector, no
  malloc-without-thinking-about-it.
- **Build speed.** The in-browser Rez loop is ~1s for resource
  edits; **the in-browser C compile loop is ~1.5s warm** (cold
  first-click is ~3-5s for the lazy-load of the 3.9 MB brotli
  toolchain). Every sample on the shelf builds in-tab; the old
  CI-built boot-disk apps (Reader, MacWeather, etc.) retired in #276.
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
- **A real CI pipeline.** Push to `main`, GitHub Actions builds the
  (vanilla) boot disk with `hfsutils`, Vite-builds the page, deploys
  to Pages. ~3-4 minutes end to end.
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
a dev environment. You can edit the C and resources of a sample app
and rebuild it with a ~1-second loop, in a single
browser tab, with zero install. That's the differentiator.

What you **can't** do here today:

- ~~**Edit C source and recompile from scratch in-browser.**~~
  This used to be "killed in Epic #19" — 4-9 engineer-months
  to port GCC + linker to WASM. **Shipped 2026-05-15** via a
  different path (wasm-compile Retro68's existing toolchain
  instead of porting GCC from scratch). It started with
  `wasm-hello`; multi-file C plus a `.r` in one build landed under
  [#100](https://github.com/khawkins98/classic-vibe-mac/issues/100)
  (now closed), and the same path now builds `wasm-glypha3`, a
  vendored nine-file period game, in the tab.
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
- [`src/app/README.md`](../src/app/README.md) — Per-sample
  explanation. The wasm-shelf matrix, how to add a wasm-shelf sample,
  and the Toolbox shell + pure-C engine split. (It still carries
  sections on the retired CMake apps.)

That should be enough to get from "I read the doc on the home page"
to "I'm modifying the worker and the samples." Have fun. Don't
forget to read [`LEARNINGS.md`](../LEARNINGS.md) before you debug.
