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
  /** Phase 2: the .r file the playground compiles. Must be present in `files`. */
  rezFile: string;
  /** Phase 2: name under public/precompiled/ (without leading slash). */
  precompiledName: string;
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
  {
    id: "reader",
    label: "Reader",
    files: ["reader.c", "reader.r", "html_parse.c", "html_parse.h"],
    rezFile: "reader.r",
    precompiledName: "reader.code.bin",
    outputName: "Reader.bin",
    appType: "APPL",
    appCreator: "CVMR",
  },
  {
    id: "macweather",
    label: "MacWeather",
    files: [
      "macweather.c",
      "macweather.r",
      "weather_parse.c",
      "weather_parse.h",
      "weather_glyphs.c",
    ],
    rezFile: "macweather.r",
    precompiledName: "macweather.code.bin",
    outputName: "MacWeather.bin",
    appType: "APPL",
    appCreator: "CVMW",
  },
  {
    id: "hello-mac",
    label: "Hello Mac",
    files: ["hello.c", "hello.r"],
    rezFile: "hello.r",
    precompiledName: "hello-mac.code.bin",
    outputName: "HelloMac.bin",
    appType: "APPL",
    appCreator: "CVHM",
  },
];

/**
 * A ready-to-run Mac application binary from an external compiler pipeline
 * (e.g. wasm-retro-cc). Unlike SampleProject, there are no editable source
 * files and no wasm-rez build step — the binary is fetched directly, patched
 * into an empty HFS volume, and handed to the emulator.
 */
export interface PrebuiltDemo {
  /** Stable identifier. Used for tracking/analytics only. */
  id: string;
  /** Human label shown on the Load button. */
  label: string;
  /** URL path relative to the site base URL (no leading slash).
   *  E.g. "precompiled/hello-toolbox.bin". */
  binPath: string;
  /** HFS filename (no extension) — this is what the Finder shows. 31-char max. */
  filename: string;
  /** Short description shown as button tooltip. */
  description: string;
}

/**
 * Prebuilt demos available in the playground. Each is a complete MacBinary II
 * APPL that loads directly without a wasm-rez splice step.
 *
 * Source provenance: see src/web/public/precompiled/VENDORED.md.
 */
