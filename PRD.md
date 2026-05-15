# PRD: classic-vibe-mac

_Last updated: 2026-05-09._

## Problem Statement

There's no easy, modern way to **try** a classic Mac OS app — let alone
build one — without setting up emulators locally or wrangling ROM
licensing. Want to see what writing for System 7.5.5 feels like in
2026? You either commit to a multi-hour Retro68 install, or you don't.

This project closes both gaps in the same browser tab:

1. A 1993 Macintosh boots at a URL with five real demo apps already
   running, so visitors can use one before deciding to build one.
2. A source-code editor sits below the Mac with the same C and Rez
   files that produced the apps running above it. Edits persist
   locally; an in-browser Rez compiler (WASM-Rez, shipped) plus an
   in-browser HFS template-splicer close the loop so a string change
   in the editor reboots the Mac with that change applied in ~820ms
   warm — no fork, no push, no toolchain.

The original framing — "a GitHub template you fork to ship your
own classic Mac app on GitHub Pages" — still holds and is covered
by the same repo. The playground is the headline; the template is
the deploy target the playground happens to ride.

## Proposed Approach

Ship two things that share one deploy:

### The playground (headline)

A Vite + TypeScript page that:

- Boots **Basilisk II** (compiled to WebAssembly by the Infinite
  Mac project) against a self-hosted, chunked **System 7.5.5** boot
  disk. All three demo apps auto-launch from `:System Folder:Startup
  Items:`.
- Mounts a CodeMirror 6 editor seeded with the same C and Rez
  sources that built the apps. Edits persist in IndexedDB
  (`bundleVersion`-keyed invalidation), download as a zip via
  JSZip, reset to defaults per file.
- Compiles the resource fork in-browser via WASM-Rez, splices it
  onto a precompiled code fork, hot-loads the result onto a
  synthetic in-memory disk, and re-spawns the worker so the Mac
  boots with the edited app — all without a network round-trip
  past the initial page load. Live in production at ~820ms warm.

