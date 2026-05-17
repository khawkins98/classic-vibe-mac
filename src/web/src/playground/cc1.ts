/**
 * cc1.ts — JS bridge to the in-browser wasm cc1 C compiler.
 *
 * This is the sibling of rez.ts: same lazy-load-then-reuse Module pattern,
 * but consuming Emscripten's ES-module factory output (`cc1.mjs`) rather
 * than the legacy `<script>` glue wasm-rez uses.
 *
 * Lifecycle:
 *   - First call to compileToAsm() dynamic-imports cc1.mjs (~150 KB) and
 *     fetches cc1.wasm (~12 MB raw / 3.4 MB brotli). Emscripten resolves
 *     cc1.wasm via `import.meta.url`, so it just lands next to cc1.mjs.
 *   - The sysroot (Retro68 Mac Toolbox headers + GCC builtins, ~1.1 MB
 *     raw / 185 KB brotli) is fetched as `sysroot.bin` + `sysroot.index.json`
 *     and unpacked into MEMFS once at `/sysroot/...`.
 *   - Subsequent calls reuse the same Module — they just overwrite
 *     `/tmp/in.c` and re-run callMain.
 *
 * cc1 is byte-deterministic and serial — no shared state across calls
 * beyond MEMFS, and we clean /tmp/in.c + /tmp/out.s between invocations.
 *
 * The "Show Assembly" feature is intentionally compile-only — no as,
 * no ld, no MacBinary packaging. Output is the raw m68k assembly cc1
 * emits via `-o <file>.s`.
 */
import type { Diagnostic } from "./preprocessor";
import { timeFetch } from "./fetchStats";
// Shared cc1/as/ld/Elf2Mac argv builders — also imported by the
// Node-side audit (scripts/audit-wasm-samples.mjs), so a flag bump
// in either path can't drift away from the other (#267 family).
import { cc1Args } from "./compileArgs.mjs";
// Shared cc1 → as → ld → Elf2Mac pipeline runner (cv-mac #271).
// compileToBin below delegates the per-stage sequencing to this and
// adds the browser-only wrapping (diagnostic parsing, wasm-trap
// promotion, rich result shape). The audit script uses the same
// runner with a Node-flavoured deps bag.
import { runCompilePipeline } from "./compilePipeline.mjs";
// cv-mac system headers — inlined at build time via Vite's `?raw`
// import. Each entry gets dropped into `/sysroot/include/<name>` by
// `mountSysroot()` so any playground project can `#include <name>`
// without per-project bundling. To add a new system header:
//   1. import it here with `?raw`
//   2. add an entry to CVM_SYSTEM_HEADERS below
// The same list is mirrored in scripts/audit-wasm-samples.mjs so
// the Node-side CI audit sees identical behaviour.
import CVM_LOG_H from "../../../app/wasm-debug-console/cvm_log.h?raw";

const CVM_SYSTEM_HEADERS: ReadonlyArray<{ path: string; content: string }> = [
  { path: "/sysroot/include/cvm_log.h", content: CVM_LOG_H },
];

