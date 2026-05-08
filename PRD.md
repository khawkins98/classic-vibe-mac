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
- **Execution layer**: stripped Infinite Mac (Basilisk II, 68k, System 7.5.5)
  served as static files on GitHub Pages. We **self-host** a single
  bootable System 7.5.5 hard-disk image — `system755-vibe.dsk` — alongside
  the rest of the site. Infinite Mac doesn't expose a public single-file
  boot disk URL (their worker fetches a build-generated chunked manifest
  from a private Cloudflare R2 bucket), so we sidestep that altogether by
  baking our own. Apple released System 7.5.3 to its own support site in
  2001 with a free-redistribution license; the 7.5.5 updater inherits the
  same posture (see NOTICE).
- **Auto-launch**: app opens automatically on boot. System 7's Finder
  scans `<boot volume>/System Folder/Startup Items/` on the *blessed*
  System Folder of the boot volume only (LEARNINGS.md). Resolution:
  `scripts/build-boot-disk.sh` mounts our self-hosted System 7.5.5 image
  with hfsutils and copies the compiled Minesweeper into
  `:System Folder:Startup Items:` directly. The image already has its
  System Folder blessed (it was prepared by community emulator users),
  so no `hattrib -b` dance is needed. Once the BasiliskII WASM core
  boots from this disk, Finder will auto-launch the app.
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

### 1. Mac App — Reader, an HTML viewer (`src/app/`)
- Written in C using Mac Toolbox APIs (QuickDraw, Window Manager, Menu
  Manager, Event Manager, Dialog Manager, Resource Manager).
- Targets 68k via Retro68 (`m68k-apple-macos-gcc`).
- Reads HTML files from the boot disk's `:Shared:` folder and renders
  a sensible subset to the screen: paragraphs and line breaks (with
  word-wrap), `h1`-`h3` headings, bold + italic, ordered/unordered
  lists, `<a href="other.md">` links between bundled files, monospace
  `<pre>` blocks, common entities (`&amp;` `&lt;` `&gt;` etc.).
  Out of scope: images, tables, CSS, forms, JavaScript, real network
  fetching.
- Standard Mac UI: document window with vertical scroll bar, Apple /
  File / Edit / View menus, About box, ⌘O (Open from `:Shared:`),
  ⌘R (Reload), ⌘Q (Quit), back-navigation via Backspace.
- **Source layout** (the reusable architectural pattern for any app
  here):
  - `html_parse.{c,h}` — pure-C tokenizer + layout. No Toolbox
    includes. Compiled by both Retro68 (linked into the app) and the
    host C compiler (driven by `tests/unit/test_html_parse.c`,
    11 passing tests covering tokenizer, layout, word-wrap, link
    regions, nested formatting, entity decoding).
  - `reader.c` — Toolbox UI shell. Owns the event loop, draws the
    rendered layout with QuickDraw, handles scroll bar + link clicks,
    reads files from `:Shared:` via `HOpen` / `FSRead`.
  - `reader.r` — Rez resources: `WIND` (document window), `MBAR` +
    `MENU` (Apple/File/Edit/View), `ALRT`+`DITL` (About), `STR#`,
    `vers`, `SIZE`.
- Designed to run on System 7.5.5. Per-app architectural details and
  the swap-in-your-own-app guide live in `src/app/README.md`.

#### Previous demo: Minesweeper

Originally Minesweeper validated the pipeline (9×9 grid, 10 mines,
first-click safety, flood-fill, win/loss detection). It was retired
once the pipeline was end-to-end working — Reader is a more on-brand
demonstration of what the template can build (a Mac-native consumer of
content the host page produces). Forks can resurrect the Minesweeper
sources from git history if they want it as a starting point.

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
  3. `scripts/build-disk-image.sh` packs the compiled `.bin` (MacBinary,
     both forks intact) into a small secondary `dist/app.dsk` (HFS, 1.4 MB)
     with the app placed under `:Startup Items:`. This image is kept for
     forks that may want to mount it as a secondary volume; it is NOT the
     boot disk.
  4. `scripts/build-boot-disk.sh` downloads (with SHA-256 verification +
     local cache) a pre-installed bootable System 7.5.5 hard-disk image
     from the Internet Archive, mounts it via hfsutils, and copies our
     compiled Minesweeper into `:System Folder:Startup Items:` on the
     **blessed** System Folder. The output is `dist/system755-vibe.dsk`
     (~24 MB). The script is idempotent and the upstream image is cached
     across CI runs via `actions/cache@v4`.
  5. `scripts/write-chunked-manifest.py` (invoked with the `--chunk` flag
     to `build-boot-disk.sh`) re-emits the modified disk as a chunked
     manifest + chunk files in the format BasiliskII WASM consumes
     (256 KiB chunks, blake2b-16 with salt `b"raw"`, JSON manifest matching
     `EmulatorChunkedFileSpec`). Algorithm ported from
     `mihaip/infinite-mac@30112da0db` :: `scripts/import-disks.py`.
     Both `.dsk` and `.dsk.json` + chunks ride into the Pages
     deployment; the loader (Component 3) consumes the chunked
     manifest at runtime.
