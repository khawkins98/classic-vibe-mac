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

/** Per-instance state. We only ever build one. */
let modulePromise: Promise<Cc1Module> | null = null;
/** Accumulates print/printErr lines between callMain invocations. */
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
 * Lazily load cc1.mjs, instantiate the Module, and mount the sysroot
 * tarball into MEMFS at `/sysroot`. The returned promise resolves once
 * the compiler is ready to accept its first compile call.
 *
 * Caller is responsible for not running concurrent compileToAsm() calls;
 * they would race on /tmp/in.c. The Show Assembly UI serializes via a
 * single in-flight token, so this is fine in practice.
 */
function loadModule(baseUrl: string): Promise<Cc1Module> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
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

    // Mount the sysroot. We fetch the flat blob + JSON index in parallel.
    const [blobBuf, indexJson] = await Promise.all([
      fetch(`${baseUrl}wasm-cc1/sysroot.bin`).then((r) => {
        if (!r.ok) throw new Error(`sysroot.bin: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
      fetch(`${baseUrl}wasm-cc1/sysroot.index.json`).then((r) => {
        if (!r.ok) throw new Error(`sysroot.index.json: HTTP ${r.status}`);
        return r.text();
      }),
    ]);
    const index = JSON.parse(indexJson) as SysrootIndexEntry[];
    const blob = new Uint8Array(blobBuf);

    Module.FS.mkdir("/sysroot");
    // Track directories we've already mkdir'd to avoid throwing/catching
    // hundreds of times — significant on Safari where the throw path is slow.
    const madeDirs = new Set<string>(["/sysroot"]);
    for (const entry of index) {
      const full = "/sysroot/" + entry.p;
      mkdirP(Module, full, madeDirs);
      Module.FS.writeFile(
        full,
        blob.subarray(entry.o, entry.o + entry.l),
      );
    }
    return Module;
  })();
  // On a failed load, allow the next call to try again. Without this the
  // playground would be stuck on a transient network failure.
  modulePromise.catch(() => {
    modulePromise = null;
  });
  return modulePromise;
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
    rc = Module.callMain([
      "-quiet",
      "-isystem", "/sysroot/gcc-include",
      "-isystem", "/sysroot/include",
      "-mcpu=68020",
      inPath,
      "-o", outPath,
    ]);
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

/** Per-tool cached Modules. Built once on the first compileToBin call,
 *  reused on every subsequent call. */
let cc1ToolPromise: Promise<ToolHandle> | null = null;
let asToolPromise: Promise<ToolHandle> | null = null;
let ldToolPromise: Promise<ToolHandle> | null = null;
let elf2macToolPromise: Promise<ToolHandle> | null = null;

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
  const factoryMod = await import(/* @vite-ignore */ `${baseUrl}wasm-cc1/${mjsName}`);
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
    const { blob, index } =
      mount === "headers"
        ? await loadHeadersBlob(baseUrl)
        : await loadLibsBlob(baseUrl);
    try { Module.FS.mkdir("/sysroot"); } catch {}
    const made = new Set<string>(["/sysroot"]);
    for (const entry of index) {
      const full = "/sysroot/" + entry.p;
      mkdirP(Module, full, made);
      Module.FS.writeFile(full, blob.subarray(entry.o, entry.o + entry.l));
    }
  }
  return { Module, stderr };
}

function loadCc1Tool(baseUrl: string) {
  if (cc1ToolPromise) return cc1ToolPromise;
  cc1ToolPromise = loadToolModule(baseUrl, "cc1.mjs", "headers");
  cc1ToolPromise.catch(() => { cc1ToolPromise = null; });
  return cc1ToolPromise;
}
function loadAsTool(baseUrl: string) {
  if (asToolPromise) return asToolPromise;
  asToolPromise = loadToolModule(baseUrl, "as.mjs", "none");
  asToolPromise.catch(() => { asToolPromise = null; });
  return asToolPromise;
}
function loadLdTool(baseUrl: string) {
  if (ldToolPromise) return ldToolPromise;
  ldToolPromise = loadToolModule(baseUrl, "ld.mjs", "libs");
  ldToolPromise.catch(() => { ldToolPromise = null; });
  return ldToolPromise;
}
function loadElf2MacTool(baseUrl: string) {
  if (elf2macToolPromise) return elf2macToolPromise;
  elf2macToolPromise = loadToolModule(baseUrl, "Elf2Mac.mjs", "none");
  elf2macToolPromise.catch(() => { elf2macToolPromise = null; });
  return elf2macToolPromise;
}

function callMainSafe(tool: ToolHandle, argv: string[]): number {
  tool.stderr.length = 0;
  try {
    return tool.Module.callMain(argv);
  } catch (e) {
    const err = e as { name?: string; status?: number };
    if (err?.name === "ExitStatus") return err.status ?? 1;
    throw e;
  }
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

/**
 * Compile a single C translation unit all the way to a structurally-valid
 * single-fork MacBinary II APPL — same pipeline `spike/wasm-cc1/test/full-pipeline.mjs`
 * proves Node-side.
 *
 * The four wasm tools are loaded lazily on first call. Subsequent calls
 * reuse the cached Modules and overwrite their MEMFS scratch files. Each
 * tool gets its own MEMFS; we shuttle files via `FS.readFile` → `FS.writeFile`
 * between stages.
 *
 * `sourceName` flows into cc1's `.file` directive and into the names of
 * temporary MEMFS files. The sibling-file plumbing (project `.c`/`.h`
 * companions) mirrors `compileToAsm`'s contract — see CompileToAsmOptions.
 */
export async function compileToBin(
  baseUrl: string,
  source: string,
  sourceName: string,
  options?: CompileToAsmOptions,
): Promise<CompileToBinResult> {
  const t0 = performance.now();
  const stages: CompileToBinStages = { cc1Ms: 0, asMs: 0, ldMs: 0, elf2macMs: 0 };
  const allDiags: Diagnostic[] = [];
  const stderrParts: string[] = [];

  // Normalize the source filename. Same rules as compileToAsm.
  const safeName = safeRelativePath(sourceName) ?? "in.c";

  // ── Stage 1: cc1 ────────────────────────────────────────────────────
  const cc1 = await loadCc1Tool(baseUrl);
  const cc1In = `/tmp/${safeName}`;
  const cc1Out = `/tmp/out.s`;
  for (const p of [cc1In, cc1Out]) {
    try { cc1.Module.FS.unlink(p); } catch {}
  }
  // Sibling files (project .c/.h) — mirror compileToAsm's logic.
  const tmpDirs = new Set<string>(["/tmp"]);
  if (options?.siblings) {
    for (const sib of options.siblings) {
      const sibSafe = safeRelativePath(sib.name);
      if (!sibSafe || sibSafe === safeName) continue;
      const sibPath = `/tmp/${sibSafe}`;
      mkdirP(cc1.Module, sibPath, tmpDirs);
      cc1.Module.FS.writeFile(sibPath, sib.content);
    }
  }
  mkdirP(cc1.Module, cc1In, tmpDirs);
  cc1.Module.FS.writeFile(cc1In, source);
  const cc1Start = performance.now();
  const cc1Rc = callMainSafe(cc1, [
    "-quiet",
    "-isystem", "/sysroot/gcc-include",
    "-isystem", "/sysroot/include",
    "-mcpu=68020",
    cc1In,
    "-o", cc1Out,
  ]);
  stages.cc1Ms = performance.now() - cc1Start;
  const cc1Stderr = cc1.stderr.join("\n");
  if (cc1Stderr) stderrParts.push(`[cc1]\n${cc1Stderr}`);
  allDiags.push(...parseCc1Stderr(cc1Stderr, sourceName));
  if (cc1Rc !== 0) {
    return {
      ok: false,
      diagnostics: allDiags.length ? allDiags : [{
        file: sourceName, line: 1, column: 1, severity: "error",
        message: `cc1 exited rc=${cc1Rc}`,
      }],
      rawStderr: stderrParts.join("\n\n"),
      failedStage: 1,
      totalMs: performance.now() - t0,
      stages,
    };
  }
  const sBytes = cc1.Module.FS.readFile(cc1Out);
  const asmText = new TextDecoder().decode(sBytes);

  // ── Stage 2: as ─────────────────────────────────────────────────────
  const as = await loadAsTool(baseUrl);
  for (const p of ["/tmp/in.s", "/tmp/out.o"]) {
    try { as.Module.FS.unlink(p); } catch {}
  }
  as.Module.FS.writeFile("/tmp/in.s", sBytes);
  const asStart = performance.now();
  const asRc = callMainSafe(as, ["-march=68020", "/tmp/in.s", "-o", "/tmp/out.o"]);
  stages.asMs = performance.now() - asStart;
  const asStderr = as.stderr.join("\n");
  if (asStderr) stderrParts.push(`[as]\n${asStderr}`);
  if (asRc !== 0) {
    return {
      ok: false, asm: asmText,
      diagnostics: [...allDiags, {
        file: sourceName, line: 1, column: 1, severity: "error",
        message: `as exited rc=${asRc}: ${asStderr.split("\n")[0] ?? "(no message)"}`,
      }],
      rawStderr: stderrParts.join("\n\n"),
      failedStage: 2,
      totalMs: performance.now() - t0,
      stages,
    };
  }
  const oBytes = as.Module.FS.readFile("/tmp/out.o");

  // ── Stage 3: ld ─────────────────────────────────────────────────────
  const ld = await loadLdTool(baseUrl);
  for (const p of ["/tmp/in.o", "/tmp/out.gdb"]) {
    try { ld.Module.FS.unlink(p); } catch {}
  }
  ld.Module.FS.writeFile("/tmp/in.o", oBytes);
  const ldStart = performance.now();
  const ldRc = callMainSafe(ld, [
    "-T", "/sysroot/ld/retro68-flat.ld",
    "-L", "/sysroot/lib",
    "--no-warn-rwx-segments",
    "-o", "/tmp/out.gdb",
    "/tmp/in.o",
    "/sysroot/lib/libretrocrt.a",
    "/sysroot/lib/libInterface.a",
    "/sysroot/lib/libc.a",
  ]);
  stages.ldMs = performance.now() - ldStart;
  const ldStderr = ld.stderr.join("\n");
  if (ldStderr) stderrParts.push(`[ld]\n${ldStderr}`);
  if (ldRc !== 0) {
    return {
      ok: false, asm: asmText,
      diagnostics: [...allDiags, {
        file: sourceName, line: 1, column: 1, severity: "error",
        message: `ld exited rc=${ldRc}: ${ldStderr.split("\n")[0] ?? "(no message)"}`,
      }],
      rawStderr: stderrParts.join("\n\n"),
      failedStage: 3,
      totalMs: performance.now() - t0,
      stages,
    };
  }
  const elfBytes = ld.Module.FS.readFile("/tmp/out.gdb");

  // ── Stage 4: Elf2Mac ────────────────────────────────────────────────
  // Output filename MUST end in `.bin` — Elf2Mac's autodetect maps
  // extension → format, and any non-`.bin` falls through to Linux
  // split-fork mode (3 files, not MacBinary). See wasm-retro-cc
  // LEARNINGS.md "Phase 2.3d".
  // Elf2Mac reads the ELF from `<outputFile>.gdb`, legacy hangover from
  // when it spawned real ld. Convert-only mode preserves that path.
  const e2m = await loadElf2MacTool(baseUrl);
  for (const p of ["/tmp/out.bin", "/tmp/out.bin.gdb"]) {
    try { e2m.Module.FS.unlink(p); } catch {}
  }
  e2m.Module.FS.writeFile("/tmp/out.bin.gdb", elfBytes);
  const e2mStart = performance.now();
  const e2mRc = callMainSafe(e2m, ["--elf2mac", "-o", "/tmp/out.bin"]);
  stages.elf2macMs = performance.now() - e2mStart;
  const e2mStderr = e2m.stderr.join("\n");
  if (e2mStderr) stderrParts.push(`[Elf2Mac]\n${e2mStderr}`);
  if (e2mRc !== 0) {
    return {
      ok: false, asm: asmText,
      diagnostics: [...allDiags, {
        file: sourceName, line: 1, column: 1, severity: "error",
        message: `Elf2Mac exited rc=${e2mRc}: ${e2mStderr.split("\n")[0] ?? "(no message)"}`,
      }],
      rawStderr: stderrParts.join("\n\n"),
      failedStage: 4,
      totalMs: performance.now() - t0,
      stages,
    };
  }
  let binBytes: Uint8Array;
  try {
    binBytes = e2m.Module.FS.readFile("/tmp/out.bin");
  } catch (e) {
    return {
      ok: false, asm: asmText,
      diagnostics: [...allDiags, {
        file: sourceName, line: 1, column: 1, severity: "error",
        message: `Elf2Mac returned 0 but no /tmp/out.bin: ${(e as Error).message}`,
      }],
      rawStderr: stderrParts.join("\n\n"),
      failedStage: 4,
      totalMs: performance.now() - t0,
      stages,
    };
  }

  return {
    ok: true,
    bin: binBytes,
    asm: asmText,
    diagnostics: allDiags,
    rawStderr: stderrParts.join("\n\n"),
    totalMs: performance.now() - t0,
    stages,
  };
}