The hard architectural constraint, restated every design review:
**everything runs as JavaScript in the visitor's browser. No
backend, no relay, no auth, no compile service, no database.** The
playground is shaped around that. See
[`docs/ARCHITECTURE.md` § What we deliberately avoid](./docs/ARCHITECTURE.md#what-we-deliberately-avoid)
and [Closed-Epic graveyard](#closed-epic-graveyard) below.

### The template (riding along)

The same repo is structured so anyone can fork, replace `src/app/`
with their own C source, push, and get their own GitHub Pages
deployment. **Retro68** in a GitHub Actions workflow cross-compiles
the C; an HFS disk image is packed; the resulting site is the
playground but with the fork's apps. The fork inherits the editor
panel for free.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Repo (template + playground source)             │
│                                                         │
│  src/app/<name>/    ← C + Rez per app (Retro68 input)   │
│  src/web/           ← Vite host + emulator + editor     │
│  scripts/           ← boot-disk packing, manifest,      │
│                       chunking, screenshot capture      │
│  .github/workflows/ ← CI/CD pipeline                    │
└───────────────┬─────────────────────────────────────────┘
                │ git push
                ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions                                         │
│                                                         │
│  1. Retro68 container compiles each app in src/app/     │
│  2. scripts/build-boot-disk.sh:                         │
│       - downloads System 7.5.5 (cached, SHA-pinned)     │
│       - hcopy each .bin into Startup Items + Apps       │
│       - hcopy src/web/public/shared/*.html into :Shared:│
│  3. write-chunked-manifest.py: 256KiB chunks +          │
│       JSON manifest matching EmulatorChunkedFileSpec    │
│  4. Vite build (sample-projects copied from src/app/    │
│       at this step, frozen for the editor)              │
│  5. actions/deploy-pages (gated on main + non-PR)       │
└───────────────┬─────────────────────────────────────────┘
                │ static files
                ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Pages (browser tab)                             │
│                                                         │
│  index.html  ─▶  coi-serviceworker (1st-nav reload)     │
│       │                                                 │
│       ▼                                                 │
│  TS host  ─▶  Web Worker  ─▶  BasiliskII.wasm           │
│       │                              │                  │
│       │                              ▼                  │
│       │                    chunked HFS boot disk        │
│       │                    (Reader + MacWeather in      │
│       │                     Startup Items + Apps)       │
│       │                                                 │
│       ▼                                                 │
│  CodeMirror editor  ─▶  IndexedDB persistence           │
│       │                                                 │
│       ▼  (Phase 2/3, shipped)                           │
│  WASM-Rez  ─▶  resource patcher  ─▶  InMemoryDisk       │
│       └──────▶  worker.dispose() + boot(new disk)       │
└─────────────────────────────────────────────────────────┘
```

The byte-by-byte version of this is in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Boot pipeline,
SAB layout, the four-state input lock, the chunked disk reader, the
two-way `:Shared:` data flow, and the multi-app model are all there.

---

## Components

### 1. Mac Apps (`src/app/`)

Multiple apps coexist under `src/app/<name>/`. The top-level
`CMakeLists.txt` is a tiny aggregator
(`add_subdirectory(reader)`, `add_subdirectory(macweather)`); each
app has its own creator code, `add_application()` call, and
resource fork. Outputs land in `build/<app>/`. The boot-disk script
installs every `.bin` into both `:System Folder:Startup Items:`
(auto-launch) and `:Applications:` (re-launch from the desktop).

Each app splits deliberately into a **Toolbox shell** (`<app>.c`)
that owns the platform — event loop, drawing, menus — and a
**pure-C engine** (`html_parse.{c,h}`, `weather_parse.{c,h}`) with
no Toolbox includes. The engine compiles with both Retro68 and the
host `gcc`, so `tests/unit/` runs in milliseconds without booting
an emulator.

- **Reader** (`CVMR`) — HTML viewer in C reading from `:Shared:` on
  the boot disk. Supports headings, paragraphs, lists, bold/italic,
  monospace blocks, links between bundled files, common entities.
  Has a URL bar: the Mac writes a request file to
  `:Unix:__url-request.txt`, the host fetches the URL, writes the
  result to `:Unix:__url-result-<id>.html`. Out of scope: images,
  tables, CSS, forms, JavaScript.
- **MacWeather** (`CVMW`) — live-data demo reading
  `:Unix:weather.json` (BasiliskII's extfs surfaces
  Emscripten's `/Shared/` as the Mac volume `Unix:`), parsing the
  open-meteo shape with a hand-rolled JSON parser, drawing current
  conditions + a 3-day forecast in pixel-art QuickDraw glyphs.
- **Hello Mac** (`CVHM`) — minimal "Hello, World!" Toolbox app;
  the default playground sample and the on-ramp for new contributors.
- **Pixel Pad** (`CVMP`) — freehand QuickDraw drawing app that
  exports its 64×64 1-bit canvas to `:Unix:__drawing.bin`; the host
  watcher converts it to a live PNG preview below the emulator.
- **Markdown Viewer** (`CVMD`) — reads `.md` files from `:Shared:`
  and renders them with a hand-rolled C Markdown parser; supports
  headings, paragraphs, bold, italic, code, fenced blocks, lists.

Per-app architectural details and the add-your-own-app guide live
in [`src/app/README.md`](./src/app/README.md).

### 2. Build Pipeline (`.github/workflows/build.yml`)

- Uses `ghcr.io/autc04/retro68:latest` as the GitHub Actions job
  container (Retro68 has not published a release tarball since
  2019; the rolling Docker image is the maintained channel).
- `apt-get install -y hfsutils` into the container.
  (`hfsutils` is HFS, NOT `hfsprogs` which is HFS+.)
- CMake + Retro68 toolchain compiles each app.
- `scripts/build-disk-image.sh` packs each compiled `.bin` into a
  small secondary `dist/app.dsk` (~1.4 MB) for forks that want a
  secondary mount.
- `scripts/build-boot-disk.sh` downloads (SHA-256 pinned, locally
  cached) a pre-installed bootable System 7.5.5 image, mounts it
  via hfsutils, copies each compiled `.bin` into
  `:System Folder:Startup Items:` and `:Applications:`, bakes
  `src/web/public/shared/*.html` into `:Shared:`. Output:
  `dist/system755-vibe.dsk` (~24 MB), idempotent.
- `scripts/write-chunked-manifest.py` re-emits as 256 KiB chunks +
  JSON manifest matching `EmulatorChunkedFileSpec` (algorithm
  ported from `mihaip/infinite-mac@30112da0db`).

Full pipeline diagram + worker-glue details in
[`docs/ARCHITECTURE.md` § The CI pipeline](./docs/ARCHITECTURE.md#the-ci-pipeline).

### 3. Web Execution Layer (`src/web/`)

Vite + TypeScript (vanilla, no framework). Page chrome is a
hand-rolled System 7 desktop styled to period in
`src/web/src/style.css`. Uses pre-built `BasiliskII.js` +
`BasiliskII.wasm` from Infinite Mac plus `Quadra-650.rom`, all
SHA-pinned by `scripts/fetch-emulator.sh`. The compiled BasiliskII
core is GPL-2.0; the Infinite Mac glue is Apache-2.0; both
LICENSE files vendor alongside a NOTICE pinning the upstream
commit.

Boot lifecycle is owned by `src/web/src/emulator-loader.ts` plus
`src/web/src/emulator-worker.ts` (Web Worker, `type:'module'`).
The worker exposes `globalThis.workerApi` matching upstream
`EmulatorWorkerApi` byte-for-byte (that interface is the WASM
ABI), allocates three SharedArrayBuffers (video framebuffer,
videoMode metadata, Int32 input ring whose offsets match
`InputBufferAddresses`), reads chunked disk via synchronous XHR,
renders BasiliskIIPrefs.txt (including the load-bearing
`modelid 30` — `gestaltID − 6` for Quadra 650; see Risks), and
`import()`s `/emulator/BasiliskII.js`. Audio / clipboard / files /
ethernet / CD-ROM / persistent disk savers / speed governor are
deliberately stubbed.

GitHub Pages can't set COOP/COEP, so we ship the ~3KB MIT
`coi-serviceworker` shim as a non-module `<script>` at the top of
`<head>`. First navigation reloads once; second is cross-origin
isolated. Vite dev sets the headers itself.

Byte-by-byte version in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

### 4. Testing (`tests/`)

Three layers. **Unit** (`tests/unit/`) — host-compiled C tests for
pure-C engines (`html_parse`, `weather_parse`); fast, cheap.
**E2E** (`tests/e2e/`) — Playwright against the Vite dev server.
**Vision** (`tests/visual/`) — AI vision assertions on canvas
screenshots via the Claude API; replaces brittle pixel-diff with
semantic checks. Gated behind `ANTHROPIC_API_KEY`.
Top-level scripts: `npm test`, `npm run test:unit`,
`npm run test:e2e`, `npm run test:visual`.

### 5. Playground (`src/web/src/playground/`)

The headline feature, Epic
[#21](https://github.com/khawkins98/classic-vibe-mac/issues/21).
All three phases shipped on `main` as of 2026-05-08. Phase 1 (PR
#32) is CodeMirror 6 with the C language pack, single-file editor,
IndexedDB persistence with `bundleVersion` invalidation + in-memory
fallback when IDB is unavailable, sample projects copied from
`src/app/<name>/` at Vite build time, reset-to-default,
download-as-zip via JSZip, a strict CSP, an "Open on desktop"
message on mobile. Phase 2 is Rez-in-WASM — the research spike
under `spike/wasm-rez` (PR #34, do-not-merge) produced bytes
SHA-256-identical to native Retro68 Rez at 103KB gzipped; the
shipped build wires that into the editor with a precompiled code
fork and editor-marker errors. Source vendored under
`tools/wasm-rez/`; runtime artefacts under `src/web/public/wasm-rez/`.
Phase 3 is hot-load via a template-splice HFS patcher, an
`InMemoryDisk` class, and worker re-spawn — Build & Run round-trips
~820ms warm in production.

Full design rationale, the option-2F architecture-review summary,
and the gotchas the spike will hit are in
[`docs/PLAYGROUND.md`](./docs/PLAYGROUND.md). Don't duplicate that
content here.

### 6. GitHub Pages Deployment

- Vite builds static output to `src/web/dist/` with
  `VITE_BASE=/<repo-name>/` so asset URLs resolve under the
  project Pages subpath.
- The CI-built `app.dsk` is copied into `src/web/dist/app.dsk`
  after Vite runs.
- Deploy via official GitHub-hosted actions
  (`actions/upload-pages-artifact` + `actions/deploy-pages`). The
  Pages environment is gated to `main` + non-PR; PRs run the
  build for CI signal but never publish.
- **Cross-origin isolation caveat:** GitHub Pages does NOT serve
  COOP/COEP response headers. The web layer ships the
  `coi-serviceworker` shim that intercepts navigations and
  installs the headers client-side. Fallback hosts that DO let us
  set response headers: Cloudflare Pages (`_headers`) or Netlify
  (`netlify.toml`).

---

## Goals

### Milestones — shipped

> See [`docs/PLAYGROUND.md § Status`](./docs/PLAYGROUND.md#status)
> for the full shipped-state table. Summary:

- ✅ Boot loop, multi-app demo (5 apps), GitHub Pages deploy
- ✅ Playground Phase 1: editor + IDB persistence + download-as-zip (PR #32)
- ✅ Playground Phase 2: WASM-Rez in-browser compilation
- ✅ Playground Phase 3: hot-load, ~820ms warm round-trip
- ✅ Rez syntax highlighting, Build & Run first-run modal
- ✅ Reader URL bar (#14): Mac→JS fetch bridge with request-ID correlation
- ✅ Pixel Pad (#17): QuickDraw drawing app with JS live PNG preview
- ✅ Markdown Viewer (#9): .md reader with hand-rolled C parser
- ✅ Ethernet relay (#15): opt-in AppleTalk zone networking via `?zone=`

### Non-Goals

- Mac OS 9 / PPC (System 7.5.5 + 68k is the target; OS 9 is a
  stretch goal).
- Real Mac TCP/IP via a relay. Closed via Epic #12 review (ToS
  violation + architecture wrong). An **opt-in AppleTalk zone relay**
  (`?zone=` + Cloudflare DO) did ship as #15; it is peer-to-peer
  layer-2 only and does NOT give the Mac general internet access.
- Server-side compilation or any auth flow that needs a backend.
  Closed via Epic #19 review; see graveyard.
- Cloud sync of editor state. The user's red line: no shared
  store, no relay.
- ~~Full GCC port to WASM.~~ **Update (2026-05-15):** the
  *compilation* part of this shipped after all — but via a different
  path than the closure rationale assumed. Instead of porting GCC's
  fork/exec model (~4-9 engineer-months), we wasm-compile Retro68's
  existing cc1/as/ld/Elf2Mac binaries as standalone Emscripten
  modules and orchestrate them from JavaScript (~2 weeks of focused
  work in [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)).
  End-to-end Build & Run for in-browser C projects works as of
  cv-mac #97. The OAuth / commit-back side of Epic #19 remains out
  of scope. See LEARNINGS Key Story #6 for the
  closed-as-infeasible-but-actually-possible retrospective.

---

## Key Technical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **BasiliskII WASM init contract** (resolved 2026-05-08) | Ported the minimum-viable subset of `mihaip/infinite-mac@30112da0db`'s worker glue into `src/web/src/emulator-worker.ts` (~480 lines): chunked disk reader, disks API, EmulatorWorkerApi shim, prefs renderer, ROM/prefs FS staging, SAB-based video/input. Verified end-to-end with a real boot. |
| **System 7.5.5 redistribution** | Apple posted complete System 7.5.3 install media to its support site in 2001 with a license permitting free redistribution; the 7.5.5 updater inherits that posture. NOTICE attributes Apple and explicitly disclaims affiliation. |
| **`build-boot-disk.sh` SHA-256 pin** (locked 2026-05-08) | Pinned to `9126e47cda69…`. A hostile CDN substitution now fails CI loudly. Re-pin only if archive.org rebuilds the upstream image. |
| Retro68 Docker image size slows CI | Cache Docker layer in GH Actions; image is ~2GB but caches well. |
| HFS disk image creation on Linux | `hfsutils` package (Ubuntu runners, Debian-based Retro68 container). |
| BasiliskII WASM file size (1.7MB) | Vite serves with Brotli. Hash-verified at build time by `fetch-emulator.sh`. |
| GitHub Pages can't set COOP/COEP for SAB | Ship `coi-serviceworker` polyfill (MIT, ~3KB) registered from `index.html`. Fallback host: Cloudflare Pages or Netlify. |
| Startup Items auto-launch reliability (verified 2026-05-08) | Apps are baked into the boot disk's blessed `:System Folder:Startup Items:` at build time. Verified live in production. |
| `Quadra-650.rom` (~1MB, vendored from Infinite Mac) | Infinite Mac's only 68040-class ROM at the pinned commit. Fetched + SHA-pinned by `scripts/fetch-emulator.sh`. License posture inherited. |
| BasiliskII core is GPL-2.0 (not Apache-2.0) | NOTICE pins upstream commit + macemu source repo to satisfy "offer source" obligation. Forks that recompile must vendor macemu source themselves. |
| **`modelid` pref must be `gestaltID − 6`, not the gestalt itself** (resolved 2026-05-08) | A wrong `modelid 36` made Gestalt report machine type 42, not a real Mac — System 7.5.5 skipped Toolbox patches and Retro68's runtime hit an unpatched A-line trap (unimplemented-trap bomb). Fixed in `BASE_PREFS`. Lesson: when porting an emulator config, copy the formula, not the constant. |
| **Playground Phase 2 preprocessor** (resolved 2026-05-08) | Rez's bundled preprocessor (Boost.Wave) was 2.3MB / 446 files with no public WASM port. Sidestepped by writing a small TypeScript-side preprocessor (`src/web/src/playground/preprocessor.ts`) that handles `#include`, `#define`, `#if` against the IDB-backed virtual FS — Rez `.r` files don't use the gnarly preprocessor features. WASM-Rez source lives under `tools/wasm-rez/`. |
| **Playground Phase 2 cold-start latency** | First Rez compile after page load: ~1.5s (WASM instantiation + RIncludes parse). Warm: <500ms. UX copy must say "first compile takes a moment…" — silently slow looks broken. |
| **Phase 3 HFS encoder scope** | Don't write a real HFS encoder. Ship one empty-volume `.dsk` blob as a CI artifact (built once by `hfformat`), in-browser patch catalog leaf + bitmap + MDB to add one file. ~500 lines TS, not 12-18 days of HFS encoder. |

---

## OS Target Decision

**Today: System 7.5.5 + 68k (Basilisk II)**

- Retro68 is most mature for 68k.
- Basilisk II is lighter/faster to boot than SheepShaver.
- System 7.5.5 is freely redistributable.

**Stretch goal: Mac OS 9 + PPC (SheepShaver)**

- Retro68 has a PPC target.
- SheepShaver WASM is available in Infinite Mac.
- Requires a Mac OS 9 ROM (not freely redistributable).

---

## Open work

> **Current shipped-state:** see [`docs/PLAYGROUND.md § Status`](./docs/PLAYGROUND.md#status)
> for the canonical table of what's live, what's closed, and what's next.
> The list below is the _intent_ layer — design decisions and
> non-goals. Don't duplicate factual shipped/not-shipped claims here;
> update `docs/PLAYGROUND.md` instead.

In rough priority order. The playground is the priority; everything
else slots in behind it. The user has explicitly committed to that
sequencing.

### Playground polish

All planned playground polish shipped. Summary:

- [#22](https://github.com/khawkins98/classic-vibe-mac/issues/22) ✅ — file tree + tabs + dirty-state
- [#23](https://github.com/khawkins98/classic-vibe-mac/issues/23) ✅ — Rez (.r) syntax highlighting
- [#24](https://github.com/khawkins98/classic-vibe-mac/issues/24) ✅ — smart bundle migration
- [#25](https://github.com/khawkins98/classic-vibe-mac/issues/25) ✅ — side-by-side editor + emulator
- [#26](https://github.com/khawkins98/classic-vibe-mac/issues/26) ✅ — "Hello, Mac!" starter sample
- [#49](https://github.com/khawkins98/classic-vibe-mac/issues/49) ✅ — architecture review (all critical findings resolved)

### Demo apps roadmap

- [#9](https://github.com/khawkins98/classic-vibe-mac/issues/9)
  — Markdown viewer + basic editor as a third demo app. Reuses
  Reader's `:Shared:` pattern, adds TextEdit for editing,
  demonstrates two-way file flow.
- [#14](https://github.com/khawkins98/classic-vibe-mac/issues/14)
  — Reader URL bar; bounded, host-fetched, CORS-permissive
  sources only.
- [#15](https://github.com/khawkins98/classic-vibe-mac/issues/15)
  — Mac-to-Mac AppleTalk verbatim from Infinite Mac's existing
  relay (peer-to-peer between visitors, no internet bridge).
- [#17](https://github.com/khawkins98/classic-vibe-mac/issues/17)
  — Pixel Pad: tiny QuickDraw drawing app, exports to host page
  via the same extfs bridge MacWeather uses in reverse.

### Hygiene

- **Period chrome polish:** Chicago/Geneva web font vendoring,
  rainbow Apple in the menu bar, optional startup chime.
- **Stretch:** Mac OS 9 / PPC via SheepShaver.

---

## Closed-Epic graveyard

Two Epics that died honestly. Pointer rather than duplication —
the full reasoning is in
[`docs/PLAYGROUND.md` § Closed-Epic graveyard](./docs/PLAYGROUND.md#closed-epic-graveyard).

- **[Epic #12](https://github.com/khawkins98/classic-vibe-mac/issues/12)
  — Real Mac TCP/IP via WebSocket relay (closed).** Architecture
  wrong by an OSI layer (BasiliskII's `ether js` mode emits raw
  L2 frames, a real bridge needs a SLIRP-class userspace TCP
  stack); Cloudflare ToS §2.2.1(j) forbids VPN-like services;
  iCab 2.x is actively-licensed shareware. Replaced with #14
  (Reader URL bar) + #15 (peer-to-peer AppleTalk).
- **[Epic #19](https://github.com/khawkins98/classic-vibe-mac/issues/19)
  — Full in-browser IDE with C compilation (closed in 2026-04;
  capability shipped 2026-05-15 via a different path).** The
  original closure rationale held for the auth side (Phase 2C
  needed GitHub OAuth `repo` scope, achievable only via a
  token-exchange relay) and the HFS side (Phase 3 silently
  assumed an in-browser HFS writer that didn't exist). What
  turned out wrong was Option 2A's effort estimate: porting GCC
  from scratch to WASM via fork/exec emulation is 4-9
  engineer-months, but **wasm-compiling Retro68's existing
  binaries as standalone Emscripten modules and orchestrating
  them from JavaScript is ~2 weeks**. We did that in
  [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc),
  vendored into cv-mac as `compileToBin`, end-to-end Build &
  Run shipped 2026-05-15 (cv-mac #97). LEARNINGS Key Story #6
  captures the meta-lesson on closed-as-infeasible Epics.

The original lesson — **a full in-browser IDE for classic Mac C
via the path Epic #19 evaluated (porting GCC's fork/exec model
into Emscripten) is genuinely 4-9 engineer-months of work** —
holds, dominated by porting GCC + the linker to WASM, *not*
by the editor or the UI. If you want to revisit it, frame it as a
research spike with a ruthless time-box — not as a feature Epic.

---

## Repo Structure (as shipped)

```
classic-vibe-mac/
├── .github/workflows/        ← build.yml (Retro68→disks→Pages), test.yml
├── docs/
│   ├── DEVELOPMENT.md        ← day-to-day iteration loops
│   ├── ARCHITECTURE.md       ← system architecture as built
│   ├── PLAYGROUND.md         ← Epic #21 design rationale
│   └── AGENT-PROCESS.md      ← five-reviewer pass + dispatch hygiene
├── src/
│   ├── app/                  ← Mac C source (Retro68 + Toolbox)
│   │   ├── CMakeLists.txt    ← aggregator
│   │   ├── README.md
│   │   ├── reader/           ← Reader (CVMR): HTML viewer
│   │   └── macweather/       ← MacWeather (CVMW): live-data demo
│   └── web/                  ← Vite + TypeScript page + editor
│       ├── public/
│       │   ├── coi-serviceworker.min.js  ← SAB on GH Pages
│       │   ├── emulator/                 ← BasiliskII WASM (gitignored)
│       │   ├── shared/                   ← HTML baked into :Shared:
│       │   └── sample-projects/          ← editor seed (build-time)
│       └── src/
│           ├── main.ts, style.css        ← System 7 chrome
│           ├── emulator-{config,loader,worker,input}.ts
│           ├── weather-poller.ts         ← open-meteo → Mac
│           └── playground/
│               ├── editor.ts             ← CodeMirror 6 host
│               ├── persistence.ts        ← IDB + bundleVersion
│               └── types.ts
├── tests/                    ← unit (host-cc) / e2e (Playwright) / visual (Claude)
├── scripts/
│   ├── fetch-emulator.sh     ← BasiliskII core + ROM (pinned)
│   ├── build-disk-image.sh   ← app.dsk packer
│   ├── build-boot-disk.sh    ← System 7.5.5 + chunks
│   ├── write-chunked-manifest.py
│   └── capture-deployed-screenshot.mjs
├── public/                   ← landing-page screenshots
├── package.json              ← npm workspaces (root + src/web)
├── PRD.md                    ← this file
├── README.md, CONTRIBUTING.md, LEARNINGS.md, LICENSE, NOTICE
```