interface Cc1Module {
  FS: {
    writeFile(path: string, data: string | Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    mkdir(path: string): void;
    analyzePath?(path: string): { exists: boolean };
  };
  callMain(args: string[]): number;
}

/** Emscripten ES-module factory shape. cc1.mjs exports a default async
 *  function that returns a ready Module. */
type Cc1Factory = (opts: {
  noInitialRun?: boolean;
  print?: (s: string) => void;
  printErr?: (s: string) => void;
  locateFile?: (path: string, scriptDir: string) => string;
}) => Promise<Cc1Module>;

interface SysrootIndexEntry {
  /** Path within the sysroot, e.g. `include/Quickdraw.h`. */
  p: string;
  /** Byte offset inside sysroot.bin. */
  o: number;
  /** Byte length. */
  l: number;
}

/**
 * Important: cc1 (and the other Retro68 toolchain binaries) are
 * **not** safe to re-invoke on the same Emscripten Module. GCC's `main`
 * mutates static globals (including `decode_options`'s "output file
 * already set" flag), and a second `Module.callMain(["...", "-o", X])`
 * sees the prior call's `-o` state and errors with "output filename
 * specified twice". Emscripten can't simulate process re-creation; the
 * heap and statics persist across exits.
 *
 * Our compile bridges therefore instantiate a **fresh** Module per
 * invocation. The expensive parts have caches:
 *   - The cc1.mjs / as.mjs / etc. ES factory modules are loaded once
 *     (browser ES module loader handles caching).
 *   - The wasm bytes come from the HTTP cache after the first fetch.
 *   - The parsed sysroot blob + index (Uint8Array + JS object) live
 *     in module scope and are shared across calls.
 *
 * What re-runs per call: the Emscripten Module instantiation
 * (~100-300ms for cc1) and the MEMFS sysroot mount (~100-200ms for
 * 220 header files). Net Show Assembly latency went from ~150ms warm
 * to ~400-500ms warm — under the panel's 500ms debounce so the
 * user-perceived "stop typing → asm updates" cycle is unchanged.
 *
 * See LEARNINGS "2026-05-15 — cc1.wasm is not re-entrant" for the
 * root cause investigation.
 */
let stderrBuffer = "";

/** Normalize a relative path (possibly containing `/`) into a safe sequence
 *  of MEMFS-friendly segments. Returns null if the path is empty,
 *  absolute, escapes upwards via `..`, or any segment normalizes to empty.
 *  Allowed segment chars: `A-Z a-z 0-9 . _ -`. Anything else (spaces,
 *  unicode, control chars) becomes `_`. */
function safeRelativePath(rel: string): string | null {
  if (!rel || rel.startsWith("/")) return null;
  const parts = rel.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const cleaned: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "..") return null;
    const s = part.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!s) return null;
    cleaned.push(s);
  }
  return cleaned.join("/");
}

/** mkdir -p the parent directories of `absPath` inside MEMFS. The set
 *  remembers which dirs we already created so re-calls are cheap. The
 *  caller passes `/sysroot` or `/tmp` (or `/`) as the implicit root —
 *  whichever Module.FS.mkdir for has already been called. */
function mkdirP(
  Module: Cc1Module,
  absPath: string,
  madeDirs: Set<string>,
): void {
  const parts = absPath.split("/").filter((p) => p.length > 0);
  let path = "";
  for (let i = 0; i < parts.length - 1; i++) {
    path += "/" + parts[i];
    if (!madeDirs.has(path)) {
      try {
        Module.FS.mkdir(path);
      } catch {
        // Race with a parallel mkdir-p (same parent path produced by two
        // unrelated entries); harmless.
      }
      madeDirs.add(path);
    }
  }
}

/**
 * Instantiate a fresh cc1 Module with the headers sysroot mounted at
 * `/sysroot`. Returns a brand-new Module each call — the caller must
 * use it once and let it be garbage-collected after `callMain` exits.
 * See the re-entrancy note at the top of this file.
 *
 * The sysroot blob is fetched once (cached at module scope) and
 * re-walked into the new Module's MEMFS on each call. ES factory
 * module + wasm bytes come from the browser cache after first call.
 */
