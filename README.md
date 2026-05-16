# classic-vibe-mac

A 1993 Macintosh that lives at a URL — and lets you build apps for it
in the same tab. System 7.5.5 boots in your browser. Five demo apps
launch from Startup Items. Open the source panel and you can edit
them, hit Build, and the page returns a real `.bin`; hit Build & Run
and the Mac above reboots ~1s later with your edits applied, no
reload, no toolchain. **You can also write classic Mac C in the
browser and watch it compile end-to-end** — `cc1` + `as` + `ld` +
`Elf2Mac` are wasm-bundled, no install required (shipped 2026-05-15).
The full read / edit / compile / hot-load loop is live in production
today.

> **Two-repo project.** This repo ships the playground, demo apps,
> and the in-browser editor + emulator integration. The wasm
> toolchain it compiles your code with lives in a sibling repo,
> **[`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)** —
> Retro68's C compiler + binutils + Elf2Mac, Emscripten-compiled.
> That toolchain is also reusable on its own; nothing in
> `wasm-retro-cc` is cv-mac-specific.

## Live at

**https://khawkins98.github.io/classic-vibe-mac/**

## Reading paths

This README serves three different visitors:

- **[I'm curious — what is this?](#what-it-does)** Two-minute read.
  Screenshots, the live link, what's running where.
- **[I want to try it / build something with it](#try-it)** Step-by-step
  walkthrough from "open the URL" through "compile my own C code in
  the tab" through "fork it for my own app."
- **[I want to understand how it works or build on the platform itself](#build-on-it)**
  Pointers into the deeper docs: architecture, build pipeline, design
  rationale, dev process, gotchas.

## What it looks like

![Live deployed page: a Mac OS 7/8-style IDE with a top menubar (Apple / File / Edit / View / Special / Windows / Help, with a "cv-mac <hash>" build stamp and clock on the right), and four draggable WinBox panes. Left: Project picker with the current source files. Centre: Playground — Build / Build & Run / Download / Reset toolbar above a CodeMirror editor showing the bundled C source for the current sample. Right: Macintosh — System 7.5.5 booted in BasiliskII running Reader, MacWeather, Hello Mac, and Mini vMac Doc. Bottom right: Output panel with a Build Log tab capturing per-stage timings. Every WinBox carries Mac OS 8 Platinum chrome (striped titlebar with recessed paper title field, Platinum scrollbars).](public/screenshot-deployed.png)

The deployed page is three things on one screen, all running in the
visitor's tab:

- **The Mac** — System 7.5.5 booted on a WebAssembly Basilisk II. Five
  apps auto-launched from `:System Folder:Startup Items:` —
  **Reader**, **MacWeather**, **Hello Mac**, **Pixel Pad**, and
  **Markdown Viewer** — with Reader rendering HTML out of the boot
  disk's `:Shared:` folder and MacWeather rendering live forecast data
  the host page fetches from `open-meteo.org` and drops into the Mac
  via the extfs-mounted `:Unix:` volume.
- **The Read Me** — a period-styled hand-rolled System 7 window with
  the project's marketing copy. Below it, the shipped editor panel.
- **The editor** — CodeMirror 6 with C syntax highlighting, seeded
  with the same `reader.c` / `macweather.c` / `*.r` sources that
  built the apps running above. Edits persist in IndexedDB; Build
  downloads a fresh `.bin` (your edited resource fork spliced onto
  the CI-precompiled code fork); Build & Run reboots the Mac above
  with your edits in ~820ms warm. See [Status](#status).

## What it does

Two things, sequenced in that order:

- **Playground** — visit the live URL, open the source panel,
  read the C and Rez code that's running above it, edit it, watch
  your edits persist across reloads. The full loop is live: *read /
  edit / compile / hot-load / watch the Mac re-launch with your
  change* in ~820ms warm. Two compile paths:
  - **Resource fork edits** (`.r` files) → in-browser WASM-Rez
    compiles + splices onto a CI-precompiled `.code.bin`. The
    original Phase 2 path.
  - **Full C compilation** (`.c` files, no `.r` needed) →
    in-browser `cc1.wasm + as.wasm + ld.wasm + Elf2Mac.wasm`
    (Retro68's toolchain, wasm-built via
    [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc))
    produces a complete MacBinary II APPL from C source alone.
    Shipped 2026-05-15 as the `wasm-hello` demo; this was the
    capability Epic #19 had originally been closed as 4-9
    engineer-months but proved doable in ~2 weeks by
    wasm-compiling Retro68's existing binaries rather than
    porting GCC from scratch.
  Architecture rationale and the phase plan live in
  [`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md).
