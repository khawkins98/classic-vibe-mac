# Learnings

A running log of things we've learned building classic-vibe-mac — gotchas,
dead ends, surprises, and decisions worth remembering. The goal is to save
the next person (or future-you) from rediscovering the same lessons.

## How to use this file

- Add an entry whenever you hit something non-obvious: a quirk of Retro68, a
  CORS issue with the Infinite Mac CDN, an HFS tool that didn't behave as
  expected, a System 7 API gotcha, etc.
- Date each entry. Group by topic when patterns emerge.
- Keep entries short — a paragraph or two. Link to commits, PRs, or external
  docs for depth.
- It's fine to record negative results ("tried X, didn't work because Y").
  Those are often the most valuable.

## Format

```
### YYYY-MM-DD — Short title
**Context:** what we were trying to do
**Finding:** what we learned
**Action:** what we did about it (or chose not to)
```

---

## Entries

<!-- Newest entries on top. -->

### 2026-05-08 — BasiliskII WASM init contract: not single-file, not CDN-pluggable
**Context:** Trying to wire `bootDiskUrl` so the page actually boots.
The previous LEARNINGS entry ("Boot disk plumbing") established that
Infinite Mac doesn't host a public single-file boot disk. Path forward
seemed to be either chunk it ourselves or ship a single `.dsk`. Read
`mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12`'s
`src/emulator/worker/worker.ts`, `src/emulator/worker/disks.ts`,
`src/emulator/worker/chunked-disk.ts`, and
`src/emulator/common/common.ts` to find the actual init contract.
**Finding:** The compiled BasiliskII Emscripten Module does NOT accept
a single-file disk URL. ALL disk access flows through their
`EmulatorWorkerChunkedDisk` (or a pluggable `EmulatorWorkerDisk`
interface implementing `read`/`write`/`size`/`name`), and that runs
inside a Web Worker that exposes a `globalThis.workerApi` of type
`EmulatorWorkerApi`. That class wires video (shared-memory or
fallback), input (shared-memory or fallback), audio, files, clipboard,
ethernet, disks, plus a `BasiliskIIPrefs.txt` file written into the
Emscripten FS and a 32-byte device-image header generated per disk.
The `EmulatorWorkerConfig` also takes a `wasm: ArrayBuffer`, a
`workerId`, a `dateOffset`, an `arguments: string[]` for the prefs
file, etc. Wiring all of that is on the order of hundreds of lines of
TypeScript. There is no shortcut; the .wasm was compiled with a
specific init contract and it's the contract.
**Action:** Decision: we ship the **disk** and **chunking** plumbing
now (paths A/B precursor work), but stay in honest STUB mode in the
loader because the init contract isn't ported. The disk flows through
`scripts/build-boot-disk.sh` (download → mount → inject Minesweeper
into `:System Folder:Startup Items:` → optional chunking via
`scripts/write-chunked-manifest.py`). When the worker-glue port lands,
the disk and chunks are already deployed; that PR only has to add the
worker, the EmulatorWorkerApi shim, and the prefs template. Reference
upstream paths are pinned in comments at
`src/web/src/emulator-loader.ts` boot()-phase 3 so the next agent can
pick up the trail without re-deriving.

