# classic-vibe-mac

A GitHub template for building a classic Macintosh app in C and serving it,
running, in a browser. Push your source. The template compiles it for the 68k
Mac, packs the binary into an HFS disk image, and boots it inside System
7.5.5 on a WebAssembly Basilisk II.

It is, more or less, a 1993 Macintosh that lives at a URL.

## Live at

**https://khawkins98.github.io/classic-vibe-mac/**

## What it looks like

![Live deployed page: System 7 desktop chrome around the BasiliskII emulator window. System 7 has booted, Minesweeper has auto-launched from Startup Items, and a classic Mac bomb dialog is open showing 'unimplemented trap' — a runtime bug in the demo app, not the pipeline.](public/screenshot-deployed.png)

The screenshot above is the deployed page right now: the full pipeline
runs, BasiliskII boots, the Finder auto-launches our Minesweeper from
`System Folder/Startup Items`, and we hit a Toolbox trap the ROM
doesn't implement (a runtime bug to debug). The chrome is real, the
boot is real, the auto-launch is real — the app is what needs fixing.

## What it does

- Cross-compiles C source to a 68k Mac binary using **Retro68**, in GitHub
  Actions, in a clean container.
- Packs the binary into a small HFS disk image with `hfsutils`.
- Hosts a Vite + TypeScript page that will mount **Basilisk II** (compiled to
  WebAssembly by the Infinite Mac project) and boot System 7.5.5.
- Ships a three-layer test setup: host C unit tests for game logic,
  Playwright end-to-end tests against the dev server, and AI vision
  assertions on canvas screenshots (because pixel-diffing an emulated CRT
  is a losing game).
- Comes with a Minesweeper clone in progress as the demo app and proof
  that the pipeline works end to end.

## How to use it

A live demo lives at https://khawkins98.github.io/classic-vibe-mac/.

To run locally, you need three pieces in `src/web/public/`:

1. The BasiliskII WASM core + ROM (fetched from Infinite Mac).
2. The bootable System 7.5.5 disk with your compiled app pre-installed
   in `System Folder/Startup Items`.
3. A small secondary `app.dsk` (currently unused at runtime, but the
   loader HEAD-checks for it).

The compiled Mac binary itself comes from CI — building Retro68 locally
takes about an hour, so the easiest path is to download the latest CI
artifact instead.

```sh
# One-time setup
brew install hfsutils                    # for HFS disk packing (macOS)
git clone https://github.com/your-fork/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run fetch:emulator                   # BasiliskII.wasm + Quadra-650.rom

# Pull the latest compiled Minesweeper binary from CI
gh run download \
  "$(gh run list --branch main --workflow Build --limit 1 --json databaseId -q '.[0].databaseId')" \
  -D /tmp/cvm-artifact

# Resolve the artifact path (its name carries the commit SHA)
ART="$(echo /tmp/cvm-artifact/Minesweeper-*)"

# Build the bootable System 7.5.5 disk (writes the disk + chunked manifest
# + chunks dir alongside, all under src/web/public/ where Vite serves them)
bash scripts/build-boot-disk.sh \
  "$ART/build/Minesweeper.bin" \
  src/web/public/system755-vibe.dsk

# Copy the secondary app.dsk too (the loader HEAD-checks for it)
cp "$ART/dist/app.dsk" src/web/public/app.dsk

# Serve
npm run dev
```

Open `http://localhost:5173/`. The Vite dev server already sets the
COOP/COEP headers BasiliskII needs for `SharedArrayBuffer`, so cross-
origin isolation works without the service-worker reload dance you'll
see on the production GitHub Pages deploy.

If you skip the `gh run download` + `build-boot-disk.sh` steps the page
still loads — the loader falls into a stub state that renders the
chrome but skips emulation. Useful for iterating on the page itself.

### Building the Mac binary locally

If you want to compile the Mac binary yourself (rather than pulling
from CI), you'll need Retro68. The fastest way is the same Docker
image CI uses:

```sh
docker run --rm -v $PWD:/work -w /work ghcr.io/autc04/retro68:latest \
  bash -c "cmake -S src/app -B build \
    -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
    && cmake --build build --parallel"
```

That writes `build/Minesweeper.bin` (and `build/Minesweeper.dsk`,
`build/Minesweeper.APPL`) — feed `Minesweeper.bin` into
`scripts/build-boot-disk.sh` the same way the CI flow above does.

## Requirements

- A current desktop browser (Chrome, Firefox, Safari).
- For local development: Node 20+, npm, and `hfsutils` (`brew install
  hfsutils` on macOS, `apt-get install hfsutils` on Debian/Ubuntu).
- For local Mac binary builds: Docker (to run the Retro68 image) — or
  just pull the latest CI artifact, which is faster.
- The OS disk is downloaded once from archive.org during the boot-disk
  build; ROM and BasiliskII core come from Infinite Mac. None are
  bundled in this repository.

## How to make your own app

This repository is structured as a template — the demo app is a placeholder
for *your* app.

1. **Fork** this repository (or click "Use this template" on GitHub).
2. **Replace `src/app/`** with your own C source. Keep the `CMakeLists.txt`
   pattern; Retro68 expects an `add_application(YourApp your.c)` call.
3. **Push to `main`.** GitHub Actions builds the binary, packs the disk
   image, and (when the deploy job lands) publishes the result to GitHub
   Pages.
4. **Open your repo's Pages URL.** Your app, in the browser, on a Mac.

The web layer in `src/web/` doesn't usually need touching — it's the
"container" the OS boots in. Edit it if you want a different page chrome
around the emulator.

For architecture notes and milestones, see [PRD.md](./PRD.md). For the
log of things we learned the hard way, see [LEARNINGS.md](./LEARNINGS.md).

## Coming soon

- Debug the "unimplemented trap" bomb the demo app hits right after
  the Finder launches it. The pipeline is wired; the bug is in the C
  code or the SIZE/MBAR/WIND resources. Likely candidates: a Toolbox
  call the Quadra-650 ROM doesn't implement, a missing `MoreMasters`,
  or a resource ID collision.
- Polish on the period chrome — Chicago/Geneva web fonts, a real
  rainbow Apple in the menu bar, the startup chime.
- Stretch: Mac OS 9 / PPC support via SheepShaver and Retro68's PPC
  toolchain (requires a non-redistributable ROM, complicating things).

## Credits

Built on the work of others who did the heavy lifting:

- **[Retro68](https://github.com/autc04/Retro68)** by Wolfgang Thaller and
  contributors — the cross-compiler that makes 68k Mac binaries from
  modern source.
- **[Infinite Mac](https://github.com/mihaip/infinite-mac)** by Mihai
  Parparita — Basilisk II and SheepShaver compiled to WebAssembly, plus
  the chunked disk-fetch infrastructure we're leaning on.
- **Basilisk II** by Christian Bauer and the open-source community — the
  68k Mac emulator that all of this rides on.
- **System 7.5.5** by Apple Computer, freely redistributed since 2001.
- **Susan Kare**, in spirit, for the icons that taught the world what
  computers were allowed to look like.

## License

MIT for our code. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for the
attribution stack: BasiliskII (GPL-2.0), Infinite Mac (Apache-2.0),
Retro68 (MIT-style), System 7.5.5 (Apple's 1998 free-redistribution
release). When the emulator core ships next to a deploy, its own LICENSE
and NOTICE files travel with it.
