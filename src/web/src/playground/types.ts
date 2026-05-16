/**
 * Shared types for the in-browser playground.
 *
 * The playground (Phase 1) is a read-only-leaning C/Rez source viewer with
 * single-file edit + IndexedDB persistence + zip download. It does NOT
 * compile anything yet — that's a later milestone. See PRD.md / Issue #21.
 */

/**
 * One sample project that ships in the bundle. The first cut covers the
 * two existing demo apps (`reader`, `macweather`) with their `.c` / `.r` /
 * `.h` source files only — no build outputs, no boot disks.
 *
 * `files` is the canonical, bundle-version source. We persist a per-file
 * copy in IndexedDB the first time the user opens the project so edits
 * survive reloads. On `bundleVersion` change we wipe those copies (silent;
 * the deferred 3-way diff lives on the Phase 2 list).
 *
 * `rezFile` (when non-null) names the `.r` file the playground
 * compiles via wasm-rez; the resulting resource fork is spliced
 * over the C-built fork by `spliceResourceFork`. When null, the
 * project compiles a single `.c` (or a multi-file C bundle) end-to-end
 * through the in-browser toolchain (cc1 → as → ld → Elf2Mac).
 *
 * `outputName` is the filename for the user's download.
 * `appType`/`appCreator` are documented HFS Type/Creator codes — used
 * by the signature lock-check on Path B builds.
 */
