/**
 * toolchain.ts — backend-abstraction layer for the in-browser compiler.
 *
 * Closes #100 Phase C: define the shape an alternative classic-Mac
 * (or other-platform) toolchain implementation would need to fill,
 * and route the existing Retro68 68k path through it. Without this,
 * the playground is coupled to one set of wasm tools by name; with
 * it, adding a second backend (PowerPC per #98, or PCC, or an
 * Apple-IIgs ORCA/C build, or anything else) is "implement the
 * interface and register it" — the IDE keeps using the same call.
 *
 * Today there's exactly one Toolchain (`retro68-68k`) and the
 * `getToolchain` registry returns it for every lookup. Future
 * backends register additional entries; consumers select via the
 * project's preferred id (or the playground's default).
 *
 * Why a thin wrapper around compileToBin instead of a deeper
 * refactor: every existing caller already works against
 * compileToBin's shape, and that shape (sources in → MacBinary out
 * + diagnostics + per-stage timings) is the right level of
 * abstraction for any backend that targets the same classic-Mac
 * APPL format. A deeper redesign (separate compile / link /
 * package phases per the issue's sketch) would be required only
 * once a second backend wants to substitute, say, its own linker
 * but not its own compiler — which we don't have a use case for
 * yet. YAGNI keeps the interface narrow.
 */

import { compileToBin, type CompileToBinOptions, type CompileToBinResult } from "./cc1";

/**
 * The capabilities a Toolchain advertises. The IDE can read these
 * to gate UI affordances — e.g. greying out "Optimisation level"
 * for backends that don't expose one.
 */
export interface ToolchainCapabilities {
  /** Whether the toolchain accepts multiple .c source files in one
   *  invocation. retro68-68k: yes. */
  multifile: boolean;
  /** Whether the toolchain can splice a Rez-compiled resource fork
   *  into its output. retro68-68k: yes (via the existing wasm-rez
   *  + spliceResourceFork pipeline; the playground's runBuildMixedCAndR
   *  composes the two). */
  mixedResources: boolean;
  /** Whether the toolchain has a C++ frontend wired. retro68-68k:
   *  no (--enable-languages=c per Phase 2 non-goals). */
  cxx: boolean;
  /** Whether the toolchain accepts an -O flag (and which levels).
   *  retro68-68k: O0 / Os / O2. */
  optLevels: readonly ("O0" | "Os" | "O2")[];
}

/**
 * The abstraction. A backend implementation provides an id, a list
 * of target specifiers it can produce (`mac-classic-68k-appl`,
 * future `mac-ppc-cfm-appl`, `appleiigs-omf-s16`, ...), advertised
 * capabilities, and the actual compile entry-point.
 */
export interface Toolchain {
  /** Stable identifier for selection. Lowercase, hyphen-separated. */
  readonly id: string;
  /** Human label for UI surfaces (preferences, project metadata). */
  readonly label: string;
  /** Target binary formats this backend can produce. */
  readonly targets: readonly string[];
  /** Capabilities the IDE can query before showing options. */
  readonly capabilities: ToolchainCapabilities;
  /**
   * Compile one or more source files to a packaged binary in one
   * call. Shape matches the existing `compileToBin` so the migration
   * is non-invasive. Future backends with a richer separated
   * compile / link / package surface can expose those as private
   * methods; this is the public contract.
   */
  compile(opts: CompileToBinOptions): Promise<CompileToBinResult>;
}

/**
 * The current 68k Retro68 backend. Wraps the existing cc1.ts
 * compileToBin (which already drives cc1 → as → ld → Elf2Mac in
 * the browser). baseUrl is needed for fetching the wasm bundles +
 * sysroot blobs; the editor passes its `import.meta.env.BASE_URL`.
 */
export function retro68_68k(baseUrl: string): Toolchain {
  return {
    id: "retro68-68k",
    label: "Retro68 (Motorola 68000 — classic Mac OS, System 7+)",
    targets: ["mac-classic-68k-appl"],
    capabilities: {
      multifile: true,
      mixedResources: true,
      cxx: false,
      optLevels: ["O0", "Os", "O2"],
    },
    compile: (opts) => compileToBin(baseUrl, opts),
  };
}

/**
 * Registry. Returns the requested backend or the default
 * (retro68-68k today) if the id is unknown. Future PowerPC support
 * (per cv-mac #98) registers a second entry here; everything else
 * stays the same.
 */
const registry = new Map<string, (baseUrl: string) => Toolchain>([
  ["retro68-68k", retro68_68k],
]);

/** Default backend when a project doesn't specify one. */
export const DEFAULT_TOOLCHAIN_ID = "retro68-68k";

export function getToolchain(id: string | undefined, baseUrl: string): Toolchain {
  const factory = registry.get(id ?? DEFAULT_TOOLCHAIN_ID) ?? registry.get(DEFAULT_TOOLCHAIN_ID)!;
  return factory(baseUrl);
}

/** List every registered backend (for future picker UIs). */
export function listToolchains(baseUrl: string): readonly Toolchain[] {
  return [...registry.values()].map((f) => f(baseUrl));
}
