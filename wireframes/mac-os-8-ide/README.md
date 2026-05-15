# Wireframe — Mac OS 8 IDE layout

Static HTML/CSS sketch of the layout proposed in
[cv-mac #104](https://github.com/khawkins98/classic-vibe-mac/issues/104).
No build step. No real behavior. Open in a browser and look at it.

## View it

```sh
# From the repo root:
open wireframes/mac-os-8-ide/index.html
# or just double-click the file
```

That's it. No server required — WinBox loads via CDN.

## What's in the sketch

A static rendering of the proposed three-column-plus-bottom layout
at desktop width (~1280–1920px). The layout:

```
+----------------------------------------------------------------------+
| Menu bar: 🍎 File Edit Project Build Window Help     Fri, May 15    |
+--------+------------------------+---------------------------------+
| Files  |                        |   Macintosh — System 7.5.5      |
| (1/5)  |   hello.c — Wasm Hello |   (2/5 width, ~60% height)      |
|        |   (2/5 width)          |                                 |
|        |                        |   [BasiliskII canvas]           |
| 📄 hello.c (active)             |                                 |
| 📄 README.md                    |                                 |
|        |   #include "Types.h"   |                                 |
| ⚙ Build options                 +---------------------------------+
| ⚙ Memory (SIZE)                 |   Output                        |
|        |   ...                  |   [Build log] Console           |
| + Add file…                     |   [Show Assembly] Diagnostics   |
|        |                        |                                 |
| Open project…                   |   [cc1] -mcpu=68020 …  36ms ✓   |
| Import .zip / Export .zip       |   [as]  -march=68020 …  1ms ✓   |
+--------+------------------------+---------------------------------+
```

### Static panes (CSS grid — *not* WinBox)

The four main IDE panes are docked. They're laid out with plain CSS
grid; they're not draggable. WinBox is overkill for docked layout.

- **Files panel (left, 1/5 width).** Mac OS 8-style icon-list
  sidebar. Lists project files, settings, with a footer of project-
  management buttons (Open, Import, Export). Inspired by the
  sidebar in Mac OS 8's Internet control panel.
- **Editor (center, 2/5 width).** Toolbar (Build / Build & Run /
  Find / Help), tab bar, source area, status line at the bottom.
  This is where the user's eyes spend most of their time.
- **Mac (top-right, 2/5 width).** Live preview of the binary. Smaller
  than today's hero-Mac but still comfortably wider than the
  emulator's native 640px at 1280px+ viewports.
- **Output (bottom-right, 2/5 width).** Tabbed: Build log, Console
  (DebugStr + DrawString capture), Show Assembly, Diagnostics. The
  permanent home for everything that today gets `console.log`-ed and
  ignored.

### Floating WinBox surfaces

Click the toolbar buttons in the editor pane to see WinBox in action:

- **Open project…** (in the files-panel footer) opens a modal-style
  startup picker with the six current demo projects as cards plus
  an Open .zip / New empty / Recent row. Use this same dialog
  auto-opened on first visit (a `DOMContentLoaded` listener in the
  HTML is commented out — uncomment to demo).
- **Find** (in the editor toolbar) opens a draggable Find/Replace
  palette. Persists across pane interactions.
- **Help** (in the editor toolbar) opens a Quick-start Help palette.

These are draggable, resizable, closable, minimizable. The Find and
Help palettes are exactly the floating-palette feel the issue calls
for — without us having to write any window-management code, WinBox
handles drag/resize/min/max.

## What the wireframe *doesn't* do

- No CodeMirror — the editor pane is a syntax-highlighted `<pre>` with
  hand-stamped class names.
- No BasiliskII — the Mac canvas is a black box with a placeholder
  label.
- No actual compile pipeline — the "Build log" is canned text.
- No mobile / narrow viewport support — the wireframe assumes ≥1280px.
- No persistence — refresh wipes any WinBox state.
- No file-tree-to-editor wiring — clicking a file in the left panel
  doesn't actually open it.

All of those are deferred to the real implementation. The wireframe's
only job is to show the *shape*.

## Things to look at + decisions to make

- Are the proportions (1/5 + 2/5 + 2/5, with the right column split
  60/40 top-to-bottom) right? Easy to tweak in `wireframe.css`'s
  `.ide { grid-template-columns; grid-template-rows; }` rules.
- Is the Mac canvas readable at 2/5 width? Check at 1280px and
  1920px viewport widths.
- Is the files-panel icon-list dense enough? Sparse enough?
- Does WinBox's modal styling read as Mac OS 8 with the overrides
  in the bottom of `wireframe.css`? Or does it need more work?
- Should the startup picker auto-open on first visit, or be on-demand?

## When the wireframe is approved

Implementation phases per cv-mac #104:

1. **Phase 2 — DOM restructure.** Replace `src/web/src/main.ts`'s
   current split-pane HTML with the wireframe's grid. Move the
   existing playground innards into the editor column. Wire the
   Mac into the top-right pane.
2. **Phase 3 — Startup project picker.** Real WinBox modal that
   reads from `SAMPLE_PROJECTS` and bootstraps the editor with the
   selected project.
3. **Phase 4 — Output panel.** Move Show Assembly into the bottom-
   right pane as a tab. Wire compiler stdout into a Build log tab.
4. **Phase 5 — Import / Export improvements.** "Open .zip"
   complement to the existing "Download .zip."
5. **Phase 6 — Floating palettes.** Find/Replace, Help.

The wireframe doesn't need to ship to production — it's a design
artifact, not a feature. After cv-mac #104's implementation lands,
this directory can stay as historical reference or be deleted.