async function loadModule(baseUrl: string): Promise<Cc1Module> {
  // Dynamic ESM import. The @vite-ignore comment opts out of Vite's
  // static-import analysis — we don't want it trying to bundle cc1.mjs
  // (it's an Emscripten artefact served from public/ verbatim).
  const factoryMod = await import(/* @vite-ignore */ `${baseUrl}wasm-cc1/cc1.mjs`);
  const factory = factoryMod.default as Cc1Factory;
  if (typeof factory !== "function") {
    throw new Error(
      `wasm-cc1/cc1.mjs: expected default export to be a factory function, ` +
        `got ${typeof factory}`,
    );
  }

  const Module = await factory({
    noInitialRun: true,
    // Capture both stdout (cc1 normally has none) and stderr (where
    // diagnostics live) in one buffer — parsing is the same either way.
    print: (s) => {
      stderrBuffer += s + "\n";
    },
    printErr: (s) => {
      stderrBuffer += s + "\n";
    },
    // Tell Emscripten to fetch cc1.wasm from the same public/ folder.
    // Emscripten's default behaviour using import.meta.url works in
    // practice, but being explicit means we survive any URL-resolution
    // quirks across build modes (dev vs prod, base path).
    locateFile: (path) => {
      if (path === "cc1.wasm") return `${baseUrl}wasm-cc1/cc1.wasm`;
      return `${baseUrl}wasm-cc1/${path}`;
    },
  });

  await mountSysroot(Module, await loadHeadersBlob(baseUrl), "headers");
  return Module;
}

/**
 * Mount the Retro68 sysroot blob into a fresh Emscripten Module's
 * MEMFS at `/sysroot/`, then add cv-mac-only system headers like
 * cvm_log.h to `/sysroot/include/`.
 *
 * Single source of truth for sysroot mounting — both `loadModule()`
 * (the Show-ASM path) and `loadToolModule()` (the Build path) route
 * here. PR #267 was a hot-fix for what happens when the two paths
 * diverge (cvm_log.h was mounted in one but not the other; Glypha's
 * Build hit "cvm_log.h: No such file or directory" while audit + ASM
 * passed).
 *
 * @param Module       Fresh Emscripten Module with FS available
 * @param blobAndIndex `{ blob, index }` from `loadHeadersBlob` or
 *                     `loadLibsBlob`
 * @param mode         "headers" mounts cvm_log.h alongside; "libs"
 *                     skips it (ld/Elf2Mac don't need C headers)
 */
async function mountSysroot(
  Module: Cc1Module,
  blobAndIndex: { blob: Uint8Array; index: SysrootIndexEntry[] },
  mode: "headers" | "libs",
): Promise<void> {
  const { blob, index } = blobAndIndex;
  try { Module.FS.mkdir("/sysroot"); } catch { /* exists */ }
  // Track directories we've already mkdir'd to avoid throwing/catching
  // hundreds of times — significant on Safari where the throw path is slow.
  const madeDirs = new Set<string>(["/sysroot"]);
  for (const entry of index) {
    const full = "/sysroot/" + entry.p;
    mkdirP(Module, full, madeDirs);
    Module.FS.writeFile(full, blob.subarray(entry.o, entry.o + entry.l));
  }
  // cv-mac-only system headers — dropped into /sysroot/include/ for
  // the "headers" mount only. New additions: add an entry to
  // CVM_SYSTEM_HEADERS at the top of this file + an `?raw` import.
  if (mode === "headers") {
    for (const { path, content } of CVM_SYSTEM_HEADERS) {
      mkdirP(Module, path, madeDirs);
      Module.FS.writeFile(path, content);
    }
  }
}

/** Optional per-call inputs. `siblings` is the playground project's other
 *  `.c` / `.h` files (read from IDB by the caller) — we write each one
 *  into `/tmp/<name>` before compiling so that quoted `#include "x.h"`
 *  references in the active source resolve. Quoted-include lookup is
 *  relative to the including file's directory, and the active source is
 *  always written to `/tmp/${sourceName}`.
 *
 *  Sibling names may include `/` to keep nested project layouts intact
 *  (e.g. `name: "lib/util.h"` writes to `/tmp/lib/util.h`). Each path
 *  segment is sanitized to `[A-Za-z0-9._-]` and absolute / `..`-escaping
 *  paths are rejected. Same rule applies to `sourceName`. */