- Artifact validation: `.bin`, `.dsk`, our custom `dist/app.dsk`, and
  the boot disk are sanity-checked with `test -s`; the boot disk
  source is hash-pinned (see Risks). Retro68's `.APPL` artifact is
  sometimes 0 bytes and is excluded from release uploads.

### 3. Web Execution Layer (`src/web/`)
- **Vite + TypeScript** (vanilla TS, no framework). Page chrome is a
  hand-rolled System 7 desktop (menu bar + windowed Read Me + a
  "Macintosh" window where the emulator mounts), styled to period in
  `src/web/src/style.css`.
- Uses pre-built `BasiliskII.js` + `BasiliskII.wasm` from Infinite Mac
  plus the `Quadra-650.rom`. The cores live committed at
  `src/emulator/worker/emscripten/` on `main` — there's no GitHub
  Release or documented CDN. We pin a specific Infinite Mac commit SHA
  and download via `raw.githubusercontent.com` at build time in
  `scripts/fetch-emulator.sh`, with size + SHA-256 verification per
  file. Outputs land in `src/web/public/emulator/` (gitignored). License
  posture: Infinite Mac glue is Apache-2.0 but the compiled BasiliskII
  core itself is **GPL-2.0** from `mihaip/macemu` — the script vendors
  both LICENSE files alongside a NOTICE that pins the upstream commit
  (see LEARNINGS.md 2026-05-08). Run from the repo root:
  `npm run fetch:emulator`.
