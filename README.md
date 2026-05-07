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

A live demo lives at the GitHub Pages URL once the first CI run finishes
and Pages is enabled. To run locally:

```sh
git clone https://github.com/your-fork/classic-vibe-mac.git
cd classic-vibe-mac
npm install
npm run fetch:emulator   # downloads BasiliskII WASM + Quadra ROM
bash scripts/build-boot-disk.sh   # builds the bootable System 7.5.5 disk
npm run dev
```

Open `http://localhost:5173`. The page boots BasiliskII in a Web Worker,
mounts the boot disk, and the Finder auto-launches Minesweeper from
`System Folder/Startup Items`.

## Requirements

- A current desktop browser (Chrome, Firefox, Safari).
- For local development: Node 20+ and npm.
- No local emulator, no system disk, no ROM hunting. The build container
  brings the toolchain; the OS disk is fetched from Infinite Mac.

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