export interface CompileToAsmOptions {
  siblings?: ReadonlyArray<{ name: string; content: string }>;
  /** Optimization level for cc1 (cv-mac #100 Phase E). Defaults to
   *  `"O0"` — matches the existing pipeline so showing assembly without
   *  an explicit level doesn't surprise existing users. */
  optLevel?: "O0" | "Os" | "O2";
}

export interface CompileToAsmResult {
  /** True iff cc1 exited 0 and produced /tmp/out.s. */
  ok: boolean;
  /** m68k assembly as cc1 emitted it. Undefined on failure. */
  asm?: string;
  /** Verbatim cc1 stderr — useful for showing warnings even on success. */
  rawStderr: string;
  /** Parsed diagnostics. Position-bearing lines only; the rest stays in
   *  rawStderr. */
  diagnostics: Diagnostic[];
  /** Wall time of the compile (Module already warm). */
  durationMs: number;
}

/**
 * Compile a single C translation unit through wasm cc1.
 *
 * `sourceName` is purely cosmetic — it shows up in cc1's diagnostics as
 * the filename. We always write the source to `/tmp/in.c` and emit to
 * `/tmp/out.s` regardless; only diagnostic strings carry the user-visible
 * filename, and cc1 uses the path we pass on the command line. So we pass
 * a synthetic path "${sourceName}" that cc1 records into the .file
 * directive of the output asm.
 */
export async function compileToAsm(
  baseUrl: string,
  source: string,
  sourceName: string,
  options?: CompileToAsmOptions,
): Promise<CompileToAsmResult> {
  const Module = await loadModule(baseUrl);
  stderrBuffer = "";

  // Normalize the source path. Nested paths (e.g. "lib/foo.c") are
  // supported — cc1 doesn't care, and quoted-include lookup happens
  // relative to the source file's directory, so siblings under
  // `/tmp/lib/` resolve naturally.
  const safeName = safeRelativePath(sourceName) ?? "in.c";
  const inPath = `/tmp/${safeName}`;
  const outPath = `/tmp/out.s`;

  for (const p of [inPath, outPath]) {
    try {
      Module.FS.unlink(p);
    } catch {
      /* not present */
    }
  }

  // Per-call mkdir-p cache. Re-used for siblings and the source file.
  // The sysroot mkdir set lives in loadModule's closure and isn't shared
  // here — that's fine, we only write into /tmp here, not /sysroot.
  const tmpDirs = new Set<string>(["/tmp"]);

  // Write sibling project files first, then the active source last so a
  // sibling with the same name as the active file doesn't overwrite the
  // user's current buffer.
  if (options?.siblings) {
    for (const sib of options.siblings) {
      const sibSafe = safeRelativePath(sib.name);
      if (!sibSafe) continue;
      if (sibSafe === safeName) continue;
      const sibPath = `/tmp/${sibSafe}`;
      mkdirP(Module, sibPath, tmpDirs);
      Module.FS.writeFile(sibPath, sib.content);
    }
  }
  mkdirP(Module, inPath, tmpDirs);
  Module.FS.writeFile(inPath, source);

  const t0 = performance.now();
  let rc: number;
  try {
    rc = Module.callMain(cc1Args({
      source: inPath,
      output: outPath,
      optLevel: options?.optLevel ?? "O0",
    }));
  } catch (e) {
    const err = e as { name?: string; status?: number; message?: string };
    if (err.name === "ExitStatus") {
      rc = err.status ?? 1;
    } else {
      const durationMs = performance.now() - t0;
      return {
        ok: false,
        rawStderr: stderrBuffer,
        diagnostics: [
          {
            file: sourceName,
            line: 1,
            column: 1,
            severity: "error",
            message: `wasm cc1 threw: ${err.message ?? String(e)}`,
          },
        ],
        durationMs,
      };
    }
  }
  const durationMs = performance.now() - t0;

  const diagnostics = parseCc1Stderr(stderrBuffer, sourceName);

  if (rc !== 0) {
    if (diagnostics.length === 0) {
      diagnostics.push({
        file: sourceName,
        line: 1,
        column: 1,
        severity: "error",
        message: `cc1 exited rc=${rc} with no parseable diagnostics`,
      });
    }
    return { ok: false, rawStderr: stderrBuffer, diagnostics, durationMs };
  }

  let asm: string;
  try {
    asm = new TextDecoder().decode(Module.FS.readFile(outPath));
  } catch (e) {
    return {
      ok: false,
      rawStderr: stderrBuffer,
      diagnostics: [
        {
          file: sourceName,
          line: 1,
          column: 1,
          severity: "error",
          message: `cc1 returned 0 but no /tmp/out.s: ${(e as Error).message}`,
        },
      ],
      durationMs,
    };
  }

  return { ok: true, asm, rawStderr: stderrBuffer, diagnostics, durationMs };
}

