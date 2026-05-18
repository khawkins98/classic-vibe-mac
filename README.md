# classic-vibe-mac

A 1990s Macintosh in a browser tab — with a System 7-style IDE that
compiles classic Mac C straight to a `.bin` and boots it. **Open the
page, pick a sample, click Build & Run; the Mac wakes up with your
freshly-compiled app on the desktop.** `cc1` + `as` + `ld` + `Elf2Mac`
are all wasm-bundled — no install, no toolchain on your machine, no
backend. Edit the source in the page; hit Build & Run again; the Mac
reboots in ~1s with your changes. The full read / edit / compile /
hot-load loop is live in production today.

> **Two-repo project.** This repo ships the playground, demo apps,
> and the in-browser editor + emulator integration. The wasm
> toolchain it compiles your code with lives in a sibling repo,
> **[`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)** —
> Retro68's C compiler + binutils + Elf2Mac, Emscripten-compiled.
> That toolchain is also reusable on its own; nothing in
> `wasm-retro-cc` is cv-mac-specific.

## Live at

**https://khawkins98.github.io/classic-vibe-mac/** — the full
playground: 25 in-browser-buildable samples (a small
Toolbox-coverage ladder from one-line "Hello, World!" up to the
1992 game *Glypha III* port), edit-and-rebuild loop running, the
Mac wakes up the moment you click Build & Run.

Toolchain-only proof of life: **https://khawkins98.github.io/wasm-retro-cc/**
— compile a Toolbox `hello.c` straight through the four wasm tools
without booting an emulator. Useful when evaluating
[`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc) for
your own non-cv-mac use.

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

