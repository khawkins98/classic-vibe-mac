# PRD: classic-mac-builder (Proof of Concept)

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
│  5. Deploy to gh-pages branch                           │
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
- Written in C using Mac Toolbox APIs (QuickDraw, Controls Manager, Events)
- Targets 68k via Retro68 (`m68k-apple-macos-gcc`)
- Classic features: grid reveal, mines, win/lose state, new game button
- Designed to run on System 7.x

### 2. Build Pipeline (`.github/workflows/build.yml`)
- Uses **`ghcr.io/autc04/retro68:latest`** as the GitHub Actions job container
  — Retro68 has not published a release tarball since 2019, and the rolling
  Docker image is the maintained distribution channel (see LEARNINGS.md).
- Steps:
  1. Compile C → Mac binary using CMake + Retro68 toolchain
     (`/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake`
     inside the container)
  2. Create HFS disk image using `hfsutils` (`hcopy -m` preserves resource
     forks via MacBinary)
  3. Copy binary into disk image (placement depends on the auto-launch
     approach chosen — see the Auto-launch goal above)
  4. Output: `app.dsk`
- Artifact validation: `.bin` and `.dsk` are sanity-checked with `test -s`;
  Retro68's `.APPL` artifact is sometimes 0 bytes and is excluded from
  release uploads (see LEARNINGS.md).

### 3. Web Execution Layer (`src/web/`)
- **Vite + TypeScript** (vanilla TS, no React for now — the original PRD
  mention of React was speculative; we don't need a framework to mount one
  emulator).
- Uses pre-built `BasiliskII.wasm` from Infinite Mac. Infinite Mac does **not**
  ship WASM via GitHub Releases or a documented CDN — the emulator cores live
  committed at `src/emulator/worker/emscripten/` on `main` (see LEARNINGS.md).
  Plan: a build-time fetch script pinning a specific Infinite Mac commit SHA
  and pulling `BasiliskII.wasm`/`.js` via `raw.githubusercontent.com`.
  Apache-2.0 license — redistribution OK with NOTICE preserved.
- Configured to:
  - Load base System 7.5.5 disk from Infinite Mac's CDN
  - Mount our custom `app.dsk` as a second drive
  - Boot and trigger our app (mechanism TBD — see Auto-launch goal)
- Strips out Infinite Mac's library browser, multi-OS selector, settings
  panes, etc.
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
- Vite builds static output to `dist/`
- `app.dsk` co-located in `dist/`
- GitHub Actions pushes `dist/` to `gh-pages` branch
- No server-side code needed (pure static)

---

## Key Technical Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Infinite Mac CDN for OS disk may have CORS issues from GH Pages | Test early; fallback: bundle a freely redistributable System 7 image |
| Retro68 Docker image size slows CI | Cache Docker layer in GH Actions; image is ~2GB but caches well |
| HFS disk image creation on Linux | Use `hfsutils` package (available in Ubuntu runners) |
| BasiliskII WASM file size (~10MB+) may be slow to load on GH Pages | Compress with Brotli; Vite handles this |
| Startup Items auto-launch reliability | Test on System 7.5.5; fallback: use Extensions or user instruction |
| ROM licensing | We don't bundle ROMs — BasiliskII needs one but Infinite Mac CDN supplies it via their existing setup |

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
classic-mac-builder/
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
