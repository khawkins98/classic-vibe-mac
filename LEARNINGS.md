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
