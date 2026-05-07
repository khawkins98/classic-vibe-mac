# PRD: classic-vibe-mac (Proof of Concept)

## Problem Statement

There's no easy, modern way to build and share a classic Mac OS app that runs in the
browser without setting up emulators locally or dealing with ROM licensing. This project
creates a GitHub template that lets a developer write a classic Mac app in C, push to
GitHub, and have it automatically compiled and served running inside Mac OS — fully in
the browser via GitHub Pages — with no local emulator setup required.

## Proposed Approach

Fork and strip down the **Infinite Mac** open-source codebase (SheepShaver/BasiliskII
compiled to WebAssembly). Use **Retro68** in a GitHub Actions workflow to cross-compile
a Mac app from C source. Pack the compiled binary into a small custom HFS disk image.
At boot, that disk image mounts in the emulated Mac and the app auto-launches via the
System Folder's Startup Items. Everything is served as static files on GitHub Pages.

---

## Goals (POC Scope)

- **Build pipeline**: push C source → GitHub Actions compiles with Retro68 → produces
  Mac binary → packed into an HFS disk image
- **Execution layer**: stripped Infinite Mac (Basilisk II, 68k, System 7.5.5) served
  as static files on GitHub Pages, referencing Infinite Mac's CDN for the base OS disk
  (avoids bundling/redistributing system software ourselves)
- **Auto-launch**: app opens automatically on boot. Note: System 7's Startup
  Items only fires from the *boot* volume's blessed System Folder, not from a
  secondary mounted disk (see LEARNINGS.md). Approach is therefore one of:
  (a) inject the app into the boot disk's System Folder at emulator-config
  time, (b) ship a custom blessed boot disk with the app pre-installed, or
  (c) drive Basilisk II to open the app post-boot. (a) or (b) is preferred.
- **Demo app**: a Minesweeper clone (validates the full pipeline end-to-end)
- **Template repo**: structured so anyone can fork, replace the app source, and get
  their own GitHub Pages deployment
- **Automated testing**: three-layer strategy — host-compiled C unit tests for
  game logic, Playwright e2e against the Vite dev server, and AI vision
  assertions for screenshots of the emulated canvas (pixel-diff is too brittle
  against an emulated CRT)

## Non-Goals (POC)