export const PREBUILT_DEMOS: readonly PrebuiltDemo[] = [
  {
    // Phase 2.0 derisk artefact (added 2026-05-14).  Same C source as
    // hello-toolbox below, but compiled with Retro68 GCC + linked against
    // Retro68's own crt + libInterface (via the pinned Docker image).
    // Confirms that the project's downstream pipeline (HFS patcher,
    // BasiliskII boot, MacBinary loader) handles a Retro68-built binary
    // correctly — derisks Phase 2 ahead of any Emscripten porting work.
    // Provenance: see VENDORED.md.
    id: "hello-toolbox-retro68",
    label: "Hello Toolbox (Retro68 GCC)",
    binPath: "precompiled/hello-toolbox-retro68.bin",
    filename: "hello_toolbox_r68",
    description:
      "Compiled by Retro68 GCC via the pinned Docker image.  Same source " +
      "and behaviour as the PCC build below — draws \\\"Hello, World!\\\" " +
      "on the desktop and waits for a click.  Phase 2.0 derisk.",
  },
  {
    id: "hello-toolbox",
    label: "Hello Toolbox (wasm-retro-cc, PCC — archived)",
    binPath: "precompiled/hello-toolbox.bin",
    filename: "hello_toolbox",
    description:
      "Phase 1 PCC build (archived 2026-05-14).  Compiled by PCC + " +
      "hand-written A-trap stubs — no Retro68 toolchain.  Crashes on any " +
      "Toolbox call; kept as a historical record of the Phase 2 pivot.",
  },
  {
    // Bisect probe (added 2026-05-14): same compiler + link + CRT as
    // hello-toolbox, but ZERO Toolbox calls — just integer arithmetic and
    // return.  If this launches cleanly while hello-toolbox crashes, the
    // bug is in our Toolbox stubs or shim headers, not in libretrocrt.
    // If this also crashes, libretrocrt's startup itself is suspect.
    id: "hello-bare",
    label: "Hello Bare (no Toolbox) — bisect probe",
    binPath: "precompiled/hello-bare.bin",
    filename: "hello_bare",
    description:
      "wasm-retro-cc Phase-1 binary: pure integer math, no Toolbox calls. " +
      "Same compiler + libretrocrt startup as hello_toolbox.  Diagnostic " +
      "use only — launches and exits immediately (no visible output).",
  },
  {
    // Bisect probe (added 2026-05-14, second tier): finer granularity than
    // hello-bare.  Calls JUST InitGraf and returns.  Distinguishes whether
    // InitGraf itself is the crash source (vs. some later Toolbox call).
    //   - Launches cleanly like hello-bare → InitGraf works; bug is later.
    //   - Bombs like hello-toolbox        → InitGraf is the culprit.
    id: "hello-initgraf",
    label: "Hello InitGraf only — bisect probe",
    binPath: "precompiled/hello-initgraf.bin",
    filename: "hello_initgraf",
    description:
      "wasm-retro-cc bisect: calls InitGraf only, then returns.  Same " +
      "compile + link + libtoolbox-stubs path as hello_toolbox.  No " +
      "visible output if it works (silent exit, like hello-bare).",
  },
  {
    // H1 probe (added 2026-05-14): same as hello-initgraf but uses a
    // STACK-allocated GrafPtr, not &qd.thePort.  Eliminates the qd RELA
    // fixup from the call site.  PCC emits `move.l A6,A0; sub.l #4,A0;
    // move.l A0,-(SP); jsr InitGraf` — no relocation against bss.
    //   - Silent exit (like hello-bare) → H1 confirmed: the qd-pointer
    //     resolution is the bug.  Investigate Retro68Relocate's
    //     displacements[bss] semantics.
    //   - Crash (like hello-initgraf)   → H1 dead.  Move on to H2
    //     (MaxApplZone) or H3 (stub mechanics).
    id: "hello-initgraf-local",
    label: "Hello InitGraf (local var) — H1 probe",
    binPath: "precompiled/hello-initgraf-local.bin",
    filename: "hello_initgraf_loc",
    description:
      "H1 probe: InitGraf with a stack-allocated GrafPtr instead of " +
      "&qd.thePort.  No qd-relocation in the call site.  Silent exit " +
      "if the qd-pointer was the bug; same crash if not.",
  },
  {
    // H2 probe (added 2026-05-14): calls MaxApplZone + MoreMasters×3
    // BEFORE InitGraf.  Standard Mac startup incantation: expands the
    // application heap and pre-allocates master pointers before any
    // Toolbox allocation.  H1 was ruled out — H1 probe crashes too —
    // so the leading hypothesis is now heap pre-state.  Also relevant
    // to the SimpleText crash seen alongside ours: SimpleText also
    // does NewPtr; a globally-bad heap state would kill it too.
    //   - Silent exit → H2 confirmed: bug is heap init.
    //   - Crash       → H2 dead.  Move to H4: libretrocrt corrupts
    //                   system state (A5 world / heap zone / SegLoad).
    id: "hello-initgraf-zone",
    label: "Hello InitGraf (MaxApplZone) — H2 probe",
    binPath: "precompiled/hello-initgraf-zone.bin",
    filename: "hello_initgraf_z",
    description:
      "H2 probe: MaxApplZone + MoreMasters×3 + InitGraf.  Standard pre-" +
      "InitGraf incantation.  Silent exit if heap init was the bug.",
  },
];

/** Build-time constant: hash of every bundled sample file's contents. */
declare const __CVM_BUNDLE_VERSION__: string;
export const BUNDLE_VERSION: string =
  // The Vite plugin (vite.config.ts) replaces this token at build time.
  // Fall back to a stable string in case the define ever doesn't fire so
  // we don't crash; the IDB invalidation just won't trigger.
  typeof __CVM_BUNDLE_VERSION__ === "string" ? __CVM_BUNDLE_VERSION__ : "dev";

/** IDB key for a per-project, per-file content blob. */
export function fileKey(projectId: string, filename: string): string {
  return `${projectId}/${filename}`;
}
