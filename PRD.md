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
- **Auto-launch**: app placed in Startup Items so it opens immediately on boot
- **Demo app**: a Minesweeper clone (validates the full pipeline end-to-end)
- **Template repo**: structured so anyone can fork, replace the app source, and get
  their own GitHub Pages deployment

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
- Uses a **Retro68 Docker image** (e.g. `ghcr.io/autc04/retro68`) for fast, cached builds
- Steps:
  1. Compile C → Mac binary using CMake + Retro68 toolchain
  2. Create HFS disk image using `hfsutils` or `mkfs.hfs` in Linux
  3. Copy binary into disk image's `System Folder/Startup Items/`
  4. Output: `app.dsk`
- Artifacts cached between runs for speed

### 3. Web Execution Layer (`src/web/`)
- Minimal fork of Infinite Mac frontend (React + Vite)
- Uses pre-built `BasiliskII.wasm` (pulled from Infinite Mac releases, not rebuilt)
- Configured to:
  - Load base System 7.5.5 disk from Infinite Mac's CDN
  - Mount our custom `app.dsk` as a second drive
  - Boot and let Startup Items trigger our app
- Strips out Infinite Mac's library browser, CD-ROM support, etc.

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