### 2026-05-08 — Boot disk: build our own (System 7.5.5 from archive.org)
**Context:** Decision point on Path A (single bootable disk),
Path B (chunked manifest), or Path C (defer). Path B is the "right"
answer for the WASM init contract but requires the same worker port
either way (see preceding entry). Path A turns out to be incompatible
with the current .wasm but is still the cheapest *prep* work to do
now, because chunking a single .dsk is a 30-line Python script.
**Finding:** A bootable, pre-installed System 7.5.5 hard-disk image
(`Macos.dsk`, 24 MB) is hosted on the Internet Archive at
`https://archive.org/details/macos755_202104`, packaged for use with
MinivMac/BasiliskII. The System Folder is already blessed, the Finder
is already in place, and there's a `Startup Items` folder ready to
populate. hfsutils' `hcopy -m` decodes our Retro68 MacBinary back into
a real two-fork file with Type/Creator preserved, so dropping
Minesweeper in is a single command. Apple's 2001 free-redistribution
posture for System 7.5.3 (and the 7.5.5 updater) covers redistribution
of these binaries; mainstream archives have been mirroring them
openly on this basis for 25 years. License/attribution lives in the
new `NOTICE` at the repo root.
**Action:** `scripts/build-boot-disk.sh` downloads (with cache + SHA
verification + retry-on-302), mounts via `hmount`, lists/inspects via
`hattrib` and `hls`, copies via `hcopy -m`, unmounts, and writes
`dist/system755-vibe.dsk`. CI caches the upstream blob across runs via
`actions/cache@v4` so we hit archive.org once per cache-key bump, not
on every push. The SHA-256 pin in the script is a placeholder for now
— first successful CI run will print the observed hash to be locked
in (tracked as a Risk in PRD). The `--chunk` flag invokes
`scripts/write-chunked-manifest.py` (algorithmic port of Infinite
Mac's `write_chunked_image()`) to emit the chunked manifest format
the WASM consumes; this isn't wired in CI yet because there's no
loader to consume it, but the script is dependency-light (python3
stdlib only) and ready when the worker port lands.

### 2026-05-08 — Boot disk plumbing: System 7.5.5 has no public single-file URL
**Context:** Wiring BasiliskII WASM into the page. Plan was to point the
emulator at something like `https://infinitemac.org/disks/system-7.5.5.json`
as a boot disk URL.
**Finding:** Infinite Mac doesn't serve disk images as single files. The
boot disk is a *chunked* file: a build-generated JSON manifest
(`@/Data/System 7.5.5 HD.dsk.json` — NOT in the repo) lists ~190
SHA-named chunk filenames, which the worker fetches incrementally from a
private Cloudflare R2 bucket (`infinite-mac-disk`) routed through
system7.app / macos8.app / etc. There is no documented public URL
pattern, no GitHub-hosted copy, and the manifest itself is a build
artifact of Infinite Mac's pipeline (run via `scripts/import-disks.py`
against an Apple-provided System 7.5.5 image). Confirmed by reading
`src/emulator/common/common.ts` (`generateChunkUrl`),
`src/emulator/ui/config.ts` (`configToMacemuPrefs`),
`src/defs/disks.ts` (`SYSTEM_7_5_5.generatedSpec`), and the
top-level `wrangler.jsonc` (`r2_buckets: [{bucket_name:
"infinite-mac-disk"}]`) at infinite-mac@30112da0.
**Action:** Set `EmulatorConfig.bootDiskUrl = null`. The loader fetches
the WASM core successfully (real bytes, period-styled progress bar in
`.inset`), then enters a STUB phase that renders "Welcome to Macintosh"
and an explanation inside the marketer's window chrome. Path forward, in
order of effort: (1) generate our own chunked manifest from a System
7.5.5 ISO via Infinite Mac's `scripts/import-disks.py` and host the
chunks under `/disks/` on GH Pages (~150MB across many small files —
within Pages limits, lazy-loaded by chunk index); (2) ask upstream for a
stable public URL pattern; (3) ship a single-file System 7.5.5 .dsk and
recompile BasiliskII WASM with the non-chunked disk path enabled.
Recommend (1). This is the project's biggest remaining unknown for
end-to-end "boot in the browser."

### 2026-05-08 — BasiliskII WASM is GPL-2.0, not Apache-2.0
**Context:** Updating fetch-emulator.sh to vendor LICENSE/NOTICE files
alongside the binaries. The role brief and earlier PRD framed the
relevant license as Apache-2.0.
**Finding:** Infinite Mac's TypeScript glue is Apache-2.0, but the
compiled BasiliskII core is built from
`mihaip/macemu/BasiliskII/COPYING`, which is GPL-2.0. That means
redistributing the .wasm — which we do, by serving it from GH Pages —
inherits GPL-2.0 §3 obligations (corresponding source must be available
on request). Linking the upstream macemu commit satisfies the offer-source
obligation as long as we don't modify the binary.
**Action:** `scripts/fetch-emulator.sh` writes a NOTICE file calling out
both licenses and pinning the upstream commit + macemu repo. The
`src/web/.gitignore` ignores the .wasm/.js but explicitly negates
`LICENSE-infinite-mac` and `NOTICE` so they always travel with the
binaries in `dist/`. A downstream fork that wants to recompile BasiliskII
needs to vendor the macemu source (or otherwise satisfy GPL §3 itself).

