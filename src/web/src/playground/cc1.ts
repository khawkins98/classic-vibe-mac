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
      // mkdir -p every parent dir.
      const parts = full.split("/").filter((p) => p.length > 0);
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path += "/" + parts[i];
        if (!madeDirs.has(path)) {
          try {
            Module.FS.mkdir(path);
          } catch {
            // Directory may have been created by an earlier entry under
            // a different prefix; the set above usually avoids this.
          }
          madeDirs.add(path);
        }
      }
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
 *  references in the active source resolve. Quoted includes lookup is
 *  relative to the including file's directory, and the active source is
 *  always written to `/tmp/`. */
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

  // Sanitize sourceName for use as an in-MEMFS filename. We allow
  // letters/digits/dot/dash/underscore; anything else gets replaced with
  // underscore. cc1 doesn't care about the path content, but a stray slash
  // would cause writeFile to fail.
  const safeName = sourceName.replace(/[^A-Za-z0-9._-]/g, "_") || "in.c";
  const inPath = `/tmp/${safeName}`;
  const outPath = `/tmp/out.s`;

  for (const p of [inPath, outPath]) {
    try {
      Module.FS.unlink(p);
    } catch {
      /* not present */
    }
  }

  // Write sibling project files first, then the active source last so a
  // sibling with the same name as the active file doesn't overwrite the
  // user's current buffer.
  if (options?.siblings) {
    for (const sib of options.siblings) {
      const sibSafe = sib.name.replace(/[^A-Za-z0-9._-]/g, "_");
      if (!sibSafe) continue;
      if (sibSafe === safeName) continue;
      Module.FS.writeFile(`/tmp/${sibSafe}`, sib.content);
    }
  }
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