![Live deployed page: a Mac OS 8 Platinum-styled IDE with a top menubar (Apple / File / Edit / View / Special / Windows / Help, with a "cv-mac <hash>" build stamp and clock on the right), and four draggable WinBox panes tiled across the viewport. Top-left: Project picker listing the wasm-* sample shelf. Centre-left: Playground with syntax-highlighted C source. Top-right: Macintosh pane — on first paint shows a "Welcome to Macintosh — Pick a project and Build & Run" placeholder; after Build & Run, the Mac boots into System 7.5.5 with the user's freshly-built app on a secondary disk on the desktop. Bottom-right: Output panel with Build log + Console tabs.](public/screenshot-deployed.png)

The deployed page is the IDE first; the Mac is a build target the
IDE delivers into. Four docked panes:

- **The Project picker** (top-left) — 25 sample apps in a small
  Toolbox-coverage ladder, from one-line "Hello, World!" up through
  GWorld double-buffering, dialog managers, file I/O, custom icon
  resources, and (at the top of the ladder) the 1992 game *Glypha
  III* port. Pick one; it opens in the editor.
- **The Playground** (centre-left) — CodeMirror 6 with C syntax
  highlighting, a project tab bar, and per-project file persistence
  in IndexedDB. ⌘-click any Toolbox identifier to pin its
  Inside-Macintosh-style reference card. Edit and your changes
  survive reloads.
- **The Macintosh** (top-right) — empty until you click Build & Run.
  Shows a "Welcome to Macintosh — Pick a project and Build & Run"
  placeholder on first paint. When you build, the page compiles your
  source through wasm-cc1 → wasm-as → wasm-ld → wasm-Elf2Mac in your
  tab, packages the result as a MacBinary, hot-loads it onto a
  fresh secondary disk, and boots System 7.5.5 with your app's disk
  on the desktop. First boot ~15s cold; subsequent Build & Runs ~1s.
- **The Output panel** (bottom-right) — Build log mirrors `[cvm]`,
  `[build-c]`, `[asm]`, `[cvm-fetch]`, `[cvm-stats]` lines from the
  compile pipeline. Console tab surfaces `cvm_log()` output from
  your running Mac app (see [`cvm_log.h`](./src/app/wasm-debug-console/cvm_log.h)).

## What it does

Two things, sequenced in that order:

- **Playground** — visit the live URL, pick a sample from the
  project picker, read the C and Rez source in the editor, edit it,
  click Build & Run. The page compiles your edits through the wasm
  toolchain (`cc1.wasm` + `as.wasm` + `ld.wasm` + `Elf2Mac.wasm`,
  built from Retro68 via
  [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)),
  packages the result as a MacBinary, mounts it on a fresh secondary
  disk, and boots System 7.5.5 with your app's disk on the desktop.
  Subsequent Build & Runs reuse the cached toolchain and the warm
  boot disk and finish in ~1 second. Edits persist in IndexedDB.
  Architecture rationale and the phase plan live in
  [`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md).
- **Template** — the same repo is structured so you can fork it,
  add your own sample under `src/app/wasm-<your-name>/`, register
  it in `src/web/src/playground/types.ts`, push, and your sample
  shows up in the picker on your fork's GitHub Pages URL. The
  playground rides along with the deploy. See
  [Fork it for your own app](#fork-it-for-your-own-app) below.

The hard project constraint, which is worth stating up front because
it shapes every design choice: **everything runs as JavaScript in
the visitor's browser. No backend, no relay, no auth, no compile
service.** Two Epics that violated that constraint were closed after
review (#12 and #19); the playground (#21) is what survived as the
architecturally honest version. See
[`docs/ARCHITECTURE.md` § What we deliberately avoid](./docs/ARCHITECTURE.md#what-we-deliberately-avoid)
for the long version.

### The sample shelf

25 small-to-medium classic Mac apps under `src/app/wasm-*/`. The
playground picker surfaces all of them with a complexity rating
(★☆☆☆☆☆ → ★★★★★★) so visitors can pick an on-ramp matched to their
comfort level. Highlights:

- **Wasm Hello** — `DrawString` only. The "this is what a Mac app
  looks like at absolute minimum" rung. Default selection.
- **Wasm Clock** — analog face + digital readout with `GetDateTime`,
  `FrameOval`, hand-drawn trig table. Pure QuickDraw.
- **Wasm Files** — `StandardGetFile` / `StandardPutFile`,
  `FSpCreate`, `FSWrite`. The "talk to disk" rung.
- **Wasm Bounce** — offscreen `BitMap` + `CopyBits` double-buffer.
  No flicker, exactly the way it was done in 1989. Also instruments
  itself with `cvm_log()` so the Console tab in the IDE shows live
  ball-position trace as it plays.
- **Wasm GWorld** — the modern System 7+ way to do the same thing
  (`NewGWorld`, `LockPixels`, `UpdateGWorld`).
- **Wasm Icon Gallery** ★★★★★★ — uses an external `.rsrc.bin`
  asset spliced into the disk image (the `binaryAssets` infra).
- **Debug Console demo** — the smallest possible exercise of
  `cvm_log()` / `cvm_log_p()` / `cvm_log_reset()`, the Mac-side
  API the IDE's Console tab picks up via a polled `:Unix:` file.
- **Glypha III** ★★★★★★ — John Calhoun's 1992 game, vendored
  whole. 6,600 LOC, nine .c files. The "real period app at scale"
  proof-of-feasibility for the compile pipeline. Won't actually
  render gameplay yet — its 2.7 MB upstream resource fork needs
  the fork-composition infrastructure tracked in
  [#280](https://github.com/khawkins98/classic-vibe-mac/issues/280) —
  but compiles + links + boots end-to-end through the playground
  in ~1 second once cached.

Full inventory + coverage matrix in
[`src/app/README.md`](./src/app/README.md). Adding a sample is a
new `src/app/wasm-<name>/` directory + a `SAMPLE_PROJECTS` entry
in `src/web/src/playground/types.ts` + a SEED_FILES entry in
`src/web/vite.config.ts` — no CMake, no CI step, no toolchain
install. The audit at `npm run audit:wasm-shelf` compiles every
sample headlessly on every PR so regressions surface at review
time, not at "user clicks Build."

## Try it

### As a visitor (no install)

Open <https://khawkins98.github.io/classic-vibe-mac/>. The IDE loads
in ~2 seconds: project picker on the left, editor in the middle,
Macintosh pane top-right showing a "Welcome to Macintosh — Pick a
project and Build & Run" placeholder, Output panel bottom-right.
The Mac doesn't actually boot until you ask it to — first build
fetches the boot disk + warms the wasm toolchain (~15s cold), so
the page stays fast for visitors who just want to read source.

Pick a sample from the project dropdown (default is *Wasm Hello* —
a one-window "Hello, World!"). Read the C source in the editor.
Hit **Build & Run**. The progress window shows you what's happening
(Preparing → Compiling → Packaging → Mounting → Booting); once boot
finishes, your app appears as a disk on the Mac's desktop —
double-click to launch.

Type into the editor. Reload the page — your edits are still there
(IndexedDB, per-project). Build & Run again, and the warm-cache
loop finishes in ~1 second. The Console tab in the Output panel
catches anything your app emits via
[`cvm_log()`](./src/app/wasm-debug-console/cvm_log.h) (the Mac-side
debug-log API) — useful for verifying your changes actually ran.

Something not working? See
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)
for the symptom → cause → fix table.

### Locally

```sh
# One-time setup
brew install hfsutils                    # for HFS disk packing (macOS)
git clone https://github.com/khawkins98/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run fetch:emulator                   # BasiliskII.wasm + Quadra-650.rom
```

Two paths from here, depending on whether you want the full boot
disk available or just the page chrome.

**Page-only** — fast (~5 seconds to first paint), no Docker needed,
no CI fetch. The Mac canvas shows the welcome placeholder forever
(no boot disk → no boot), but the IDE, the picker, the editor, the
Output panel, and the audit all work normally:

```sh
npm run dev               # → http://localhost:5173/
npm run audit:wasm-e2e    # compile every sample's .c + .r locally, no browser
npm run audit:wasm-e2e -- wasm-mdpad   # or just one
```

**Full deploy** — also includes the boot disk so Build & Run actually
launches the Mac. Pulls the boot disk from CI rather than rebuilding
it from scratch (the boot disk build needs `hfsutils` + the
upstream System 7.5.5 image; CI handles both):

```sh
gh run download \
  "$(gh run list --branch main --workflow Build --limit 1 \
       --json databaseId -q '.[0].databaseId')" \
  -D /tmp/cvm-artifact

ART="$(echo /tmp/cvm-artifact/classic-vibe-mac-*)"
cp "$ART/system755-vibe.dsk" src/web/public/
cp "$ART/system755-vibe.dsk.json" src/web/public/
cp -R "$ART/system755-vibe-chunks" src/web/public/

npm run dev      # → http://localhost:5173/
```

Open <http://localhost:5173/>. The Vite dev server already sets the
COOP/COEP headers BasiliskII needs for `SharedArrayBuffer`, so you
skip the service-worker reload dance the production GitHub Pages
deploy does.

For day-to-day iteration loops (fast unit-test cycle, in-browser
edit cycle, CI ship cycle), see
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md).

## How it works

A static GitHub Pages site ships HTML + JS + WASM + a chunked HFS
disk image. The page registers a service-worker shim for cross-origin
isolation, mounts a CodeMirror-based editor seeded with the sample
shelf, and parks the Mac canvas at a welcome placeholder. When the
user clicks Build & Run, the page hands the active project's source
to wasm-cc1, runs the four-stage pipeline (cc1 → as → ld → Elf2Mac),
splices a SIZE resource onto the output, patches a fresh HFS template
with the resulting MacBinary, spawns a Web Worker, and instantiates
BasiliskII against the boot disk + the just-built secondary disk.
Mac comes up; your app's disk is on the desktop.

The data flow is bidirectional but disciplined: **JS owns the
network**, Mac owns rendering and the event loop. The runtime
back-channel is a mounted extfs volume (the Mac sees it as
`:Unix:`); the Mac can read host-seeded files there and write back
(e.g. `cvm_log()` lands in `:Unix:__cvm_console.log` which the host
polls into the Output panel's Console tab). There is no
general-purpose socket inside the Mac. The opt-in AppleTalk/Ethernet
path is `?zone=<name>`: `src/web/src/ethernet-provider.ts` bridges
the emulator worker to a Cloudflare Durable Object relay in `worker/`.

For the byte-by-byte version — boot pipeline, SharedArrayBuffer
layout, the four-state input lock, the chunked disk reader, the
two-way `:Shared:` data flow, the multi-app model — see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). For why the
playground is shaped this way (Rez-in-WASM, no backend, no auth,
no GCC port), see
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md).

## Iterating on it

Three loops, fastest first. Pick the fastest one that exercises your
change.

1. **In-browser (sub-second warm, no install).** Open the live page,
   edit a sample's source in the playground, click Build & Run. The
   page compiles your edits in-browser and hot-loads the result into
   the Mac in ~1s.
2. **Audit + host tests (couple seconds).** `npm run audit:wasm-shelf`
   compiles every sample headlessly via the same wasm-cc1 the browser
   uses. `npm run test:unit` runs the JS preprocessor + HFS-patcher
   suites. Catches compile + structural regressions before push.
3. **CI deploy (~5-10 min).** Push, let CI build, deploy lands on
   Pages.

There's no cross-compile loop any more — every app the playground
ships compiles in the browser. The CMake aggregator under `src/app/`
is empty scaffolding for any future host-native build; today it
configures + builds nothing.

The full walkthrough — first-time setup, all four loop variants,
common-task recipes, common failure modes mapped to fixes — is in
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md). The architectural
pattern the apps follow (and the rationale for the split) is in
[`src/app/README.md`](./src/app/README.md).

The dev process this project has converged on (the five-reviewer
red-flag pass that killed Epics #12 and #19 and produced #21) is
documented in [`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md).

## Status

The playground is **feature-complete on the main editor + build +
run loop**. Highlights of what's shipped on `main` today:

- **End-to-end in-browser C compilation** (cc1 + as + ld + Elf2Mac
  all wasm-bundled, produced from Retro68 via
  [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)).
  Build & Run on any sample boots the result cleanly in BasiliskII.
  First time anyone has compiled classic Mac C in a tab and watched
  it launch.
- **25-sample shelf** under `src/app/wasm-*/`, climbing from a
  one-line "Hello, World!" up through GWorld double-buffering,
  modal dialogs, file I/O, custom resource fork assets, and (at
  the top) the 6,600-LOC 1992 game *Glypha III*.
- **Deferred-boot UX** — the Mac canvas shows a welcome placeholder
  on first paint; boots into System 7.5.5 with your freshly-built
  app's disk on the desktop when you click Build & Run. Page load
  is fast (no boot disk fetch); the IDE is the product, the Mac is
  a build target.
- **Mac OS 8-style build progress window** while compile/boot
  happens, with per-phase timing, a slow-compile reassurance hint
  (>15s in Compiling reveals "why so slow"), and per-stage
  diagnostics.
- **Debug Console** — the Output panel's Console tab surfaces
  Mac-side `cvm_log()` output in near-real-time via a polled
  extfs back-channel. `cvm_log.h` is mounted as a system header so
  any sample can `#include <cvm_log.h>` without bundling.
- **Opt-in AppleTalk/Ethernet zone networking** via `?zone=`.

The canonical shipped-state checklist — what's live, what's
closed-Epic, what's next — lives in
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md#status). The current
forward-looking work is in
[#280 (asset-handling architecture)](https://github.com/khawkins98/classic-vibe-mac/issues/280)
and [#256 (Glypha gameplay needs the resource fork)](https://github.com/khawkins98/classic-vibe-mac/issues/256).

## Recently shipped

- **Deferred-boot IDE** (2026-05-17, #279). Mac doesn't auto-boot
  on page load; canvas shows a welcome placeholder until first
  Build & Run. Page load went from "25 MB boot disk + 15s of cold
  boot before the visitor can do anything" to "IDE in 2 seconds,
  Mac only when asked for."
- **Precompiled-path retirement** (2026-05-17, #276 → #277 / #278).
  The legacy auto-launching demo apps (Reader, MacWeather, Hello
  Mac, Pixel Pad, Markdown Viewer) were retired wholesale; the
  in-browser pipeline is now the only path. ~9,000 LOC of
  scaffolding gone.
- **Glypha III onboarding** (2026-05-16, #255). First third-party
  period app on the shelf — 6,600 LOC, John Calhoun's 1992 game,
  vendored whole. Compiles + links + boots through the playground
  in ~1 second (cached). Actual gameplay still needs the resource
  fork; tracked in #256 + #280.
- **Debug Console tab** (2026-05-16, #261). `cvm_log()` API +
  watcher pipeline. Originally the "Coming soon" placeholder under
  Output → Console; now live with unread indicators and a system
  header so any sample can use it.
- **Output panel improvements** (2026-05-16, #258 / #259 / #274).
  Copy button, fetch-time breakdown in stats, Mac OS 8-style build
  progress window with slow-compile hint.
- **Compile pipeline refactor chain** (2026-05-17, #267 → #270 /
  #273). One canonical pipeline runner shared between the in-browser
  Build path and the Node-side CI audit; no more "compile flag bump
  in one place, drift in the other."
- **GPL-3.0 relicense** (2026-05-17, #281). Aligned with upstream
  inheritance (BasiliskII GPL-2.0+, Retro68 GCC/binutils GPL-2.0+ /
  GPL-3.0+). The MIT declaration we shipped was inaccurate the
  moment the in-browser compiler started redistributing wasm-
  compiled GCC/binutils binaries.

For the current status table, see
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md#status).

## Fork it for your own app

The repo is still a GitHub template. The playground rides along
with the deploy.

1. **Fork** this repository (or click "Use this template" on
   GitHub).
2. **Add `src/app/wasm-<your-app>/`** with your own C source. At
   minimum: one `.c` file with a `main()` and one `.r` file (SIZE,
   WIND if you want a window, signature data). Pick a 4-letter
   creator code. See
   [`src/app/README.md` § How to add a new app](./src/app/README.md#how-to-add-a-new-app).
3. **Register the sample.** Two short entries:
   - `src/web/src/playground/types.ts` → push a `SampleProject`
     entry (id, label, files, rezFile, outputName, appType,
     appCreator, complexity).
   - `src/web/vite.config.ts` → push the same files into the
     `SEED_FILES` map so they get copied into the playground bundle.
4. **Verify locally.** `npm run audit:wasm-shelf` compiles your
   new sample alongside the other 25. If it goes green, the
   browser-side Build will too.
5. **Push to `main`.** GitHub Actions builds the bundle (no
   cross-compile step — the wasm toolchain ships in the bundle)
   and publishes to GitHub Pages.
6. **Open your repo's Pages URL.** Your sample shows up in the
   playground picker. Visitors pick it, edit it, and Build & Run
   produces a working Mac binary running in their tab.

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
  Mac binaries from modern source. Mixed licensing reflecting its
  GCC / binutils heritage (GPL-2.0+ and GPL-3.0+); the
  cc1 / as / ld / Elf2Mac binaries cv-mac vendors via
  [wasm-retro-cc](https://github.com/khawkins98/wasm-retro-cc)
  redistribute GPL-licensed code. See NOTICE for the chain.
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

**GPL-3.0-or-later** for our code. See [LICENSE](./LICENSE) and
[NOTICE](./NOTICE) for the full attribution stack, including:
BasiliskII (GPL-2.0+), Infinite Mac (Apache-2.0), Retro68
(GPL-2.0+ / GPL-3.0+ for its GCC / binutils-derived parts),
System 7.5.5 (Apple's 1998 free-redistribution release). When
the emulator core ships next to a deploy, its own LICENSE and
NOTICE files travel with it.

> **A note on what GPLv3 does and doesn't cover.** This project —
> the emulator wrapper, the IDE, the build infrastructure — is
> GPL-3.0-or-later. If you fork or modify *this project*, your
> fork is GPLv3-bound. **However**, classic Mac apps you write
> *using* the playground and compile with the bundled toolchain
> are entirely your own work. The compiler's license governs the
> compiler, not its output — the same way a code editor's license
> doesn't apply to what you type into it. License your own apps
> however you want.