/**
 * Parse GCC-style stderr into structured diagnostics. Lines look like:
 *
 *   <file>:<line>:<col>: error: <msg>
 *   <file>:<line>:<col>: warning: <msg>
 *   <file>:<line>: error: <msg>
 *
 * Notes and context lines without a severity get folded into the previous
 * diagnostic's message. Unparseable lines stay in rawStderr only.
 */
function parseCc1Stderr(stderr: string, defaultFile: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of stderr.split(/\r\n|\n/)) {
    const line = raw;
    if (!line.trim()) continue;

    let m = line.match(
      /^([^:]+):(\d+):(\d+):\s*(error|warning|fatal error):\s*(.*)$/,
    );
    if (m) {
      const sev = m[4]!.startsWith("warning") ? "warning" : "error";
      out.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        column: parseInt(m[3]!, 10),
        severity: sev,
        message: m[5]!,
      });
      continue;
    }
    m = line.match(/^([^:]+):(\d+):\s*(error|warning|fatal error):\s*(.*)$/);
    if (m) {
      const sev = m[3]!.startsWith("warning") ? "warning" : "error";
      out.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        column: 1,
        severity: sev,
        message: m[4]!,
      });
      continue;
    }
    m = line.match(/^(error|warning|fatal error):\s*(.*)$/);
    if (m) {
      const sev = m[1]!.startsWith("warning") ? "warning" : "error";
      out.push({
        file: defaultFile,
        line: 1,
        column: 1,
        severity: sev,
        message: m[2]!,
      });
    }
    // Unmatched lines are dropped from structured output but remain in
    // rawStderr for the debug panel.
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════
// Full pipeline: C → MacBinary II APPL via cc1 → as → ld → Elf2Mac
// (wasm-retro-cc #15 / cv-mac #64)
// ═════════════════════════════════════════════════════════════════════
//
// This is the "Build .c" path the playground will eventually wire to the
// Build & Run button for .c-driven projects. The Show Assembly path
// (compileToAsm above) is unchanged — it shares the same vendored
// cc1.mjs + sysroot.bin URLs, so the asset cache hits on the first byte.
//
// What's NOT shared between paths:
//   - Module instances: each compileToBin call uses a *fresh* chain of
//     four Modules. They're created on the first call and cached. Show
//     Assembly's cc1 Module is independent (different MEMFS state) so
//     the two paths can run concurrently without racing on /tmp/in.c.
//     Cost: ~12 MB extra heap once compileToBin has been called.
//   - Sysroot mount: cc1 needs the headers blob (already shared with
//     Show Assembly path's blob fetch), ld needs the libs blob (new
//     this PR, ~1.1 MB brotli). as and Elf2Mac don't read /sysroot/
//     so we skip the mount for them.

interface ToolHandle {
  Module: Cc1Module;
  /** Captured stderr lines from the latest callMain. Cleared at the
   *  start of each invocation. */
  stderr: string[];
}

/** Cached header blob (gcc-include + include — for cc1). Show Assembly
 *  already fetches this for its own Module's MEMFS mount; the
 *  compileToBin path re-uses the same URL so the browser cache hits. */