- Boot lifecycle is owned by `src/web/src/emulator-loader.ts` plus
  the new `src/web/src/emulator-worker.ts` (Web Worker, `type:'module'`):
  1. Loader renders a period-styled progress bar inside
     `#emulator-canvas-mount` (the mount lives inside the marketer's
     `.inset` window).
  2. Loader gates on `crossOriginIsolated` — SAB is required for the
     fast path; if the browser isn't isolated, drops cleanly to STUB
     with a sharper message ("reload to let coi-serviceworker take
     effect").
  3. Loader HEAD-checks the chunked manifest `${bootDiskUrl}.json`. If
     missing, drops to STUB pointing at `scripts/build-boot-disk.sh`.
  4. Loader spawns the worker, hands it the manifest + URLs +
     screen/RAM config.
  5. Worker allocates SharedArrayBuffers (video framebuffer + videoMode
     metadata + Int32 input ring whose offsets match Infinite Mac's
     `InputBufferAddresses` so the WASM ABI lines up), reads chunked
     disk via synchronous XHR (the BasiliskII core calls `disk.read()`
     synchronously from inside Wasm), renders the BasiliskIIPrefs.txt
     template + appended config + ROM + disks into the Emscripten FS,
     and `import()`s `/emulator/BasiliskII.js` (ES module factory).
  6. Worker exposes `globalThis.workerApi` shaped to match upstream
     `EmulatorWorkerApi` exactly — the WASM was compiled against that
     shape and calls into it from Wasm-land for video blits, disk
     reads, idle waits, input polling.
  7. Worker posts video frames into the SAB; loader rAF-loops a
     BGRA→RGBA copy + `putImageData` onto the canvas.
- The port skips audio/clipboard/files/ethernet/CD-ROM/persistent disk
  savers/speed governor — see the long header on `emulator-worker.ts`
  for what was lifted from where in upstream.
- Configured via `src/web/src/emulator-config.ts` (typed):
  - `coreUrl` / `wasmUrl` — Vite-base-relative paths to the vendored
    core.
  - `bootDiskUrl` — `${BASE_URL}system755-vibe.dsk`. Loader resolves
    `${bootDiskUrl}.json` for the manifest and
    `${bootDiskUrl-without-.dsk}-chunks/` for chunk fetches.
  - `appDiskUrl` — `${BASE_URL}app.dsk`, dropped next to `index.html`
    by CI. Currently NOT mounted by the worker (the boot disk now bakes
    the app into Startup Items, so app.dsk is redundant for boot —
    kept around for forks that may want it as a secondary mount).
  - `screen` — emulator native resolution (defaults to 640×480).
- **SharedArrayBuffer / cross-origin isolation:** the Vite dev server
  sets `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` itself. GitHub Pages
  cannot set custom response headers; we ship the ~3KB MIT-licensed
  `coi-serviceworker` shim, vendored at
  `src/web/public/coi-serviceworker.min.js` and loaded as a non-module
  `<script>` at the top of `<head>` (must run before the app script).
  The shim registers a SW, the page reloads once, and the second
  navigation is cross-origin isolated. Fallback if the shim breaks:
  Cloudflare Pages or Netlify (both let you set response headers).
- Strips out Infinite Mac's library browser, multi-OS selector, settings
  panes, IndexedDB persistence, audio worklet, ethernet, file uploads,
  clipboard bridge — our loader is single-purpose.
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
| **BasiliskII WASM init contract** (resolved 2026-05-08) | Ported the minimum-viable subset of `mihaip/infinite-mac@30112da0db`'s worker glue into `src/web/src/emulator-worker.ts` (~480 lines): chunked disk reader, disks API, EmulatorWorkerApi shim, prefs renderer, ROM/prefs FS staging, SAB-based video/input. Verified end-to-end with a real boot attempt — BasiliskII v1.1 prints "Reading ROM file...", paints a frame, and renders the classic "no bootable disk" screen with the floppy-question-mark cursor (see public/screenshot-booted.png). Audio/clipboard/files/ethernet/CD-ROM/IndexedDB persistence are stubbed. |
| **System 7.5.5 redistribution** (we host it ourselves, no longer a CORS issue) | Apple posted complete System 7.5.3 install media to its support site in 2001 with a license permitting free redistribution; the 7.5.5 updater (https://support.apple.com/kb/dl1099) inherits that posture and major archives (Internet Archive, Macintosh Garden, Macintosh Repository) distribute these binaries openly on this basis. NOTICE attributes Apple and explicitly disclaims affiliation; takedown protocol documented. |
| **`build-boot-disk.sh` SHA-256 pin** (locked 2026-05-08) | Pinned to `9126e47cda69…` after the first successful CI run. A hostile CDN substitution now fails CI loudly. Re-pin only if archive.org rebuilds the upstream image. |
| Retro68 Docker image size slows CI | Cache Docker layer in GH Actions; image is ~2GB but caches well. |
| HFS disk image creation on Linux | Use `hfsutils` package (available in Ubuntu runners). |
| BasiliskII WASM file size (1.7MB at the pinned Infinite Mac commit; smaller than original PRD assumed) | Vite serves with Brotli. Hash-verified at build time by `fetch-emulator.sh`. |
| GitHub Pages can't set COOP/COEP for SharedArrayBuffer | Ship `coi-serviceworker` polyfill (MIT, ~3KB) registered from `index.html`. Fallback host is Cloudflare Pages or Netlify if the SW shim breaks. |
| Startup Items auto-launch reliability (verified 2026-05-08) | App is baked into the boot disk's blessed `:System Folder:Startup Items:` at build time. Verified locally: System 7.5.5 boots, Finder runs Startup Items, Minesweeper window paints with its 10×10 grid (`public/screenshot-debug-rom.png`). |
| ROM is `Quadra-650.rom` (~1MB, vendored from Infinite Mac at the pinned commit) | Infinite Mac's only 68040-class ROM at `30112da0db`. Fetched + SHA-pinned by `scripts/fetch-emulator.sh`. Not bundled in our git tree. License posture inherited from Infinite Mac's distribution. |
| BasiliskII core is GPL-2.0 (not Apache-2.0 as originally stated) | NOTICE file pins upstream commit + macemu source repo to satisfy "offer source" obligation. Forks that recompile must vendor macemu source themselves. |
| **`modelid` pref must be `gestaltID − 6`, not the gestalt itself** (resolved 2026-05-08) | A wrong modelid (`36` instead of `30` for Quadra 650) made Gestalt report machine type 42, which isn't a real Mac — System 7.5.5 skipped Toolbox patches keyed off Gestalt and Retro68's runtime hit an unpatched A-line trap (`unimplemented trap` bomb). Cost ~3 rounds of bisection chasing wrong hypotheses (C code, resource fork, Type/Creator) before reading `mihaip/macemu/BasiliskII/src/prefs_items.cpp` revealed the −6 offset. Fixed in `src/web/src/emulator-worker.ts` `BASE_PREFS`. Lesson: when porting an emulator config, copy the formula, not the constant. |

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

POC scope is complete. Status as of 2026-05-08:

1. ✅ **Hello World** — Retro68 compiles, .bin lands in HFS image (CI).
2. ✅ **Auto-launch** — App auto-launches from `:System Folder:Startup
   Items:` on the pre-baked boot disk. Verified live in production.
3. ✅ **Demo app** — *Minesweeper* shipped first to validate the
   pipeline, then replaced by *Reader* (a small classic-Mac HTML
   viewer in C, see `src/app/README.md`) once everything was working
   end-to-end. Both are/were built with the same Toolbox-shell +
   pure-C-engine split. Reader currently demonstrates the full demo
   loop: System 7 boots, Reader auto-launches, reads
   `:Shared:index.html` from the boot disk, renders the page, and
   navigates between bundled HTML files via clicks. 11/11 host
   unit tests passing.
4. ✅ **GitHub Actions pipeline** — Retro68 build, hfsutils HFS pack,
   bootable System 7.5.5 disk download + chunked manifest, HTML
   content baked into `:Shared:`, web build, Pages deploy. End-to-end
   green.
5. ✅ **GitHub Pages deploy** — live at
   https://khawkins98.github.io/classic-vibe-mac/. First fork's deploy
   is one Pages enable + one push.
6. ✅ **Template polish** — README, CONTRIBUTING (Conventional Commits +
   squash policy), LEARNINGS, LICENSE, NOTICE, PR template, Dependabot,
   `src/app/README.md` (per-app docs), `docs/DEVELOPMENT.md` (iteration
   loops), three-layer test scaffold.
7. ✅ **Mouse + keyboard input** (resolved 2026-05-08) — input layer
   ported to participate in BasiliskII's four-state cyclical SAB lock
   (mirrors `mihaip/infinite-mac@30112da0db`'s
   `SharedMemoryEmulatorInput`). Cursor tracks, clicks register, menus
   pull down. Verified locally and live.

### Open work

- **Markdown viewer + basic editor** as a second demo app —
  [#9](https://github.com/khawkins98/classic-vibe-mac/issues/9). Reuses
  the `:Shared:` pattern, adds TextEdit for editing, demonstrates
  two-way file flow.
- **Period chrome polish:** Chicago/Geneva web font vendoring, real
  rainbow Apple in the menu bar, optional startup chime.
- **Full `.claude/agents/` history rewrite:** files were untracked
  going forward, but old commits still contain them. Run
  `git filter-repo --path .claude --invert-paths` once the open
  Dependabot PRs are resolved.
- **Stretch:** Mac OS 9 / PPC via SheepShaver (requires
  non-redistributable ROM — out of POC scope).

---

## Repo Structure (as shipped)

```
classic-vibe-mac/
├── .claude/agents/           ← Mac-specific subagent profiles (5)
├── .github/
│   ├── workflows/
│   │   ├── build.yml         ← Retro68 → disks → web → Pages deploy
│   │   └── test.yml          ← unit + e2e + vision tests
│   ├── dependabot.yml
│   └── pull_request_template.md
├── src/
│   ├── app/                  ← Mac C source (Retro68 + Toolbox)
│   │   ├── CMakeLists.txt
│   │   ├── minesweeper.c     ← Toolbox UI shell
│   │   ├── minesweeper.r     ← Rez resource file
│   │   ├── game_logic.c      ← pure-C engine (host-testable)
│   │   └── game_logic.h
│   └── web/                  ← Vite + TypeScript landing page
│       ├── index.html
│       ├── package.json
│       ├── vite.config.ts
│       ├── public/
│       │   ├── coi-serviceworker.min.js  ← SAB on GH Pages
│       │   └── emulator/                 ← BasiliskII WASM (gitignored)
│       └── src/
│           ├── main.ts                   ← System 7 chrome
│           ├── style.css
│           ├── emulator-config.ts        ← typed config
│           ├── emulator-loader.ts        ← boot lifecycle
│           ├── emulator-worker.ts        ← ported worker glue
│           ├── emulator-worker-types.ts
│           └── emulator-input.ts
├── tests/
│   ├── unit/                 ← host-cc C tests for game_logic
│   ├── e2e/                  ← Playwright vs Vite dev server
│   └── visual/               ← Claude Haiku vision assertions
├── scripts/
│   ├── fetch-emulator.sh     ← download BasiliskII core + ROM (pinned)
│   ├── build-disk-image.sh   ← simple app.dsk packer
│   ├── build-boot-disk.sh    ← bootable System 7.5.5 + chunked manifest
│   ├── write-chunked-manifest.py
│   └── capture-deployed-screenshot.mjs
├── public/                   ← landing-page screenshots, etc.
├── package.json              ← npm workspaces (root + src/web)
├── PRD.md
├── README.md
├── CONTRIBUTING.md
├── LEARNINGS.md              ← growing log of non-obvious findings
├── LICENSE                   ← MIT
└── NOTICE                    ← upstream attribution stack
```