export interface SampleProject {
  /** Stable id used as the IDB key prefix and in the URL/dropdown. */
  id: string;
  /** Human label shown in the project dropdown. */
  label: string;
  /** Filenames to expose in the file dropdown, ORDERED by intended reveal. */
  files: string[];
  /**
   * The `.r` file the playground compiles via wasm-rez. When `null`,
   * Build & Run uses the in-browser C toolchain directly (Path A);
   * when non-null, both .c and .r compile in-browser and the resulting
   * forks are spliced together (Path B).
   */
  rezFile: string | null;
  /** Filename used for the Build button's download. */
  outputName: string;
  /** Doc-only: Mac OS HFS Type code. */
  appType: string;
  /** Doc-only: Mac OS HFS Creator code. */
  appCreator: string;
  /**
   * Complexity rating, 1-6 stars, shown as a `★`/`☆` prefix in the
   * project dropdown so visitors can find an on-ramp matched to their
   * current comfort level (cv-mac #233 — stepped-complexity demo
   * curation). Rough scale:
   *   1 — trivial; one file, < 50 lines, one concept (open a window,
   *       print a string). The "this is what a Mac app looks like at
   *       absolute minimum" rung.
   *   2 — single concept, single file (.c + .r). Demonstrates one
   *       Toolbox surface cleanly (sound, cursor, patterns, colour,
   *       etc.) without stacking other affordances on top.
   *   3 — interactive single-window app. Real event loop, menus or
   *       dialogs, user input, drawing or text editing — the "I could
   *       actually use this" tier (snake, calculator, notepad,
   *       scrollwin, files).
   *   4 — multi-window or multi-file. Front-window dispatch, refCon
   *       state, OR split source organization (engine/UI separation,
   *       shared headers). Where the program structure starts to
   *       matter as much as the Toolbox surface.
   *   5 — multi-file with *in-source* binary assets (custom ICN#/
   *       CICN/PICT compiled from Rez hex literals). The asset and
   *       the code travel together in the same project; the build
   *       pipeline just compiles them.
   *   6 — multi-file with a *separate external* binary asset file
   *       (`.rsrc.bin`) shipped alongside the app on the same disk
   *       and loaded at runtime via `OpenResFile`. The asset is no
   *       longer in source — it's a build-time-produced artefact
   *       the splice infra (#251) ferries onto the disk. The rung
   *       where "the app has dependencies on data files" first
   *       becomes real.
   */
  complexity: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Optional list of binary resource files (`.rsrc.bin`) shipped
   * alongside this app on the same hot-load disk. Each file's
   * resource fork is loaded at build time and spliced into the
   * disk via `PatchOptions.extraFiles.resourceFork` (#251 infra).
   * The app reads them at runtime via `OpenResFile(<filename
   * without .bin>)` — convention: an `icons.rsrc.bin` file is
   * opened as `OpenResFile("Icons")` on the disk (the `.bin`
   * suffix is stripped because it's a host-side host-filesystem
   * convention; the on-disk Mac file is just `Icons`).
   *
   * Filenames sort case-insensitively *after* the main app's
   * filename in HFS catalog key order (same constraint as
   * `PatchOptions.extraFiles`). For most apps this is satisfied
   * naturally — app names start with a capital letter (e.g.
   * "Reader" or no-affix "wasm-icon-gallery" project's output
   * "WasmIconGallery") and asset filenames start lower-case.
   */
  binaryAssets?: string[];
}

/**
 * Render a project's complexity rating as a 6-character ★/☆ string
 * suitable for plain-text contexts like a `<select>` option label.
 * `★★★☆☆☆` for a level-3 project; `★★★★★★` for the top tier.
 */
export function complexityStars(level: 1 | 2 | 3 | 4 | 5 | 6): string {
  return "★".repeat(level) + "☆".repeat(6 - level);
}

/**
 * The demo projects we expose. Order matches the order the dropdown
 * shows. `reader.c` is intentionally the first file revealed — that's
 * where the inline `// ← try changing this` comment lives, per the
 * editor reviewer's "discoverable, not in your face" recommendation.
 *
 * Hello Mac (added later) is a deliberately simpler third sample —
 * one window, one string, no parsing, no I/O — so visitors can verify
 * the playground's full edit-and-rebuild flow on something with
 * almost no surface area, and so the friendliest first read of "what
 * does a System 7 app look like?" is one click away.
 */
export const SAMPLE_PROJECTS: readonly SampleProject[] = [
  // Three legacy splice-path projects (reader, macweather, hello-mac)
  // were removed from this list 2026-05-15 (#117). They used CI-built
  // .code.bin data forks that the playground couldn't actually rebuild
  // in-browser — only the .r resource fork was editable, which
  // surprised users who edited the .c expecting their changes to show
  // up. Their source files still live under src/app/<name>/ and the
  // CI-built binaries still ship on the boot disk (so the Mac
  // auto-launches them on startup as showcase apps). The Path-C splice
  // dispatch + precompiledName field were retired in a follow-up to
  // #125; every project in this list now compiles end-to-end in the
  // browser, distinguished only by whether it has an `.r` resource
  // file (Path B) or not (Path A).
  {
    // wasm-hello — first project that compiles end-to-end in the
    // browser (cv-mac #64 / wasm-retro-cc #15). Single hello.c,
    // no .r resources, no CI artefact. The Build & Run path runs
    // cc1 → as → ld → Elf2Mac client-side and hot-loads the result.
    id: "wasm-hello",
    label: "Wasm Hello",
    files: ["hello.c"],
    rezFile: null,
    outputName: "WasmHello.bin",
    appType: "APPL",
    // Type/Creator come from Elf2Mac's defaults today (APPL / ????).
    // Tracked separately if we want a project-specific creator code;
    // for now ???? is fine because the Finder Desktop DB only
    // disambiguates apps by creator at icon-binding time, and we
    // don't ship a custom icon for this demo.
    appCreator: "????",
    complexity: 1,
  },
  {
    // wasm-hello-multi — multi-file C demo (cv-mac #100 Phase A).
    // Same shape as wasm-hello but split across main.c + greet.c +
    // greet.h to exercise the compileToBin pipeline's multi-source
    // path. Both .c files compile through cc1+as separately; ld
    // links the two .o's together with libretrocrt/libInterface/etc.
    id: "wasm-hello-multi",
    label: "Wasm Hello (multi-file)",
    files: ["main.c", "greet.c", "greet.h"],
    rezFile: null,
    outputName: "WasmHelloMulti.bin",
    appType: "APPL",
    appCreator: "????",
    complexity: 4,
  },
  {
    // wasm-hello-window — mixed C + .r demo (cv-mac #100 Phase B).
    // The .c compiles through compileToBin (wasm-cc1 chain); the .r
    // compiles through WASM-Rez; spliceResourceFork merges the two
    // forks (user-wins on collision). Produces an app with a real
    // window resource loaded via GetNewWindow.
    id: "wasm-hello-window",
    label: "Wasm Hello (windowed)",
    files: ["hello.c", "hello.r"],
    rezFile: "hello.r",
    outputName: "WasmHelloWindow.bin",
    appType: "APPL",
    appCreator: "CVWW",
    complexity: 1,
  },
  {
    // wasm-snake — a playable Snake clone (cv-mac #100 Phase D demo).
    // First non-trivial in-browser-built app: arrow-key input, event
    // loop, TickCount-driven movement, QuickDraw rendering, win/lose
    // state, restart. Demonstrates that the playground can host real
    // games beyond Hello World.
    id: "wasm-snake",
    label: "Wasm Snake (game)",
    files: ["snake.c", "snake.r"],
    rezFile: "snake.r",
    outputName: "WasmSnake.bin",
    appType: "APPL",
    appCreator: "CVSN",
    complexity: 3,
  },
  {
    // wasm-textedit — TextEdit demo, foundation for a future word
    // processor (cv-mac #125). Uses Toolbox TEHandle for the actual
    // text editing — TEKey for keyboard, TEClick for mouse selection,
    // TEUpdate on update events, TEIdle for caret blinking, all the
    // built-in Mac OS 7/8 plumbing. Same Path B shape as Snake +
    // Hello-Window: in-browser C + WASM-Rez splice.
    id: "wasm-textedit",
    label: "Wasm TextEdit",
    files: ["textedit.c", "textedit.r"],
    rezFile: "textedit.r",
    outputName: "WasmTextEdit.bin",
    appType: "APPL",
    appCreator: "CVTE",
    complexity: 3,
  },
  {
    // wasm-notepad — Wasm TextEdit + a real menu bar (cv-mac #125).
    // Adds MBAR 128 with Apple / File / Edit, ALRT 128 for About, and
    // wires Cut/Copy/Paste through TECut/TECopy/TEPaste. Demonstrates
    // MenuSelect / MenuKey dispatch + the Apple-glyph rainbow menu.
    // One step further toward a mini word processor.
    id: "wasm-notepad",
    label: "Wasm Notepad",
    files: ["notepad.c", "notepad.r"],
    rezFile: "notepad.r",
    outputName: "WasmNotepad.bin",
    appType: "APPL",
    appCreator: "CVNP",
    complexity: 3,
  },
  {
    // wasm-stickynote — small floating sticky-note window (cv-mac #125).
    // Smaller than wasm-notepad: no menubar, no scrap, just a 220×140
    // draggable window with a yellow paper background and a single
    // TextEdit field. Exercises RGBBackColor / RGBForeColor — neither
    // of the other TextEdit samples touches QuickDraw colour.
    id: "wasm-stickynote",
    label: "Wasm Sticky Note",
    files: ["stickynote.c", "stickynote.r"],
    rezFile: "stickynote.r",
    outputName: "WasmStickyNote.bin",
    appType: "APPL",
    appCreator: "CVSN",
    complexity: 2,
  },
  {
    // wasm-wordpad — Mini word processor (cv-mac #125). Takes notepad
    // up a rung with Font / Size / Style menus driving monostyle
    // TextEdit (TENew, not TEStyleNew — per-run styling is a much
    // bigger lift; monostyle covers the user-visible affordance and
    // keeps the diff against Notepad comprehensible).
    id: "wasm-wordpad",
    label: "Wasm WordPad",
    files: ["wordpad.c", "wordpad.r"],
    rezFile: "wordpad.r",
    outputName: "WasmWordPad.bin",
    appType: "APPL",
    appCreator: "CVWP",
    complexity: 3,
  },
  {
    // wasm-clock — analog desk clock with digital readout (cv-mac #125).
    // Different Toolbox slice from the rest of the shelf: GetDateTime +
    // SecondsToDate, idle-tick redraw loop (1-second WaitNextEvent
    // timeout, no busy-wait), all QuickDraw drawing (FrameOval / MoveTo
    // / LineTo / FillOval). Includes a hand-rolled 60-entry sin/cos
    // table to avoid libm — keeps the .bin tiny.
    id: "wasm-clock",
    label: "Wasm Clock",
    files: ["clock.c", "clock.r"],
    rezFile: "clock.r",
    outputName: "WasmClock.bin",
    appType: "APPL",
    appCreator: "CVCK",
    complexity: 2,
  },
  {
    // wasm-multiwin — three windows, one event loop. Every other sample
    // on the shelf opens a single window; this one demonstrates the
    // front-window dispatch model (SelectWindow on a back-window
    // click, refCon-stashed per-window state, GetIndPattern fill,
    // last-close exits).
    id: "wasm-multiwin",
    label: "Wasm Multi-Window",
    files: ["multiwin.c", "multiwin.r"],
    rezFile: "multiwin.r",
    outputName: "WasmMultiWin.bin",
    appType: "APPL",
    appCreator: "CVMW",
    complexity: 4,
  },
  {
    // wasm-cursor — region-driven Cursor Manager demo. Four labelled
    // quadrants; moving the mouse between them swaps the cursor via
    // GetCursor + SetCursor. Classic Mac "poll mouse on idle, change
    // cursor by region" pattern — the OS has no enter/leave events.
    id: "wasm-cursor",
    label: "Wasm Cursor",
    files: ["cursor.c", "cursor.r"],
    rezFile: "cursor.r",
    outputName: "WasmCursor.bin",
    appType: "APPL",
    appCreator: "CVCR",
    complexity: 2,
  },
  {
    // wasm-files — File I/O via StandardGetFile / StandardPutFile.
    // The most visible coverage gap on the shelf, finally filled:
    // FSpCreate / FSpOpenDF / FSRead / FSWrite / SetEOF round-trip
    // TEXT files through a system Open/Save dialog.
    id: "wasm-files",
    label: "Wasm Files (read/write)",
    files: ["files.c", "files.r"],
    rezFile: "files.r",
    outputName: "WasmFiles.bin",
    appType: "APPL",
    appCreator: "CVFL",
    complexity: 3,
  },
  {
    // wasm-gworld — modern System 7+ offscreen double-buffer via
    // NewGWorld + GetGWorldPixMap + LockPixels + CopyBits. The clean
    // upgrade path from wasm-bounce's hand-rolled NewPtr-backed BitMap.
    // Four shapes (square, circle, diamond, triangle) bounce around a
    // 320×200 scene, redrawn into the GWorld and blitted to the window
    // each frame — flicker-free animation the modern way.
    id: "wasm-gworld",
    label: "Wasm GWorld",
    files: ["gworld.c", "gworld.r"],
    rezFile: "gworld.r",
    outputName: "WasmGWorld.bin",
    appType: "APPL",
    appCreator: "CVGW",
    complexity: 3,
  },
  {
    // wasm-calculator — 4-function calculator (cv-mac #125). Distinct
    // ladder rung from the TextEdit samples: demonstrates hand-drawn
    // QuickDraw buttons, PtInRect hit-testing, NumToString display
    // formatting, and Invert flash press-feedback. Shows the playground
    // can build classic Mac apps without TextEdit/scrap entanglement.
    id: "wasm-calculator",
    label: "Wasm Calculator",
    files: ["calc.c", "calc.r"],
    rezFile: "calc.r",
    outputName: "WasmCalculator.bin",
    appType: "APPL",
    appCreator: "CVCA",
    complexity: 3,
  },
  {
    // wasm-scribble — mouse-tracking draw demo (cv-mac #125). Yet
    // another Toolbox surface: StillDown / GetMouse polling with
    // MoveTo+LineTo per pixel — the classic Mac drag-to-draw loop
    // from Inside Mac: Macintosh Toolbox Essentials ch. 1.
    id: "wasm-scribble",
    label: "Wasm Scribble",
    files: ["scribble.c", "scribble.r"],
    rezFile: "scribble.r",
    outputName: "WasmScribble.bin",
    appType: "APPL",
    appCreator: "CVSC",
    complexity: 2,
  },
  {
    // wasm-scrollwin — scrolling list demo (cv-mac #125). Fills the
    // Controls coverage gap flagged in the third review pass. New
    // Toolbox surface: NewControl(scrollBarProc), TrackControl with
    // a live actionProc, GetControlValue / SetControlValue,
    // SetControlMinimum / Maximum.
    id: "wasm-scrollwin",
    label: "Wasm ScrollWin",
    files: ["scrollwin.c", "scrollwin.r"],
    rezFile: "scrollwin.r",
    outputName: "WasmScrollWin.bin",
    appType: "APPL",
    appCreator: "CVSW",
    complexity: 3,
  },
  {
    // wasm-patterns — QuickDraw pattern gallery (cv-mac #125). Fills
    // the Bitmaps / Pattern coverage gap. Renders a 4×3 grid of
    // labelled swatches, each filled with a distinct 8x8 dither
    // pattern (system white/ltGray/gray/dkGray + eight hand-rolled).
    id: "wasm-patterns",
    label: "Wasm Patterns",
    files: ["patterns.c", "patterns.r"],
    rezFile: "patterns.r",
    outputName: "WasmPatterns.bin",
    appType: "APPL",
    appCreator: "CVPT",
    complexity: 2,
  },
  {
    // wasm-bounce — offscreen BitMap + CopyBits, no-flicker animation
    // (cv-mac #125). Fills the "Offscreen GWorld + CopyBits" gap. The
    // canonical double-buffer pattern any animated Mac app from 1989
    // onwards relied on. Uses the older NewPtr+BitMap approach (no
    // NewGWorld) for maximum 68k compatibility.
    id: "wasm-bounce",
    label: "Wasm Bounce",
    files: ["bounce.c", "bounce.r"],
    rezFile: "bounce.r",
    outputName: "WasmBounce.bin",
    appType: "APPL",
    appCreator: "CVBO",
    complexity: 3,
  },
  {
    // wasm-debug-console — exercises the IDE Output panel's Console
    // tab via the cvm_log() API. Click the window to log a line; the
    // Console tab surfaces it within ~1s. Pairs with the static
    // header library cvm_log.h that any user project can pull in.
    id: "wasm-debug-console",
    label: "Debug Console demo",
    // cvm_log.h isn't bundled — it's mounted as a system header by
    // cc1.ts (#include <cvm_log.h>) so any project can use it without
    // a per-project copy.
    files: ["console.c", "console.r"],
    rezFile: "console.r",
    outputName: "DebugConsole.bin",
    appType: "APPL",
    appCreator: "CVDC",
    complexity: 3,
  },
  {
    // wasm-dialog — ModalDialog with an editable text field (cv-mac
    // #125). Fills the "Modal dialogs with editable fields" gap. Click
    // the button → modal with prompt + edit-text + OK/Cancel; OK reads
    // the typed answer and draws "Hello, <name>!" back into the window.
    id: "wasm-dialog",
    label: "Wasm Dialog",
    files: ["dialog.c", "dialog.r"],
    rezFile: "dialog.r",
    outputName: "WasmDialog.bin",
    appType: "APPL",
    appCreator: "CVDL",
    complexity: 3,
  },
  {
    // wasm-sound — Sound Manager SysBeep demo (cv-mac #125). Fills
    // the Sound Manager gap with the simplest possible affordance —
    // SysBeep with click-counter-modulated durations. Richer SndPlay
    // on an 'snd ' resource is a future ladder rung; SysBeep itself
    // is the oldest entry-point in the Sound Manager (a single
    // A-trap, always available without library glue).
    id: "wasm-sound",
    label: "Wasm Sound",
    files: ["sound.c", "sound.r"],
    rezFile: "sound.r",
    outputName: "WasmSound.bin",
    appType: "APPL",
    appCreator: "CVSO",
    complexity: 2,
  },
  {
    // wasm-color — Color QuickDraw RGBForeColor demo (cv-mac #125).
    // Draws the canonical 1990 Macintosh II 6-colour palette as a
    // horizontal stripe gallery. RGBColor + RGBForeColor + PaintRect.
    // On a 1-bit display the colours quantise to black/white per the
    // documented Color QuickDraw degradation path.
    id: "wasm-color",
    label: "Wasm Color",
    files: ["color.c", "color.r"],
    rezFile: "color.r",
    outputName: "WasmColor.bin",
    appType: "APPL",
    appCreator: "CVCR",
    complexity: 2,
  },
  {
    // wasm-arkanoid — first ★★★★★ demo (cv-mac #233 Option A).
    // A small brick-breaker compiled in your browser. Demonstrates
    // the top tier of the complexity scale:
    //   - multi-file C: main.c (Toolbox glue) + engine.c (pure game
    //     logic, no Toolbox calls) + render.c (QuickDraw) + a shared
    //     engine.h. Each file fits in one screen.
    //   - binary asset: arkanoid.r ships an ICN# 128 resource
    //     authored as a literal hex bitmap for the about-box icon.
    //     Loaded via the Resource Manager + rendered with PlotIconID
    //     from the standard ALRT mechanism.
    //   - real-game scope: paddle + ball physics + 5×10 brick grid +
    //     collision resolution + scoring + lives + win/lose + pause.
    // Path B build (cc1 → as → ld → Elf2Mac for the .c files;
    // WASM-Rez for the .r; spliceResourceFork merges the forks).
    id: "wasm-arkanoid",
    label: "Wasm Arkanoid",
    files: ["main.c", "engine.c", "engine.h", "render.c", "arkanoid.r"],
    rezFile: "arkanoid.r",
    outputName: "WasmArkanoid.bin",
    appType: "APPL",
    appCreator: "CVAR",
    complexity: 5,
  },
  {
    // wasm-icon-gallery — first ★★★★★★ demo (cv-mac #233, the
    // "next level" rung above wasm-arkanoid). Demonstrates the
    // splice infrastructure landed in #251 (ExtraFile.resourceFork)
    // with a real external binary resource file:
    //   - Multi-file C: main + gallery (resource loading) + render
    //     + shared header
    //   - In-source resources: WIND, MBAR, two MENUs, ALRT + DITL
    //     (no in-source ICN# — that's the whole point)
    //   - External asset: icons.rsrc.bin shipped on the same disk,
    //     containing six 32×32 ICN# resources at IDs 128-133
    //     (heart, star, diamond, circle, triangle, square),
    //     generated offline by scripts/build-icon-gallery-rsrc.mjs
    //   - Runtime: OpenResFile("Icons") + GetResource('ICN#', N)
    //     + PlotIcon to draw the 3×2 grid
    // The .rsrc.bin file is a host-side binary the editor can't
    // meaningfully display as text — IDE-side handling for that
    // class of file is a later PR; for now it's listed under
    // binaryAssets and the editor's file picker skips it.
    id: "wasm-icon-gallery",
    label: "Wasm Icon Gallery",
    files: ["main.c", "gallery.c", "gallery.h", "render.c", "gallery.r"],
    rezFile: "gallery.r",
    outputName: "WasmIconGallery.bin",
    appType: "APPL",
    appCreator: "CVIG",
    complexity: 6,
    binaryAssets: ["icons.rsrc.bin"],
  },
  {
    // wasm-glypha3 — first real third-party period app onboard
    // (cv-mac #233 Phase 2). John Calhoun's 1992 side-scroller,
    // released under MIT by Soft Dorothy in 2018. Vendored from
    // softdorothy/Glypha3 with a small Universal-Headers
    // compatibility shim in Externs.h. 9 .c files + shared header
    // = ~6600 LOC of *real period code* — the milestone is
    // proving the in-browser pipeline survives a 10× scale-up
    // from the wasm-* hand-rolled toys.
    //
    // What works in this PR: the full compile + link path. cc1.wasm
    // doesn't OOM on the largest file (Enemy.c, 45 KB). The link
    // produces a 149 KB ELF.
    //
    // What's stubbed for now: persistence (Prefs.c is a no-op),
    // and the upstream 2.7 MB resource fork is replaced with a
    // minimal Rez file (WIND + MBAR + signature). The game will
    // boot far enough to show a window but won't be playable —
    // wiring up the real resources is a follow-up project per
    // the PR body's note.
    //
    // Marked complexity 7 (off the previous scale) — bigger
    // codebase + first external onboard + stubbed-but-real assets.
    // The dropdown shows ★★★★★★ for it since the helper caps
    // at 6 stars; user can extend the scale later if useful.
    id: "wasm-glypha3",
    label: "Glypha III (John Calhoun, MIT)",
    files: [
      "Main.c", "Enemy.c", "Graphics.c", "Interface.c",
      "Play.c", "Prefs.c", "SetUpTakeDown.c", "Sound.c", "Utilities.c",
      "Externs.h", "glypha3.r",
    ],
    rezFile: "glypha3.r",
    outputName: "GlyphaIII.bin",
    appType: "APPL",
    appCreator: "CVGl",
    complexity: 6,
  },
];

/** Build-time constant: hash of every bundled sample file's contents. */
declare const __CVM_BUNDLE_VERSION__: string;
export const BUNDLE_VERSION: string =
  // The Vite plugin (vite.config.ts) replaces this token at build time.
  // Fall back to a stable string in case the define ever doesn't fire so
  // we don't crash; the IDB invalidation just won't trigger.
  typeof __CVM_BUNDLE_VERSION__ === "string" ? __CVM_BUNDLE_VERSION__ : "dev";

/** Build-time constant: ISO timestamp of when Vite built this bundle. */
declare const __CVM_BUILT_AT__: string;
export const BUILT_AT: string =
  typeof __CVM_BUILT_AT__ === "string" ? __CVM_BUILT_AT__ : "dev";

/** Build-time constant: hash of every wasm-cc1 toolchain artifact
 * (cc1.wasm, as.wasm, ld.wasm, Elf2Mac.wasm, sysroot[-libs].bin). Changes
 * when the toolchain itself is updated, even if no sample source changed.
 * Use this to confirm "is my browser actually running the new toolchain?" */
declare const __CVM_TOOLCHAIN_VERSION__: string;
export const TOOLCHAIN_VERSION: string =
  typeof __CVM_TOOLCHAIN_VERSION__ === "string"
    ? __CVM_TOOLCHAIN_VERSION__
    : "dev";

/** IDB key for a per-project, per-file content blob. */
export function fileKey(projectId: string, filename: string): string {
  return `${projectId}/${filename}`;
}
