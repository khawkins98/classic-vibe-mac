# classic-mac-builder

A GitHub template that compiles a classic Mac OS app from C source and serves it
running in the browser via GitHub Pages — no local emulator needed.

**Demo app:** Minesweeper clone running inside System 7.5.5 (Basilisk II / WebAssembly).

## How it works

1. Write your Mac app in C using Mac Toolbox APIs (`src/app/`)
2. Push to GitHub — Actions compiles it with Retro68 and packs it into an HFS disk image
3. The disk image is served alongside a stripped Infinite Mac web layer on GitHub Pages
4. Visitors open the URL and the app auto-launches inside the emulated Mac

## Getting started

See [PRD.md](./PRD.md) for the full architecture and milestones.

## Stack

- [Retro68](https://github.com/autc04/Retro68) — cross-compiler (modern OS → 68k Mac binary)
- [Infinite Mac](https://github.com/mihaip/infinite-mac) — BasiliskII compiled to WebAssembly
- System 7.5.5 — freely redistributable Mac OS
- GitHub Actions + GitHub Pages

## License

MIT
