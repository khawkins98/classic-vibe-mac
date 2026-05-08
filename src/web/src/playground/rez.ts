/**
 * rez.ts — JS bridge to the WASM-Rez compiler.
 *
 * Lifecycle:
 *   - Module loads lazily on the first compile. The 73KB JS + 316KB WASM
 *     don't get fetched until the user clicks Build, so the page-shell
 *     stays cheap. Subsequent compiles reuse the same Module.
 *   - Each compile call: write source to MEMFS at /in.r, callMain, read
 *     output from /out.bin, parse stderr for diagnostics, return both.
 *
 * Diagnostics shape: see preprocessor.ts. We parse stderr lines of the
 * form `file:line: error: msg` (and `warning:` variant). Anything that
 * doesn't match a recognised pattern is collected verbatim into
 * `rawStderr` so the editor's debug panel can show it without losing
 * context.
 *
 * The compile stage assumes its input has ALREADY been preprocessed by
 * preprocessor.ts. WASM-Rez's MiniLexer just skips `#`-prefixed lines and
 * has no #include / #define awareness. By the time we hand it source,
 * every macro is expanded and every include is inlined.
 */

import type { Diagnostic } from "./preprocessor";

interface RezModule {
  FS: {
    writeFile(path: string, data: string): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  callMain(args: string[]): number;
}

declare global {
  interface Window {
    /** Emscripten-emitted factory exported by wasm-rez.js. The export
     *  name is set by the CMake EXPORT_NAME flag (see
     *  tools/wasm-rez/CMakeLists.txt) to keep it stable across builds. */
    createRezModule?: (
      opts: {
        noInitialRun?: boolean;
        print?: (s: string) => void;
        printErr?: (s: string) => void;
        locateFile?: (path: string) => string;
      },
    ) => Promise<RezModule>;
  }
}

let modulePromise: Promise<RezModule> | null = null;
let stderrBuffer = "";

/** Lazily download and instantiate the WASM module. Subsequent calls
 *  resolve to the same module — Emscripten module instances are
 *  inherently single-tenant for `callMain`/FS state, but our
 *  one-shot compile pattern (write input, callMain, read output) is
 *  serial so contention is a non-issue today. If we ever need
 *  concurrent compiles, switch to a `WorkerPool` of fresh Modules. */
function loadModule(baseUrl: string): Promise<RezModule> {
  if (modulePromise) return modulePromise;
  modulePromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${baseUrl}wasm-rez/wasm-rez.js`;
    script.onload = () => {
      const factory = window.createRezModule;
      if (!factory) {
        reject(new Error("wasm-rez.js loaded but createRezModule missing"));
        return;
      }
      factory({
        noInitialRun: true,
        print: (s) => {
          stderrBuffer += s + "\n";
        },
        printErr: (s) => {
          stderrBuffer += s + "\n";
        },
        // Emscripten's glue (wasm-rez.js) hardcodes the WASM filename it
        // emitted from CMake — `mini-rez.wasm`, the legacy spike name.
        // We renamed the production blob to `wasm-rez.wasm` for naming
        // consistency, so we remap here. Anything else (e.g. data files
        // we may add later) goes through verbatim under wasm-rez/.
        locateFile: (path: string) => {
          if (path === "mini-rez.wasm") {
            return `${baseUrl}wasm-rez/wasm-rez.wasm`;
          }
          return `${baseUrl}wasm-rez/${path}`;
        },
      }).then(resolve, reject);
    };
    script.onerror = () =>
      reject(new Error(`Failed to load ${script.src}`));
    document.body.appendChild(script);
  });
  return modulePromise;
}

export interface CompileResult {
  /** True iff Rez exited 0 and produced an output. */
  ok: boolean;
  /** MacBinary bytes (rsrc + RSED) on success, undefined on failure. */
  macBinary?: Uint8Array;
  /** Just the resource fork — already MacBinary-stripped — on success. */
  resourceFork?: Uint8Array;
  /** Parsed diagnostics from Rez stderr. Empty array on a clean compile. */
  diagnostics: Diagnostic[];
  /** Verbatim stderr text. Useful in the debug panel; the editor markers
   *  themselves use `diagnostics`. */
  rawStderr: string;
  /** Wall time of the WASM call alone, milliseconds. */
  durationMs: number;
}

/**
 * Compile already-preprocessed `.r` source. Caller must have run
 * preprocessor.ts over the user's input first; what we hand WASM is the
 * flattened, comment-stripped, macro-expanded text.
 *
 * `topName` is the virtual filename Rez will report in its diagnostics
 * — keep it matching what the user sees in the editor (e.g. `reader.r`).
 */
export async function compile(
  baseUrl: string,
  source: string,
  topName: string,
): Promise<CompileResult> {
  const Module = await loadModule(baseUrl);
  stderrBuffer = "";

  // Clean the FS slate. unlink throws on missing files; wrap to ignore.
  for (const p of ["/in.r", "/out.bin"]) {
    try {
      Module.FS.unlink(p);
    } catch {
      /* file didn't exist */
    }
  }
  Module.FS.writeFile("/in.r", source);

  const t0 = performance.now();
  let rc: number;
  try {
    rc = Module.callMain(["/in.r", "-o", "/out.bin"]);
  } catch (e) {
    const t1 = performance.now();
    return {
      ok: false,
      diagnostics: [
        {
          file: topName,
          line: 1,
          column: 1,
          message: `WASM-Rez threw: ${(e as Error).message}`,
          severity: "error",
        },
      ],
      rawStderr: stderrBuffer,
      durationMs: t1 - t0,
    };
  }
  const t1 = performance.now();

  const diagnostics = parseRezStderr(stderrBuffer, topName);

  if (rc !== 0) {
    if (diagnostics.length === 0) {
      diagnostics.push({
        file: topName,
        line: 1,
        column: 1,
        message: `Rez exited with rc=${rc} but emitted no parseable diagnostics`,
        severity: "error",
      });
    }
    return {
      ok: false,
      diagnostics,
      rawStderr: stderrBuffer,
      durationMs: t1 - t0,
    };
  }

  let macBinary: Uint8Array;
  try {
    macBinary = Module.FS.readFile("/out.bin");
  } catch {
    return {
      ok: false,
      diagnostics: [
        {
          file: topName,
          line: 1,
          column: 1,
          message: "Rez returned 0 but produced no output file",
          severity: "error",
        },
      ],
      rawStderr: stderrBuffer,
      durationMs: t1 - t0,
    };
  }
  return {
    ok: true,
    macBinary,
    resourceFork: extractResourceFork(macBinary),
    diagnostics,
    rawStderr: stderrBuffer,
    durationMs: t1 - t0,
  };
}

/**
 * Strip the 128-byte MacBinary header + data-fork padding off `bytes`,
 * returning just the resource fork. Mirrors the spike's
 * `extractRsrcFork` in demo/index.html. Rez always writes a single-fork
 * MacBinary with type 'rsrc' and creator 'RSED'; the data fork length
 * is normally zero. We pad-align to 128-byte boundaries the way
 * MacBinary requires.
 */
export function extractResourceFork(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 128) return new Uint8Array();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataLen = dv.getUint32(83, false); // big-endian, offset 83
  const rsrcLen = dv.getUint32(87, false);
  const pad = (n: number) => ((n + 127) >> 7) << 7;
  const dataStart = 128;
  const rsrcStart = dataStart + pad(dataLen);
  return bytes.slice(rsrcStart, rsrcStart + rsrcLen);
}

/**
 * Parse Rez's stderr into structured diagnostics. The native Rez (and our
 * mini variant) emits lines like:
 *   `<file>:<line>:<col>: error: <msg>`
 *   `<file>:<line>: error: <msg>`
 *   `error: <msg>`            (no source position; we still capture)
 *
 * Anything else is dropped from the structured list (still kept in
 * rawStderr). This is intentionally lossy — the editor's lint markers
 * need positions, and lines without them aren't useful as markers.
 */
function parseRezStderr(stderr: string, defaultFile: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of stderr.split(/\r\n|\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // file:line:col: severity: msg
    let m = line.match(
      /^([^:]+):(\d+):(\d+):\s*(error|warning):\s*(.*)$/,
    );
    if (m) {
      out.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        column: parseInt(m[3]!, 10),
        severity: m[4]! as "error" | "warning",
        message: m[5]!,
      });
      continue;
    }
    // file:line: severity: msg
    m = line.match(/^([^:]+):(\d+):\s*(error|warning):\s*(.*)$/);
    if (m) {
      out.push({
        file: m[1]!,
        line: parseInt(m[2]!, 10),
        column: 1,
        severity: m[3]! as "error" | "warning",
        message: m[4]!,
      });
      continue;
    }
    // severity: msg (no position)
    m = line.match(/^(error|warning):\s*(.*)$/);
    if (m) {
      out.push({
        file: defaultFile,
        line: 1,
        column: 1,
        severity: m[1]! as "error" | "warning",
        message: m[2]!,
      });
      continue;
    }
    // Other lines (e.g. "rez: errors reported, no output written") are
    // dropped from the structured list. They show up in rawStderr.
  }
  return out;
}
