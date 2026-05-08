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
 * The two demo projects we expose in Phase 1. Order matches the order the
 * dropdown shows. `reader.c` is intentionally the first file revealed —
 * that's where the inline `// ← try changing this` comment lives, per the
 * editor reviewer's "discoverable, not in your face" recommendation.
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