- Mac OS 9 / PPC (System 7.5.5 + 68k is the POC target; OS 9 is a stretch goal)
- Networking inside the emulated Mac
- Multi-app or app switcher support
- Custom ROM distribution (we use Infinite Mac's CDN-hosted system disk)
- A polished UI wrapper around the emulator

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  GitHub Repo (template)                                 │
│                                                         │
│  src/app/           ← C source for Mac app              │
│  src/web/           ← stripped Infinite Mac frontend    │
│  .github/workflows/ ← CI/CD pipeline                   │
└───────────────┬─────────────────────────────────────────┘
                │ git push
                ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Actions                                         │
│                                                         │
│  1. Build Retro68 (or pull cached Docker image)         │
│  2. Compile app → MyApp (68k Mac binary)                │
│  3. Create HFS disk image → app.dsk                     │
│     └─ place binary in Startup Items                    │
│  4. Build web frontend (Vite)                           │
│     └─ embed app.dsk path in config                     │
│  5. Deploy via actions/deploy-pages (Pages env)         │
└───────────────┬─────────────────────────────────────────┘
                │ static files
                ▼
┌─────────────────────────────────────────────────────────┐
│  GitHub Pages (browser)                                 │
│                                                         │
│  BasiliskII.wasm  ← emulator core                       │
│  app.dsk          ← our custom app disk (small, ~1MB)   │
│  ── fetches base OS disk from Infinite Mac CDN ──       │
│                                                         │
│  Boot → mount app.dsk → Startup Items → app launches   │
└─────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Mac App — Minesweeper Clone (`src/app/`)
- Written in C using Mac Toolbox APIs (QuickDraw, Window Manager, Menu
  Manager, Event Manager, Dialog Manager, Resource Manager).
- Targets 68k via Retro68 (`m68k-apple-macos-gcc`).
- Classic features: 9x9 grid, 10 mines (beginner difficulty), reveal,
  flag (option-click), flood-fill on zero-neighbor cells, win/lose
  detection, New Game (Cmd-N), Quit (Cmd-Q), About box.
- **First-click safety:** mines are placed lazily on the first reveal
  with the clicked cell + its 8 neighbors excluded from the placement
  pool, so the first click can never lose.
- **Source layout:**
  - `game_logic.{c,h}` — pure C engine. No Toolbox includes. Compiled
    by both Retro68 (linked into the app) and the host C compiler
    (driven by `tests/unit/test_minesweeper.c`). Uses an internal
    xorshift32 RNG seeded from `TickCount()` at runtime, or with a
    fixed seed in tests for reproducibility.
  - `minesweeper.c` — Toolbox UI shell. Owns the event loop, draws
    the board with QuickDraw, routes mouse clicks into the engine.
  - `minesweeper.r` — Rez resources: `WIND` (main window), `MBAR` +
    `MENU` (Apple/File/Edit), `ALRT`+`DITL` (About + win/lose
    confirmation), `STR#` (status text), `vers`, `SIZE`.
- Designed to run on System 7.x.

### 2. Build Pipeline (`.github/workflows/build.yml`)
- Uses **`ghcr.io/autc04/retro68:latest`** as the GitHub Actions job container
  — Retro68 has not published a release tarball since 2019, and the rolling
  Docker image is the maintained distribution channel (see LEARNINGS.md).
- Steps:
  1. `apt-get install -y hfsutils` into the container (Debian-based, runs as
     root in GH Actions). Note: `hfsutils` is HFS, NOT `hfsprogs` (HFS+).
  2. Compile C → Mac binary using CMake + Retro68 toolchain
     (`/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake`
     inside the container)
  3. Create HFS disk image via `scripts/build-disk-image.sh`, which uses
     `hfsutils` (`hcopy -m` preserves resource forks via MacBinary). Input is
     the Retro68 `.bin` (MacBinary); output is `dist/app.dsk` with the app
     placed under `Startup Items/` on the volume (placement is structurally
     correct for a future bootable-disk pivot — see the Auto-launch goal).
  4. Output: `dist/app.dsk` (uploaded as part of the workflow artifact
     alongside Retro68's own `.bin`/`.dsk`/`.APPL`).
- Artifact validation: `.bin`, `.dsk`, and our custom `dist/app.dsk` are
  sanity-checked with `test -s`; Retro68's `.APPL` artifact is sometimes 0
  bytes and is excluded from release uploads (see LEARNINGS.md).

### 3. Web Execution Layer (`src/web/`)
- **Vite + TypeScript** (vanilla TS, no framework). Page chrome is a
  hand-rolled System 7 desktop (menu bar + windowed Read Me + a
  "Macintosh" window where the emulator mounts), styled to period in
  `src/web/src/style.css`.
- Uses pre-built `BasiliskII.js` + `BasiliskII.wasm` from Infinite Mac.
  The cores live committed at `src/emulator/worker/emscripten/` on
  `main` — there's no GitHub Release or documented CDN. We pin a
  specific Infinite Mac commit SHA and download via
  `raw.githubusercontent.com` at build time in
  `scripts/fetch-emulator.sh`, with size + SHA-256 verification per
  file. Outputs land in `src/web/public/emulator/` (gitignored). License
  posture: Infinite Mac glue is Apache-2.0 but the compiled BasiliskII
  core itself is **GPL-2.0** from `mihaip/macemu` — the script vendors
  both LICENSE files alongside a NOTICE that pins the upstream commit
  (see LEARNINGS.md 2026-05-08). Run from the repo root:
  `npm run fetch:emulator`.
- Boot lifecycle is owned by `src/web/src/emulator-loader.ts`:
  1. Renders a period-styled progress bar inside `#emulator-canvas-mount`
     (the mount lives inside the marketer's `.inset` window).
  2. Fetches `BasiliskII.js` and `BasiliskII.wasm` with streaming
     progress.
  3. HEAD-checks `app.dsk` (404 tolerated for fresh forks).
  4. **Currently stubs the actual boot** because the System 7.5.5 boot
     disk has no public single-file URL — Infinite Mac's worker consumes
     a build-generated chunked-disk JSON manifest backed by a private
     R2 bucket, with no documented public schema (see LEARNINGS.md
     2026-05-08, "Boot disk plumbing"). The loader cleanly enters a
     STUB phase that keeps the chrome visually complete and surfaces
     the blocker. Once unblocked (recommended path: self-host a chunked
     manifest of System 7.5.5 under GH Pages), the same loader will
     instantiate the BasiliskII Emscripten Module, attach the canvas,
     and wire input via `emulator-input.ts`.
- Configured via `src/web/src/emulator-config.ts` (typed):
  - `coreUrl` / `wasmUrl` — Vite-base-relative paths to the vendored
    core.
  - `bootDiskUrl` — `null` until chunked-disk plumbing exists.
  - `appDiskUrl` — `${BASE_URL}app.dsk`, dropped next to `index.html`
    by CI.
  - `screen` — emulator native resolution (defaults to 640×480).
- **SharedArrayBuffer / cross-origin isolation:** the Vite dev server
  sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` itself. GitHub Pages
  cannot set custom response headers, so the production deploy plans to
  ship the ~3KB MIT-licensed `coi-serviceworker` polyfill (registers a
  SW that re-issues navigations with the headers attached). Not yet
  wired — only needed once the boot disk is unstubbed and the worker
  actually allocates SAB. Fallback: BasiliskII can run with
  `jsfrequentreadinput=false` (service-worker-mediated input passing,
  no SAB required, slower input).
- Strips out Infinite Mac's library browser, multi-OS selector, settings
  panes — our loader is single-purpose.
- Dev server: `npm run dev` from the repo root (npm workspaces).

### 4. Testing (`tests/`)
- Three layers:
  1. **Unit (`tests/unit/`)** — host-compiled C tests for game logic. Anything
     in `src/app/` that doesn't call MacToolbox APIs is testable here against
     the host `gcc`. Fast and cheap.
  2. **E2E (`tests/e2e/`)** — Playwright against the local Vite dev server.
     Drives the page, sends events into the canvas, captures screenshots.
  3. **Vision (`tests/visual/`)** — AI vision assertions on canvas
     screenshots via the Claude API. Replaces brittle pixel-diff with
     semantic checks ("expect a window titled Minesweeper", "expect a 9×9
     grid"). Gated behind `ANTHROPIC_API_KEY`.
- Top-level npm scripts: `npm test`, `npm run test:unit`, `npm run test:e2e`,
  `npm run test:visual`.

### 4. GitHub Pages Deployment
- Vite builds static output to `src/web/dist/` with `VITE_BASE=/<repo-name>/`
  so asset URLs resolve under the project Pages subpath.
- The CI-built `app.dsk` is copied into `src/web/dist/app.dsk` after Vite
  runs, so it sits next to `index.html` and is served from the same base URL
  as the rest of the site.
- Deploy is via the official GitHub-hosted actions
  (`actions/upload-pages-artifact` + `actions/deploy-pages`), NOT the older
  `gh-pages`-branch / `peaceiris/actions-gh-pages` pattern. The Pages
  environment is gated to `main` + non-PR; PRs run the build for CI signal
  but never publish to production.
- **Cross-origin isolation caveat:** GitHub Pages does NOT serve `COOP`/`COEP`
  response headers, and BasiliskII WASM requires a cross-origin-isolated
  context for `SharedArrayBuffer`. The web layer is expected to ship a
  service-worker shim (e.g. `coi-serviceworker`, or the equivalent Vite
  plugin) that intercepts navigations and installs the headers client-side.
  If we ever hit a hard wall on this, fallback hosts that DO let us set
  response headers are Cloudflare Pages (`_headers` file) or
  Netlify (`netlify.toml`). Owner of the fix is the web/emulator agent;
  the build pipeline only flags it at the deploy boundary.

---

## Key Technical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **No public URL for System 7.5.5 boot disk** (actual blocker, found 2026-05-08) | Self-host a chunked manifest generated from a System 7.5.5 ISO via Infinite Mac's `scripts/import-disks.py`, served from GH Pages alongside `app.dsk`. Apple released 7.5.5 freely, so licensing is OK. ~150MB of small files, well within Pages limits. See LEARNINGS.md. |
| Retro68 Docker image size slows CI | Cache Docker layer in GH Actions; image is ~2GB but caches well |
| HFS disk image creation on Linux | Use `hfsutils` package (available in Ubuntu runners) |
| BasiliskII WASM file size (1.7MB at the pinned Infinite Mac commit; smaller than original PRD assumed) | Vite serves with Brotli. Hash-verified at build time by `fetch-emulator.sh`. |
| GitHub Pages can't set COOP/COEP for SharedArrayBuffer | Ship `coi-serviceworker` polyfill (MIT, ~3KB) registered from `index.html`. Fallback host is Cloudflare Pages or Netlify if the SW shim breaks. |
| Startup Items auto-launch reliability | Test on System 7.5.5; fallback: inject the app into the boot disk's System Folder at config time, or ship a custom blessed boot disk. |
| ROM licensing | We don't bundle ROMs — Infinite Mac's chunked boot disk includes the ROM used by BasiliskII via their existing setup. Self-hosting (above) inherits this property. |
| BasiliskII core is GPL-2.0 (not Apache-2.0 as originally stated) | NOTICE file pins upstream commit + macemu source repo to satisfy "offer source" obligation. Forks that recompile must vendor macemu source themselves. |

---

## OS Target Decision

**POC: System 7.5.5 + 68k (Basilisk II)**
- Retro68 is most mature for 68k
- Basilisk II is lighter/faster to boot than SheepShaver
- System 7.5.5 is freely redistributable (Apple released it)

**Stretch goal: Mac OS 9 + PPC (SheepShaver)**
- Retro68 does have a PPC target
- SheepShaver WASM is available in Infinite Mac
- Requires a Mac OS 9 ROM (not freely redistributable — complicates distribution)

---

## Milestones

1. **Hello World** — Retro68 compiles a minimal Mac app; disk image mounts in Infinite Mac manually
2. **Auto-launch** — app boots automatically via Startup Items in BasiliskII WASM
3. **Minesweeper** — full game implemented and playable
4. **GitHub Actions pipeline** — full build-to-disk-image workflow in CI
5. **GitHub Pages deploy** — one-click deployment from fork, accessible via browser
6. **Template polish** — README, fork instructions, replace-app guide

---

## Repo Structure (proposed)

```
classic-vibe-mac/
├── .github/
│   └── workflows/
│       └── build.yml
├── src/
│   ├── app/                  ← Mac C source
│   │   ├── CMakeLists.txt
│   │   └── minesweeper.c
│   └── web/                  ← stripped Infinite Mac frontend
│       ├── index.html
│       ├── emulator-config.ts
│       └── ...
├── scripts/
│   └── build-disk-image.sh   ← creates HFS image from compiled binary
├── public/                   ← static assets
└── README.md
```
