# How It Works

_Last updated: 2026-05-09._

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

### 6. Below the desktop, the playground editor seeds itself

Below the emulator pane sits a CodeMirror 6 editor (minimalSetup +
the C language pack). On first load it copies the canonical sample
project from `src/web/public/sample-projects/` into IndexedDB; on
subsequent loads it rehydrates from IDB so the visitor's edits
survive reloads. UI state (open file, cursor position) is persisted
on a 1s debounce. Mobile hides the editor with an "open in desktop
browser" message. See [`PLAYGROUND.md`](./PLAYGROUND.md) Phase 1.

### 7. Build & Run: edit a `.r` file, see the change in ~1 second

Click Build. The page:

1. Reads the edited `.r` from IndexedDB.
2. Runs a TypeScript-side preprocessor (`#include`, `#define`,
   `#if`).
3. Hands the preprocessed Rez source to a ~100KB WASM build of the
   classic Apple Rez compiler (`tools/wasm-rez/` → `src/web/public/wasm-rez/`).
4. Splices the resulting resource fork onto the CI-precompiled
   `.code.bin` (the data fork stays untouched).
5. Patches the new MacBinary into an in-memory HFS disk image (a
   template-splice path: ship one empty `.dsk` as a CI artifact,
   patch the catalog leaf + bitmap + MDB to insert one file).
6. Calls the worker's `dispose()` + `boot()` to re-spawn BasiliskII
   on the new disk.

Warm round trip: **~820ms in production today**, well under the
"sub-second" goal. First click after page load is ~1.5s (WASM-Rez
instantiation + RIncludes parse).

That's the loop. Edit a string, watch the Mac re-launch with your
change. Single tab, no install, no auth, no server.

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
  to end. The in-browser Rez loop is ~1s, but that's _resource
  edits only_. C source changes go through CI.
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

- **Edit C source and recompile from scratch in-browser.** Killed
  in [Epic #19](https://github.com/khawkins98/classic-vibe-mac/issues/19).
  Porting GCC + linker to WASM is 4-9 engineer-months. Today, C
  source changes go through `git push` → CI (~3-4 min).
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
  (Epic #12 real-TCP, Epic #19 in-browser GCC). Read this if you
  want to extend the editor or build pipeline, or before you
  propose anything that smells like "what if we just added a
  backend."
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
