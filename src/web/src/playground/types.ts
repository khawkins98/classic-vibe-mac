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
