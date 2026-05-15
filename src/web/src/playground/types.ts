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
    // Built by Retro68 GCC via the pinned Docker image. The Phase 2.0
    // derisk artefact — first proof that the project's downstream
    // pipeline handles a Retro68-built binary end-to-end (HFS patcher
    // → BasiliskII hot-load → DrawString visible on screen).
    // Provenance: see VENDORED.md.
    id: "hello-toolbox-retro68",
    label: "Hello, World!",
    binPath: "precompiled/hello-toolbox-retro68.bin",
    filename: "hello_toolbox",
    description:
      "Classic 'Hello, World!' — InitGraf, DrawString on the desktop, " +
      "click to exit. Compiled by Retro68 GCC.",
  },
  {
    // QuickDraw demo (added 2026-05-15). Fan of 8 lines radiating from
    // a central point + bounding box. Demonstrates MoveTo/LineTo
    // without any window machinery — draws directly to the screen
    // port InitGraf sets up. Source: wasm-retro-cc/spike/demos/lines.c.
    id: "lines",
    label: "QuickDraw Lines",
    binPath: "precompiled/lines.bin",
    filename: "lines",
    description:
      "Fan of 8 lines + bounding box drawn via QuickDraw MoveTo/LineTo. " +
      "Click to exit.",
  },
  {
    // Interactive click counter (added 2026-05-15). Increments a
    // counter on each click, redraws via NumToString + EraseRect.
    // Demonstrates a real event loop. Source: spike/demos/counter.c.
    id: "counter",
    label: "Click Counter",
    binPath: "precompiled/counter.bin",
    filename: "counter",
    description:
      "Click the desktop to increment the counter. After 10 clicks, " +
      "one more click exits. Uses NumToString + EraseRect for redraw.",
  },
  {
    // Real-time clock (added 2026-05-15). Polls GetDateTime +
    // IUTimeString every ~30 ticks via TickCount, redraws HH:MM:SS.
    // Source: spike/demos/clock.c.
    id: "clock",
    label: "Mac Clock",
    binPath: "precompiled/clock.bin",
    filename: "clock",
    description:
      "Live HH:MM:SS clock via GetDateTime + IUTimeString. Updates " +
      "twice a second. Click to exit.",
  },
  {
    // Phase 1 PCC archive (kept as a visible "what we tried" record).
    // The bisect probes (hello-bare, hello-initgraf*) lived alongside
    // this and are now retired — they were diagnostics for the Phase 1
    // debugging session, not real demos. Their .bin files remain in
    // precompiled/ as historical record; just not surfaced in the UI.
    id: "hello-toolbox-pcc-archived",
    label: "Hello Toolbox (PCC — archived)",
    binPath: "precompiled/hello-toolbox.bin",
    filename: "hello_toolbox_pcc",
    description:
      "Phase 1 PCC build — crashes on any Toolbox call. Shipped as a " +
      "historical comparison; the working Retro68 version is at the top.",
  },
];
// Note: Phase 1 PCC bisect probes (hello-bare, hello-initgraf,
// hello-initgraf-local, hello-initgraf-zone) lived in this array
// alongside the demos until 2026-05-15. They were diagnostics for the
// debugging session recorded in wasm-retro-cc's LEARNINGS.md, not
// user-facing demos — and all four crash at runtime. Their .bin files
// remain in precompiled/ as a historical record (see VENDORED.md).

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