- **Template** — the same repo is structured so you can fork it,
  drop your own C source under `src/app/<your-app>/`, push, and
  GitHub Actions ships your binary running inside System 7.5.5 on
  your fork's GitHub Pages URL. The playground rides along with
  the deploy. See [Fork it for your own app](#fork-it-for-your-own-app)
  below.

The hard project constraint, which is worth stating up front because
it shapes every design choice: **everything runs as JavaScript in
the visitor's browser. No backend, no relay, no auth, no compile
service.** Two Epics that violated that constraint were closed after
review (#12 and #19); the playground (#21) is what survived as the
architecturally honest version. See
[`docs/ARCHITECTURE.md` § What we deliberately avoid](./docs/ARCHITECTURE.md#what-we-deliberately-avoid)
for the long version.

Six demo apps under `src/app/` — five baked into the boot disk by
CI, plus one in-browser-compile-only proof of concept:

- **Reader** (`CVMR`) — a classic-Mac HTML viewer in C with a URL
  bar. Reads HTML from `:Shared:` on the boot disk, can ask the host
  page to fetch CORS-permissive URLs into `:Unix:`, supports a
  sensible subset (headings, paragraphs, lists, bold/italic,
  monospace blocks, links between bundled files, common entities),
  demonstrates the Toolbox-shell + pure-C-engine split.
- **MacWeather** (`CVMW`) — a tiny live-data app. The host page
  polls `api.open-meteo.com` and writes the response into the Mac
  at `:Unix:weather.json`; MacWeather watches the file, parses
  the JSON in pure C, and draws current conditions plus a 3-day
  forecast with pixel-art QuickDraw glyphs.
- **Hello Mac** (`CVHM`) — the smallest possible Toolbox application:
  a single window with "Hello, World!" drawn in the middle, a Quit
  command, and nothing else. Start here if you're new to Toolbox
  programming; it's also the default playground sample you edit.
- **Pixel Pad** (`CVMP`) — a QuickDraw drawing app. Draw with the
  mouse; the host page shows a live PNG preview of your 64×64 1-bit
  canvas below the Mac, exported via the `:Unix:` extfs bridge.
- **Markdown Viewer** (`CVMD`) — reads `.md` files from `:Shared:`
  on the boot disk and renders them with a simple Markdown parser in
  C. Add your own `.md` files via the shared folder.
- **Wasm shelf** — nine in-browser-compile-only sample apps the
  playground picker surfaces. No CMake, no CI step. The user picks
  one, edits, clicks Build & Run, and the browser's wasm toolchain
  produces the `.bin` from C source alone and hot-loads it into the
  running Mac. The progression climbs in Toolbox surface, not in
  scale: *Wasm Hello* (DrawString) → *Wasm Hello Multi* (multi-file
  link) → *Wasm Hello Window* (WIND resource) → *Wasm Snake*
  (TickCount game loop) → *Wasm TextEdit* (TEHandle) → *Wasm Notepad*
  (MBAR + Cmd-key menus + scrap) → *Wasm Calculator* (hand-drawn
  FrameRoundRect buttons + PtInRect) → *Wasm Scribble* (StillDown /
  GetMouse / LineTo) → *Wasm ScrollWin* (NewControl + TrackControl).
  Full inventory + coverage matrix in
  [`src/app/README.md` § "Wasm-shelf samples"](./src/app/README.md#wasm-shelf-samples).

The first five coexist on the same boot disk; **the Wasm-shelf samples
are the in-browser-only path** (Build & Run in the playground; the
`.bin` hot-loads into the running Mac without ever leaving the tab).
`src/app/CMakeLists.txt` is a tiny aggregator; the boot-disk script
installs each `.bin` into `:System Folder:Startup Items:` (auto-launch
on boot) and `:Applications:` (re-launch from the desktop). Adding a
sixth boot-disk app is one directory plus one line — see
[`src/app/README.md`](./src/app/README.md). Adding a wasm-shelf
sample is similar but skips CMake entirely; the steps are listed in
[`src/app/README.md` § "Adding a wasm-shelf sample"](./src/app/README.md#adding-a-wasm-shelf-sample).

## Try it

### As a visitor (no install)

Open <https://khawkins98.github.io/classic-vibe-mac/>. Wait ~5-10s
on a warm cache for the first navigation to reload itself once
(the cross-origin-isolation service-worker shim needs one round
trip to install) and for the System 7.5.5 boot animation to
finish. All five demo apps will auto-launch.

Scroll past the Mac to the source panel. The C and Rez files for
all five apps are listed; clicking a file opens it in the editor.
Type into it. Reload the page — your edits are still there
(IndexedDB). Hit "Download as zip" to grab a snapshot of your
edits.

What works today: read, edit, persist, **Build** (runs Rez in
the browser against your edited resource fork, splices the output
onto the CI-precompiled code fork, downloads a complete MacBinary
`.bin`), **Build & Run** (hot-loads the result onto a synthetic
in-memory disk and re-spawns the emulator worker so your change
boots back into the Mac running above in ~820ms warm), download as
zip. See [Status](#status) for the full breakdown.

Something not working? See
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
for the symptom → cause → fix table.

### Locally (full template flow)

Three pieces have to land in `src/web/public/` before the page
boots fully — the BasiliskII WASM core + ROM, a bootable System
7.5.5 disk with both demo apps pre-installed, and a small
secondary `app.dsk` (the loader HEAD-checks for it). The compiled
Mac binaries themselves come from CI; building Retro68 from
source takes about an hour.

```sh
# One-time setup
brew install hfsutils                    # for HFS disk packing (macOS)
git clone https://github.com/khawkins98/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run fetch:emulator                   # BasiliskII.wasm + Quadra-650.rom

# Pull the latest compiled binaries from CI
gh run download \
  "$(gh run list --branch main --workflow Build --limit 1 \
       --json databaseId -q '.[0].databaseId')" \
  -D /tmp/cvm-artifact

ART="$(echo /tmp/cvm-artifact/classic-vibe-mac-*)"

# Build the bootable System 7.5.5 disk. All three apps go into the disk's
# Startup Items + :Applications:; src/web/public/shared/*.html gets
# baked into :Shared:.
bash scripts/build-boot-disk.sh \
  "$ART/build/reader/Reader.bin,$ART/build/macweather/MacWeather.bin" \
  src/web/public/system755-vibe.dsk

# Copy the secondary app.dsk too.
cp "$ART/dist/app.dsk" src/web/public/app.dsk

# Serve.
npm run dev
```

Open <http://localhost:5173/>. The Vite dev server already sets the
COOP/COEP headers BasiliskII needs for `SharedArrayBuffer`, so you
skip the service-worker reload dance the production GitHub Pages
deploy does.

If you skip the `gh run download` + `build-boot-disk.sh` steps the
page still loads — the loader falls into a stub state that renders
the chrome (and the editor) but no emulator. Useful for iterating
on the page itself.

### Building the Mac binary locally

If you want to compile the Mac binary yourself (rather than pulling
from CI), the fastest path is the same Docker image CI uses:

```sh
docker run --rm -v $PWD:/work -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
```

That writes one subdirectory per app under `build/` —
`build/reader/Reader.{bin,dsk,APPL}` and
`build/macweather/MacWeather.{bin,dsk,APPL}`. Feed the `.bin` paths
(comma-separated, in any order) into `scripts/build-boot-disk.sh`
the same way the CI flow above does.

For day-to-day iteration loops (fast unit-test cycle, slow
cross-compile cycle, CI ship cycle) and a recipe book of common
tasks and failure modes, see
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## How it works

A static GitHub Pages site ships HTML + JS + WASM + a chunked HFS
disk image. The page registers a service-worker shim for cross-origin
isolation, spawns a Web Worker, the worker pulls down BasiliskII's
WASM core, instantiates it against the chunked boot disk, and the
1993 Macintosh comes up in the visitor's tab. The same page also
mounts a CodeMirror-based editor that reads sample C / Rez source
out of `src/web/public/sample-projects/` (copied at Vite build time
from `src/app/`), persists edits in IndexedDB, and exposes a
download-as-zip path.

The data flow is bidirectional but disciplined: **JS owns the
network**, Mac owns rendering and the event loop. The weather
poller hits `open-meteo.com` from the page's main thread and ships
JSON into the worker; MacWeather watches a file modtime and
redraws. There is no general-purpose socket inside the Mac. The
opt-in AppleTalk/Ethernet path is `?zone=<name>`: `src/web/src/ethernet-provider.ts`
bridges the emulator worker to a Cloudflare Durable Object relay in
`worker/`.

For the byte-by-byte version — boot pipeline, SharedArrayBuffer
layout, the four-state input lock, the chunked disk reader, the
two-way `:Shared:` data flow, the multi-app model — see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). For why the
playground is shaped this way (Rez-in-WASM, no backend, no auth,
no GCC port), see
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md).

## Iterating on it

Four loops, fastest first. Pick the fastest one that exercises your
change.

1. **In-browser (sub-second, no install).** Open the live page, edit
   `.c` or `.r` source in the playground, click Build & Run. The
   page compiles your edits in-browser and hot-loads the result into
   the running Mac in ~1s. New since 2026-05-15 — see
   [§ Try the in-browser compile-and-run flow](#try-the-in-browser-compile-and-run-flow).
2. **Fast (sub-second, host gcc).** Edit pure-C engine, run
   `npm run test:unit`. No emulator, no browser. The Toolbox-shell +
   pure-C-engine split means most app logic is testable on the host.
3. **Slow (~1-3 min, cross-compile).** Edit Toolbox shell or
   resource fork, cross-compile via the Retro68 Docker image (or
   pull the latest CI artifact), rebuild the boot disk, hard-reload
   the dev server. Use when you're changing the bundled boot-disk
   apps (Reader, MacWeather, etc.), not just the in-browser ones.
4. **Slowest (~5-10 min, deploy).** Push, let CI build, deploy
   lands on Pages.

The full walkthrough — first-time setup, all four loop variants,
common-task recipes, common failure modes mapped to fixes — is in
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md). The architectural
pattern the apps follow (and the rationale for the split) is in
[`src/app/README.md`](./src/app/README.md).

The dev process this project has converged on (the five-reviewer
red-flag pass that killed Epics #12 and #19 and produced #21) is
documented in [`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md).

## Status

The playground is **feature-complete on the main editor + build + run
loop**. Highlights of what's shipped on `main` today:

- Phase 1 (editor + IndexedDB persistence) + Phase 2 (in-browser Rez
  compilation) + Phase 3 (hot-load into the running Mac in ~820ms
  warm) — all live in production since 2026-05-09.
- **In-browser C compilation** (cc1 + as + ld + Elf2Mac wasm-bundled,
  produced from Retro68 via [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc))
  — shipped 2026-05-15. End-to-end Build & Run on
  `wasm-hello/hello.c` boots cleanly in BasiliskII; "Hello, World!"
  rendered via `DrawString`. First time anyone has compiled classic
  Mac C in a tab and watched it launch.
- Five baked-in demo apps (Reader, MacWeather, Hello Mac, Pixel
  Pad, Markdown Viewer) + a nine-sample wasm shelf (Wasm Hello,
  Hello Multi, Hello Window, Snake, TextEdit, Notepad, Calculator,
  Scribble, ScrollWin) the playground picker surfaces for
  in-browser editing.
- Opt-in AppleTalk/Ethernet zone networking via `?zone=`.

The canonical shipped-state checklist — what's live, what's
closed-Epic, what's next — lives in
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md#status). The
forward-looking roadmap for the in-browser C path is in
[#100](https://github.com/khawkins98/classic-vibe-mac/issues/100)
(multi-file C, mixed C + `.r`, backend abstraction for future
target ports).

## Recently shipped

- **In-browser C compilation end-to-end** (2026-05-15). The wasm
  toolchain (cc1 + as + ld + Elf2Mac, built from Retro68 via
  [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc))
  compiles `wasm-hello/hello.c` in the tab and boots it cleanly in
  BasiliskII. Originally estimated as 4-9 engineer-months (and
  closed as Epic #19 on that basis); shipped in ~2 weeks via a
  different path — wasm-compile the existing Retro68 binaries and
  orchestrate from JavaScript instead of porting GCC from scratch.
  See [LEARNINGS Key Story #6](./LEARNINGS.md) for the
  closed-as-infeasible-but-actually-possible retrospective.
- **The "coming soon" slate** (early 2026) is now live: Pixel Pad,
  Markdown Viewer, the Reader URL bar, and the opt-in
  AppleTalk/Ethernet relay all shipped.

For the current status table, see
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md#status).

## Fork it for your own app

The repo is still a GitHub template. The playground rides along
with the deploy.

1. **Fork** this repository (or click "Use this template" on
   GitHub).
2. **Replace `src/app/<your-app>/`** with your own C source. Keep
   the Toolbox-shell + pure-C-engine split. Each app needs its
   own four-letter creator code, its own `add_application(...)`
   call, and its own resource fork. See
   [`src/app/README.md` § How to add a new app](./src/app/README.md#how-to-add-a-new-app).
3. **Add it to the boot disk.** One `add_subdirectory(<your-app>)`
   line in `src/app/CMakeLists.txt`; one entry in CI's invocation
   of `scripts/build-boot-disk.sh`.
4. **Push to `main`.** GitHub Actions builds the binary, packs the
   disk image, and (when the deploy job lands) publishes the
   result to GitHub Pages.
5. **Open your repo's Pages URL.** Your app, in the browser, on
   a Mac. Visitors get the playground for free.

The web layer in `src/web/` doesn't usually need touching — it's
the container the OS boots in. Edit it if you want a different
page chrome around the emulator.

## Build on it

Pointers for the third reader path — *I want to understand how it
works, modify the platform, or extend it.* Suggested reading order:

1. **[`docs/HOW-IT-WORKS.md`](./docs/HOW-IT-WORKS.md)** — Guided
   tour. From "you typed the URL" through "the Mac is running and
   the editor is seeded" to "you clicked Build and the new binary
   booted." One layer of abstraction below this README.
2. **[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)** — Engineer
   deep-dive. The boot pipeline, the SharedArrayBuffer layout, the
   four-state input lock, the chunked disk reader, the two-way
   `:Shared:` data flow, the multi-app model. Read this if you're
   going to modify the host TypeScript or worker.
3. **[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md)** — The
   playground's design rationale (Epic #21), the five-reviewer pass
   that produced it, the open child issues, and the closed-Epic
   graveyard. Read before proposing anything that smells like "what
   if we just added a backend."
4. **[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)** — Local
   iteration. The four loops (in-browser, host-test, cross-compile,
   deploy), first-time setup, common-task recipes, common failure
   modes → fixes. Start here if you're cloning the repo.
5. **[`src/app/README.md`](./src/app/README.md)** — Per-app
   anatomy. How `add_application()` wires creator codes through
   Rez, the Toolbox-shell + pure-C-engine split, how to add a new
   app to the boot disk.
6. **[`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md)** — The
   five-reviewer red-flag pass that catches "what if we just added
   a backend"-class proposals before they sink weeks. Useful if
   you're scoping new work.
7. **[`LEARNINGS.md`](./LEARNINGS.md)** — Running gotcha log + Key
   Stories. Skim this before you debug anything weird. Six Key
   Stories at the top are required reading for toolchain work.
8. **[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)** —
   Symptom → cause → fix table for the common things that break.
9. **[`docs/NETWORKING.md`](./docs/NETWORKING.md)** — Specialised:
   the opt-in AppleTalk zone relay.

For cross-repo context (the wasm toolchain itself), see
[`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc).

## Requirements

- A current desktop browser (Chrome, Firefox, Safari).
- For local development: Node 20+, npm, and `hfsutils` (`brew
  install hfsutils` on macOS, `apt-get install hfsutils` on
  Debian/Ubuntu).
- For local Mac binary builds: Docker (to run the Retro68 image)
  — or just pull the latest CI artifact, which is faster.
- The OS disk is downloaded once from archive.org during the
  boot-disk build; ROM and BasiliskII core come from Infinite
  Mac. None are bundled in this repository.

## Credits

Built on the work of others who did the heavy lifting:

- **[Retro68](https://github.com/autc04/Retro68)** by Wolfgang
  Thaller and contributors — the cross-compiler that makes 68k
  Mac binaries from modern source. MIT-style license.
- **[Infinite Mac](https://github.com/mihaip/infinite-mac)** by
  Mihai Parparita — Basilisk II and SheepShaver compiled to
  WebAssembly, plus the chunked disk-fetch infrastructure we lean
  on. Apache-2.0 (with the underlying BasiliskII core itself
  GPL-2.0; see NOTICE).
- **Basilisk II** by Christian Bauer and the open-source
  community — the 68k Mac emulator that all of this rides on.
  GPL-2.0.
- **System 7.5.5** by Apple Computer, freely redistributed since
  Apple's 2001 release.
- **CodeMirror 6** for the editor surface. MIT.
- **JSZip** for in-browser zip generation. MIT/GPL dual-licensed.
- **Susan Kare**, in spirit, for the icons that taught the world
  what computers were allowed to look like.

## License

MIT for our code. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE)
for the attribution stack: BasiliskII (GPL-2.0), Infinite Mac
(Apache-2.0), Retro68 (MIT-style), System 7.5.5 (Apple's 1998
free-redistribution release). When the emulator core ships next
to a deploy, its own LICENSE and NOTICE files travel with it.
