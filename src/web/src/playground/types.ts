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
 * `rezFile` names the `.r` file that's the resource-fork compile entry
 * point for this project (Phase 2). `precompiledName` is the static
 * asset under public/precompiled/ that holds the data-fork-only
 * MacBinary we splice the freshly-compiled rsrc fork onto. `outputName`
 * is the filename for the user's download. `appType`/`appCreator` are
 * Type/Creator codes — not used at compile time (the precompile already
 * has them) but documented here for traceability.
 */
export interface SampleProject {
  /** Stable id used as the IDB key prefix and in the URL/dropdown. */
  id: string;
  /** Human label shown in the project dropdown. */
  label: string;
  /** Filenames to expose in the file dropdown, ORDERED by intended reveal. */
  files: string[];
  /**
   * Phase 2: the `.r` file the playground compiles via wasm-rez, and
   * whose output splices on top of the precompiled `.code.bin`.
   *
   * When `null`, this project has *no* resource fork to compile —
   * Build & Run uses the in-browser C toolchain (cc1 → as → ld →
   * Elf2Mac via `compileToBin()`) to produce a complete MacBinary
   * directly from the project's `.c` source. See cv-mac #64,
   * wasm-retro-cc #15.
   */
  rezFile: string | null;
  /**
   * Phase 2: name under `public/precompiled/` (without leading slash)
   * for the CI-built data-fork-bearing `.code.bin`.
   *
   * When `null`, this project doesn't have a CI-built code blob —
   * the in-browser toolchain emits the complete `.bin` and we hot-load
   * it directly. Mutually exclusive with the splice path: a project
   * with `rezFile: null` must also have `precompiledName: null`.
   */
  precompiledName: string | null;
  /** Phase 2: filename used for the Build button's download. */
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
  // were removed from this list 2026-05-15 as part of cv-mac #100. They
  // used CI-precompiled .code.bin data forks that the playground
  // couldn't actually rebuild in-browser — only the .r resource fork
  // was editable, which surprised users who edited the .c expecting
  // their changes to show up. Their source files still live under
  // src/app/<name>/ and the CI-built binaries still ship on the boot
  // disk (so the Mac auto-launches them on startup as showcase apps),
  // but the playground picker only offers projects that build
  // end-to-end in the browser. The runBuild dispatch's path C (rezFile
  // + precompiledName) remains in editor.ts as dead-but-functional
  // code in case a future use case wants this shape back.
  {
    // wasm-hello — first project that compiles end-to-end in the
    // browser (cv-mac #64 / wasm-retro-cc #15). Single hello.c,
    // no .r resources, no CI artefact. The Build & Run path runs
    // cc1 → as → ld → Elf2Mac client-side and hot-loads the result.
    id: "wasm-hello",
    label: "Wasm Hello",
    files: ["hello.c"],
    rezFile: null,
    precompiledName: null,
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
    precompiledName: null,
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
    precompiledName: null,
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
    precompiledName: null,
    outputName: "WasmSnake.bin",
    appType: "APPL",
    appCreator: "CVSN",
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