let headersBlobPromise: Promise<{ blob: Uint8Array; index: SysrootIndexEntry[] }> | null = null;

/** Cached libs blob (lib/* + retro68-flat.ld — for ld). */
let libsBlobPromise: Promise<{ blob: Uint8Array; index: SysrootIndexEntry[] }> | null = null;

async function fetchSysrootBlob(
  baseUrl: string,
  binPath: string,
  indexPath: string,
): Promise<{ blob: Uint8Array; index: SysrootIndexEntry[] }> {
  return timeFetch(`sysroot:${binPath}`, async () => {
    const [blobBuf, indexText] = await Promise.all([
      fetch(`${baseUrl}wasm-cc1/${binPath}`).then((r) => {
        if (!r.ok) throw new Error(`${binPath}: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(`${baseUrl}wasm-cc1/${indexPath}`).then((r) => {
        if (!r.ok) throw new Error(`${indexPath}: HTTP ${r.status}`);
        return r.text();
      }),
    ]);
    return {
      blob: new Uint8Array(blobBuf),
      index: JSON.parse(indexText) as SysrootIndexEntry[],
    };
  });
}

function loadHeadersBlob(baseUrl: string) {
  if (headersBlobPromise) return headersBlobPromise;
  headersBlobPromise = fetchSysrootBlob(baseUrl, "sysroot.bin", "sysroot.index.json");
  headersBlobPromise.catch(() => { headersBlobPromise = null; });
  return headersBlobPromise;
}

function loadLibsBlob(baseUrl: string) {
  if (libsBlobPromise) return libsBlobPromise;
  libsBlobPromise = fetchSysrootBlob(baseUrl, "sysroot-libs.bin", "sysroot-libs.index.json");
  libsBlobPromise.catch(() => { libsBlobPromise = null; });
  return libsBlobPromise;
}

/** Generic Emscripten ES-module factory loader for as/ld/Elf2Mac.
 *  Each tool gets its own stderr accumulator that the caller drains
 *  between callMain invocations. */
async function loadToolModule(
  baseUrl: string,
  mjsName: string,
  mount: "none" | "headers" | "libs",
): Promise<ToolHandle> {
  // The dynamic import resolves the tool's .mjs glue + its sibling
  // .wasm — both round-trips count as network/resource time, not
  // compile time.
  const factoryMod = await timeFetch(`tool:${mjsName}`, () =>
    import(/* @vite-ignore */ `${baseUrl}wasm-cc1/${mjsName}`),
  );
  const factory = factoryMod.default as Cc1Factory;
  if (typeof factory !== "function") {
    throw new Error(
      `wasm-cc1/${mjsName}: expected default export to be a factory function`,
    );
  }
  const stderr: string[] = [];
  const Module = await factory({
    noInitialRun: true,
    print: (s) => stderr.push(s),
    printErr: (s) => stderr.push(s),
    locateFile: (path) => `${baseUrl}wasm-cc1/${path}`,
  });

  if (mount !== "none") {
    const blobAndIndex =
      mount === "headers"
        ? await loadHeadersBlob(baseUrl)
        : await loadLibsBlob(baseUrl);
    await mountSysroot(Module, blobAndIndex, mount);
  }
  return { Module, stderr };
}

// Important: these tools are NOT cached across compileToBin calls.
// See the re-entrancy note at the top of this file — cc1 / as / ld /
// Elf2Mac all carry state in their statics that breaks a second
// `callMain` (output-file flag, getopt index, malloc bookkeeping).
// Each compileToBin call uses fresh Module instances; the wasm bytes
// come from the browser HTTP cache so the extra fetch is a no-op.
function loadCc1Tool(baseUrl: string) {
  return loadToolModule(baseUrl, "cc1.mjs", "headers");
}
function loadAsTool(baseUrl: string) {
  return loadToolModule(baseUrl, "as.mjs", "none");
}
function loadLdTool(baseUrl: string) {
  return loadToolModule(baseUrl, "ld.mjs", "libs");
}
function loadElf2MacTool(baseUrl: string) {
  return loadToolModule(baseUrl, "Elf2Mac.mjs", "none");
}

/** Per-stage telemetry, useful for the Build UI's status line. */
export interface CompileToBinStages {
  cc1Ms: number;
  asMs: number;
  ldMs: number;
  elf2macMs: number;
}

export interface CompileToBinResult {
  /** True iff all four stages exited 0 and Elf2Mac emitted a `.bin`. */
  ok: boolean;
  /** MacBinary II APPL bytes on success. */
  bin?: Uint8Array;
  /** Intermediate m68k assembly text — handy for debugging or wiring
   *  Show Assembly off the same compile. */
  asm?: string;
  /** Parsed diagnostics from any stage. cc1's lookahead is the most
   *  common source; as/ld can produce warnings too. */
  diagnostics: Diagnostic[];
  /** Verbatim stderr concatenated across stages with stage-prefix
   *  separators. The Build UI's "details" disclosure renders this. */
  rawStderr: string;
  /** Which stage failed (1=cc1, 2=as, 3=ld, 4=Elf2Mac). Undefined on
   *  success. Helps the UI write "Linker error" vs "Compile error". */
  failedStage?: 1 | 2 | 3 | 4;
  /** Total wall time across all four stages, ms. */
  totalMs: number;
  stages?: CompileToBinStages;
}

/** A single source file passed to {@link compileToBin}. Files with a
 *  `.c` extension are compiled to objects and linked; `.h` files are
 *  co-mounted into MEMFS so cc1's `#include` can find them. Other
 *  extensions are ignored. */
export interface CompileToBinSource {
  filename: string;
  content: string;
}

export interface CompileToBinOptions {
  /** All source files for the build. At least one `.c` file required. */
  sources: CompileToBinSource[];
  /** Override the file name used for diagnostics labelling when no
   *  per-source stderr lookup can pinpoint the failing source. Defaults
   *  to the first `.c` file in {@link sources}. */
  primaryName?: string;
  /** GCC optimization level flag (cv-mac #100 Phase E). One of
   *  `"O0"` (default), `"Os"`, `"O2"`. Passed verbatim to cc1 as
   *  `-O<level>`. The caller reads this from `getOptLevel()` so the
   *  toolbar dropdown is the single source of truth. */
  optLevel?: "O0" | "Os" | "O2";
}

/**
 * Compile one or more C translation units all the way to a structurally-valid
 * single-fork MacBinary II APPL — same pipeline `spike/wasm-cc1/test/full-pipeline.mjs`
 * proves Node-side, extended for multi-file projects (cv-mac #100 Phase A).
 *
 * Each `.c` source gets its own fresh cc1 + as Module (cc1 isn't re-entrant
 * — see LEARNINGS Key Story #3), produces a `<basename>.o`, and feeds into
 * a single ld + Elf2Mac stage. `.h` siblings are co-mounted into every
 * cc1's MEMFS for `#include` resolution.
 *
 * Memory cost scales linearly with the number of `.c` files (~12 MB extra
 * heap per cc1 Module while compiling, freed after each finishes). Build
 * time is also linear, dominated by the cc1 stage (~50-200 ms per file).
 */
export async function compileToBin(
  baseUrl: string,
  options: CompileToBinOptions,
): Promise<CompileToBinResult> {
  const t0 = performance.now();
  const cSources = options.sources.filter((s) => /\.c$/i.test(s.filename));
  if (cSources.length === 0) {
    return {
      ok: false,
      diagnostics: [{
        file: options.primaryName ?? "(no source)", line: 1, column: 1,
        severity: "error",
        message: `compileToBin requires at least one .c source file.`,
      }],
      rawStderr: "",
      failedStage: 1,
      totalMs: performance.now() - t0,
      stages: { cc1Ms: 0, asMs: 0, ldMs: 0, elf2macMs: 0 },
    };
  }
  const primaryName =
    options.primaryName ??
    (safeRelativePath(cSources[0]!.filename) ?? "in.c");

  // Delegate the cc1 → as → ld → Elf2Mac sequence to the shared
  // pipeline (cv-mac #271). We supply the browser-flavoured tool
  // loaders; the pipeline drives them and returns raw stages +
  // stderr that we project into the rich CompileToBinResult shape.
  const pipeline = await runCompilePipeline(
    {
      sources: options.sources,
      primaryName,
      optLevel: options.optLevel ?? "O0",
    },
    {
      loadCc1:     () => loadCc1Tool(baseUrl),
      loadAs:      () => loadAsTool(baseUrl),
      loadLd:      () => loadLdTool(baseUrl),
      loadElf2Mac: () => loadElf2MacTool(baseUrl),
    },
  );

  // Parse cc1 stderr blobs into structured diagnostics. Each entry
  // in `stderrPerStage` is prefixed with `[stage filename?]`; the
  // first line is the prefix and the rest is raw stderr we feed
  // through the existing parser so warnings show up in the Output
  // panel as clickable rows. Non-cc1 stages (as/ld/elf2mac) don't
  // emit GCC-format diagnostics — leave them as raw lines.
  const allDiags: Diagnostic[] = [];
  for (const blob of pipeline.stderrPerStage) {
    const firstNl = blob.indexOf("\n");
    if (firstNl < 0) continue;
    const tag = blob.slice(0, firstNl); // e.g. "[cc1 main.c]"
    const body = blob.slice(firstNl + 1);
    if (!body) continue;
    const cc1Match = tag.match(/^\[cc1 (.+)\]$/);
    if (cc1Match) {
      allDiags.push(...parseCc1Stderr(body, cc1Match[1]!));
    }
  }
  const rawStderr = pipeline.stderrPerStage.join("\n\n");

  if (!pipeline.ok) {
    // Map pipeline failure into the rich diagnostic shape callers
    // expect. cc1 failures may include a wasm-trap line we promote
    // to a top-level diagnostic so the status bar surfaces the
    // "try -O0" hint instead of a bare exit code.
    const failedFile = pipeline.failedFile ?? primaryName;
    const stageBlob =
      pipeline.stderrPerStage[pipeline.stderrPerStage.length - 1] ?? "";
    const stageBody = stageBlob.split("\n").slice(1).join("\n");
    const trapLine = stageBody.split("\n").find((l) => l.startsWith("wasm trap:"));
    const failDiag: Diagnostic[] =
      trapLine
        ? [{ file: failedFile, line: 1, column: 1, severity: "error", message: trapLine }]
        : allDiags.length === 0
          ? [{
              file: failedFile,
              line: 1,
              column: 1,
              severity: "error",
              message: `${pipeline.failedStage} failed: ${stageBody.split("\n")[0] ?? "(no message)"}`,
            }]
          : [];
    return {
      ok: false,
      asm: pipeline.asm,
      diagnostics: [...allDiags, ...failDiag],
      rawStderr,
      failedStage: stageToNumber(pipeline.failedStage),
      totalMs: performance.now() - t0,
      stages: pipeline.stages,
    };
  }

  return {
    ok: true,
    bin: pipeline.bin,
    asm: pipeline.asm,
    diagnostics: allDiags,
    rawStderr,
    totalMs: performance.now() - t0,
    stages: pipeline.stages,
  };
}

/** Map the shared pipeline's stage-name back to the legacy 1-4
 *  failedStage number used in CompileToBinResult. */
function stageToNumber(
  stage: "cc1" | "as" | "ld" | "elf2mac" | undefined,
): 1 | 2 | 3 | 4 | undefined {
  switch (stage) {
    case "cc1": return 1;
    case "as": return 2;
    case "ld": return 3;
    case "elf2mac": return 4;
    default: return undefined;
  }
}