### 2026-05-08 — GitHub Pages can't set COOP/COEP; SAB needs a service-worker shim
**Context:** Wiring the GH Pages deploy job for the Vite-built web frontend.
BasiliskII WASM needs `SharedArrayBuffer`, which the browser only exposes
in a cross-origin-isolated context (requires the response to carry
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`).
**Finding:** GitHub Pages serves a fixed set of headers and offers no way
to configure custom response headers — there's no `_headers` file equivalent,
no `web.config`, nothing. Confirmed by the long-running
`isaacs/github` Pages issues and several upstream Emscripten threads. Vite's
own dev server sets the headers (see `src/web/vite.config.ts`), so it works
locally; production breaks silently when the emulator tries to allocate a
`SharedArrayBuffer`.
**Action:** Workaround is `coi-serviceworker` — a tiny service worker that
re-fetches the page and injects the COOP/COEP headers on the way back, so
the second load is cross-origin-isolated. There's a Vite plugin wrapper. The
emulator-integration-engineer owns wiring it in; the build pipeline only
flags the constraint via an inline comment in the deploy job and a note in
PRD.md Component 4. If coi-serviceworker proves flaky, fallback is to host
on Cloudflare Pages (`_headers` file) or Netlify (`netlify.toml`) — both let
you set arbitrary response headers, GH Pages can't.

### 2026-05-08 — Use the official Pages actions, not gh-pages branch pushes
**Context:** PRD originally said "deploy to gh-pages branch." Decision point
on which deploy mechanism to use.
**Finding:** GitHub now ships first-party
`actions/upload-pages-artifact` + `actions/deploy-pages` actions that
publish via the Pages "environment" (not via a long-lived branch). They
handle the OIDC handshake, surface the deploy URL on the run summary, and
play nicely with environment protection rules. The third-party
`peaceiris/actions-gh-pages` and the npm `gh-pages` package are both still
common but require either a PAT or write access to a `gh-pages` branch and
miss the environment integration.
**Action:** Use the official actions in `.github/workflows/build.yml`. Repo
must have Pages enabled with "Source: GitHub Actions" in the repo settings —
this is a one-time manual step per fork. Document this in README when the
template-polish milestone lands. Concurrency group `pages-${{ github.ref }}`
with `cancel-in-progress: false` to avoid wedging deploy-pages mid-publish.

### 2026-05-08 — Chicago web font: no clean CDN, fall back to a stack
**Context:** Building the landing page chrome to feel period-authentic. The
role brief suggested ChicagoFLF (GPL) or "Chikarego" as the header font.
**Finding:** ChicagoFLF is real and GPL-licensed, but there is no canonical
CDN that serves it — the usual sources are personal GitHub repos and
abandonware archives, none of them pinnable in good conscience for a
template that other people will fork. Chikarego is similarly hosted in
fragmented places. Loading either properly means vendoring the .woff2 plus
its LICENSE/NOTICE into `src/web/public/fonts/`.
**Action:** For now we punt: `src/web/src/style.css` uses
`"Chicago", "ChicagoFLF", "Charcoal", "Geneva", -apple-system, ...`. Visitors
who happen to have Chicago installed locally see it; everyone else gets
Geneva, Helvetica, or the system sans. If we want the period look
guaranteed, the next step is to vendor a GPL-clean Chicago `.woff2` under
`src/web/public/fonts/` with a `LICENSE.txt` alongside, and wire an
`@font-face` rule. Logged so we don't accidentally pull a shady CDN copy
later.

### 2026-05-08 — Installing hfsutils inside the Retro68 container
**Context:** Wiring `scripts/build-disk-image.sh` into `.github/workflows/build.yml`
as a follow-on step to the CMake build. The script needs `hformat`/`hmount`/
`hcopy` from the `hfsutils` Debian package, which is not preinstalled in
`ghcr.io/autc04/retro68:latest`.
**Finding:** The Retro68 image is Debian-based and the GH Actions job runs as
root inside the container, so plain `apt-get update && apt-get install -y
hfsutils` works — no `sudo` (sudo isn't even installed) and no extra repos
required. `hfsutils` is in Debian main. The package is small (≈100KB) so the
install adds negligible CI time. Critically, do NOT install `hfsprogs`
instead — that's HFS+ tooling (`mkfs.hfs` there builds HFS+), and Basilisk
II / classic Mac OS through 8.0 only read HFS. Mounting an HFS+ image
silently fails on the emulator side.
**Action:** Added an "Install hfsutils" step in `build.yml` before the CMake
configure step, with an inline comment calling out the hfsutils-vs-hfsprogs
trap. The disk-image step itself runs `./scripts/build-disk-image.sh
build/Minesweeper.bin dist/app.dsk` after the build, and `dist/app.dsk` is
appended to the existing workflow artifact alongside the Retro68 outputs.

### 2026-05-07 — Retro68 distribution: Docker image, not tarballs
**Context:** Setting up CI to cross-compile a Mac 68k app. PRD suggested either
prebuilt Retro68 tarballs or a Docker image; we needed to pick one.
**Finding:** autc04/Retro68 has not published a tagged release since v2019.8.2
(Aug 2019), and those releases ship no asset binaries — just source. The
project's actual distribution channel is the rolling Docker image
`ghcr.io/autc04/retro68:latest`, rebuilt automatically on every commit to
Retro68 master. README and real-world workflows (manufarfaro/armadillo-editor,
ClassiCube, schismtracker) all use the Docker image.
**Action:** Use `container: ghcr.io/autc04/retro68:latest` in build.yml. No
toolchain caching needed — GH Actions pulls and caches the image automatically,
and avoiding a from-source toolchain build saves ~1 hour per cold run.

### 2026-05-07 — Retro68 .APPL artifact may be 0 bytes
**Context:** Deciding which build outputs to upload as workflow artifacts and
later release assets.
**Finding:** `add_application(Foo foo.c)` produces several outputs: `Foo.bin`
(MacBinary, both forks), `Foo.dsk` (mountable HFS image with the app inside),
and `Foo.APPL`. The `.APPL` is the data fork only — for resource-only apps
it's literally 0 bytes, which crashes the GitHub Releases upload API.
**Action:** Treat `.bin` and `.dsk` as the canonical artifacts. We still
upload `.APPL` to the workflow artifact (the zip wrapper is fine with 0-byte
files), but anything that hits the Releases API later must use `.bin`/`.dsk`
only. Verify step in build.yml uses `test -s` on `.bin` and `.dsk` only.

### 2026-05-07 — Retro68 toolchain file path
**Context:** Wiring up CMake `-DCMAKE_TOOLCHAIN_FILE=...`.
**Finding:** The path inside the Docker image is
`/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake`
(note the `m68k-apple-macos/cmake/` segment — older snippets sometimes show
a flatter `toolchain/m68k-apple-macos.cmake` path that doesn't exist in
current builds). The PPC equivalent lives at
`powerpc-apple-macos/cmake/retroppc.toolchain.cmake` if we ever pursue the
OS 9 stretch goal.
**Action:** Hardcoded the m68k path in build.yml and the comment block in
src/app/CMakeLists.txt.

### 2026-05-07 — "Startup Items" only auto-launches from the boot volume's blessed System Folder
**Context:** PRD plan was to ship a tiny secondary `app.dsk` containing a
`Startup Items` folder, mount it next to Infinite Mac's CDN-hosted System 7.5.5
boot disk, and let the app auto-launch on boot.
**Finding:** In classic Mac OS (System 7 through 9.2.2), Startup Items is a
Finder convention tied to the *active blessed* System Folder on the boot volume.
The Finder scans exactly that one folder at login and launches its contents.
A `Startup Items` folder on a secondary mounted disk has no special meaning —
it's just a regular folder. So the current architecture (boot from CDN disk +
mount our secondary `app.dsk`) will not auto-launch by itself.
**Action:** `scripts/build-disk-image.sh` still places the binary in a
`Startup Items` folder on the secondary disk (so the structure is right for
future work), but we need one of these to actually trigger auto-launch:
  1. Inject the app into the boot disk's System Folder/Startup Items at
     emulator-config time (requires writable boot disk or an overlay).
  2. Make our disk the bootable one (ship a minimal blessed System Folder on it,
     or merge with a System 7.5.5 image at build time).
  3. Have the web layer drive Basilisk II to open the app post-boot
     (no real automation hook in BasiliskII WASM, so this is the weakest option).
Option 1 or 2 is the path forward. Logged so the next agent doesn't spend a
day debugging "why doesn't my app launch."

### 2026-05-07 — Infinite Mac WASM artifacts are vendored in git, not released
**Context:** Scaffolding the web frontend; PRD assumed we'd pull pre-built
`BasiliskII.wasm` from "Infinite Mac releases."
**Finding:** mihaip/infinite-mac has no GitHub Releases that ship the WASM
binaries. The compiled emulator cores (`BasiliskII.wasm`, `BasiliskII.js`,
`SheepShaver.wasm`, several `minivmac-*.wasm`, `dingusppc.wasm`, `ppc.wasm`,
`previous.wasm`, `snow.wasm`) live committed in
`src/emulator/worker/emscripten/` on the `main` branch. There's also no
documented stable CDN URL pattern for them — infinitemac.org serves them from
its own bundle, not as a public API.
**Action:** For the POC the web build will fetch the BasiliskII core directly
from `raw.githubusercontent.com/mihaip/infinite-mac/main/src/emulator/worker/emscripten/`
at build time (a small script in `scripts/`, not yet implemented — TODO in
`src/web/README.md`). Longer-term we may want to pin a specific commit SHA
to avoid upstream churn, and/or vendor copies into `public/` with proper
Apache-2.0 NOTICE attribution. Infinite Mac's license is Apache-2.0, so
redistribution is fine as long as we keep the LICENSE + NOTICE.
