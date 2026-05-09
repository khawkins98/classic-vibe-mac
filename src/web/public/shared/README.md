# Classic Vibe Mac

Welcome to **Classic Vibe Mac** — a project for running and developing
*classic Macintosh* software directly in your web browser.

## What Is This?

This project boots **System 7.5.5** inside a WASM build of BasiliskII, giving
you a real 68k Mac environment in any modern browser.

The twist: it also ships a full **in-browser code playground** built around
the Mac's scripting heritage. Write C or HyperTalk-style scripts, compile
them, and run the results inside the emulated Mac — all without leaving the page.

## Getting Started

1. Clone the repository:

```
git clone https://github.com/khawkins98/classic-vibe-mac.git
```

2. Install dependencies:

```
npm install
```

3. Start the local dev server:

```
npm run dev
```

Then open `http://localhost:8080` in your browser.

## Included Applications

- **Reader** — a simple HTML document viewer. Opens `.html` files from `:Shared:`.
- **MacWeather** — displays current weather via the open-meteo API.
- **Pixel Pad** — a minimal pixel-art canvas tool.
- **Markdown Viewer** — this app! Opens `.md` files from `:Shared:`.

## Markdown Viewer Features

The Markdown Viewer supports:

- ATX headings (`#`, `##`, `###`)
- **Bold** via `**double asterisks**` or `__underscores__`
- *Italic* via `*single asterisks*` or `_underscores_`
- `Inline code` via backticks
- Fenced code blocks (``` triple backticks ```)
- Unordered lists (`-`, `*`, `+`)
- Ordered lists (`1.`, `2.`, …) — rendered as bullet points
- Blockquotes (`>`)
- Links (`[text](url)`) — shown underlined; navigation is v2 scope
- Thematic breaks (`---`)
- Blank-line paragraph spacing

> This viewer is a native 68k Mac application compiled with Retro68.
> It runs entirely inside the emulated System 7 environment.

## Architecture

The project is organised around three layers:

1. **Web shell** (`src/web/`) — static HTML/JS that boots BasiliskII WASM,
   patches the HFS boot disk, and sets up the shared filesystem bridge.

2. **Mac applications** (`src/app/`) — Classic Mac Toolbox apps compiled with
   Retro68 to 68k code and baked into the boot disk image at build time.
   Each app follows the same pipeline:

   - Pure-C parser (no Toolbox) — `html_parse.c`, `markdown_parse.c`, etc.
   - Toolbox shell — `reader.c`, `markdownviewer.c`, etc.

3. **Build tooling** (`scripts/`) — shell scripts that assemble the HFS boot
   disk, copy shared content files, and set HFS file type/creator codes.

## Contributing

Pull requests are welcome! Please read `CONTRIBUTING.md` before submitting.
All Mac apps must remain compilable by both Retro68 (68k target) and the
host compiler (for unit testing the pure-C layers).

---

*System 7.5.5 is available as a free download from Apple's vintage software
archive. BasiliskII is open-source and available on GitHub.*
