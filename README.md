# classic-vibe-mac

A 1993 Macintosh that lives at a URL — and lets you build apps for it
in the same tab. System 7.5.5 boots in your browser. Three demo apps
launch. Open the source panel and you can edit them, hit Build, and
the page returns a real `.bin`; hit Build & Run and the Mac above
reboots ~1s later with your edits applied, no reload, no toolchain.
The full read / edit / compile / hot-load loop is live in production
today.

## Live at

**https://khawkins98.github.io/classic-vibe-mac/**

## What it looks like

![Live deployed page: a Mac System 7 desktop runs at the top with two demo apps open — Reader showing the :Shared: folder of bundled HTML pages, and MacWeather rendering current conditions plus a 3-day forecast in 1-bit pixel art. Below the desktop, a "classic-vibe-mac" Read Me window explains the project. Below that, a source-viewer panel lists the Mac apps' C and Rez files — the in-browser editor where visitors can read (and, increasingly, change) the same code that's running above.](public/screenshot-deployed.png)

The screenshot above is the deployed page right now. Three things on
one screen, all running in the visitor's tab:

- **The Mac** — System 7.5.5 booted on a WebAssembly Basilisk II. Two
  apps auto-launched from `:System Folder:Startup Items:` —
  **Reader** rendering HTML out of the boot disk's `:Shared:` folder,
  and **MacWeather** rendering live forecast data the host page is
  fetching from `open-meteo.org` and dropping into the Mac via the
  extfs-mounted `:Unix:` volume.
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
  edit / compile (in-browser WASM-Rez) / hot-load / watch the Mac
  re-launch with your change* in ~820ms warm. Architecture rationale
  and the phase plan live in
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

The three demo apps under `src/app/` are deliberately minimal but
real:

- **Reader** (`CVMR`) — a classic-Mac HTML viewer in C. Reads HTML
  from `:Shared:` on the boot disk, supports a sensible subset
  (headings, paragraphs, lists, bold/italic, monospace blocks,
  links between bundled files, common entities), demonstrates the
  Toolbox-shell + pure-C-engine split.
- **MacWeather** (`CVMW`) — a tiny live-data app. The host page
  polls `api.open-meteo.com` and writes the response into the Mac
  at `:Unix:weather.json`; MacWeather watches the file, parses
  the JSON in pure C, and draws current conditions plus a 3-day
  forecast with pixel-art QuickDraw glyphs.
- **Hello Mac** (`CVHM`) — the smallest possible Toolbox application:
  a single window with "Hello, World!" drawn in the middle, a Quit
  command, and nothing else. Start here if you're new to Toolbox
  programming; it's also the default playground sample you edit.

All three apps coexist on the same boot disk. `src/app/CMakeLists.txt`
is a tiny aggregator; the boot-disk script installs
each `.bin` into `:System Folder:Startup Items:` (auto-launch on
boot) and `:Applications:` (re-launch from the desktop). Adding a
fourth app is one directory plus one line — see
[`src/app/README.md`](./src/app/README.md).

## Try it

### As a visitor (no install)

Open <https://khawkins98.github.io/classic-vibe-mac/>. Wait ~5-10s
on a warm cache for the first navigation to reload itself once
(the cross-origin-isolation service-worker shim needs one round
trip to install) and for the System 7.5.5 boot animation to
finish. Reader and MacWeather will auto-launch.

Scroll past the Mac to the source panel. The C and Rez files for
all three apps are listed; clicking a file opens it in the editor.
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
redraws. There is no socket inside the Mac.

For the byte-by-byte version — boot pipeline, SharedArrayBuffer
layout, the four-state input lock, the chunked disk reader, the
two-way `:Shared:` data flow, the multi-app model — see
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). For why the
playground is shaped this way (Rez-in-WASM, no backend, no auth,
no GCC port), see
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md).

## Iterating on it

Three loops:

1. **Fast (sub-second).** Edit pure-C engine, run `npm run test:unit`.
   No emulator, no browser. The Toolbox-shell + pure-C-engine split
   means most logic is testable on the host.
2. **Slow (~1-3 min).** Edit Toolbox shell or resource fork,
   cross-compile via the Retro68 Docker image (or pull the latest
   CI artifact), rebuild the boot disk, hard-reload the dev server.
3. **Slowest (~5-10 min).** Push, let CI build, deploy lands on
   Pages.

Pick the fastest loop that exercises your change. The full
walkthrough — first-time setup, both Loop 2 paths (CI artifact
or local Docker build), common-task recipes, common failure modes
mapped to fixes — is in
[`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md). The architectural
pattern the apps follow (and the rationale for the split) is in
[`src/app/README.md`](./src/app/README.md).

The dev process this project has converged on (the five-reviewer
red-flag pass that killed Epics #12 and #19 and produced #21) is
documented in [`docs/AGENT-PROCESS.md`](./docs/AGENT-PROCESS.md).

## Status

All three playground phases shipped on `main` as of 2026-05-08: editor + IDB
persistence (Phase 1), in-browser Rez compilation (Phase 2), and hot-load
into the running Mac in ~820ms warm (Phase 3).

The canonical shipped-state checklist — what's live, what's closed-Epic,
what's next — lives in
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md#status).

## Coming soon

In rough sequence. With Phases 1, 2, and 3 of the playground all
shipped, the next slate is polish + new demo apps.

- **Pixel Pad** —
  [#17](https://github.com/khawkins98/classic-vibe-mac/issues/17).
  Tiny QuickDraw drawing app, exports the canvas to the host page
  via the same extfs bridge MacWeather uses in reverse.
- **Markdown viewer + basic editor** —
  [#9](https://github.com/khawkins98/classic-vibe-mac/issues/9).
  Reuses Reader's `:Shared:` pattern, adds TextEdit for editing,
  demonstrates two-way file flow.
- **Mac-to-Mac AppleTalk** —
  [#15](https://github.com/khawkins98/classic-vibe-mac/issues/15).
  Verbatim from Infinite Mac's existing relay; peer-to-peer
  between two visitors, no internet bridge.
- **Reader URL bar** —
  [#14](https://github.com/khawkins98/classic-vibe-mac/issues/14).
  Bounded, host-fetched, CORS-permissive sources only.
- **Stretch:** Mac OS 9 / PPC via SheepShaver and Retro68's PPC
  toolchain. Requires a non-redistributable ROM, complicating
  things. Out of POC scope.

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
