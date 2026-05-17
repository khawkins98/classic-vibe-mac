/**
 * compilePipeline.mjs — shared compile-pipeline runner for both
 * the in-browser Build path (cc1.ts:compileToBin) and the Node-side
 * CI audit (scripts/audit-wasm-samples.mjs).
 *
 * The #267 → #268-#270 refactor chain closed three drift vectors
 * between those two implementations (shared mountSysroot, shared
 * watcher scaffold, shared cc1/as/ld/Elf2Mac argv arrays). This
 * module closes the largest remaining one — the per-stage
 * sequencing itself (cc1 → as → ld → Elf2Mac), the per-source loop,
 * the stderr capture, and the timing instrumentation.
 *
 * Issue #271 tracks the rationale + scope.
 *
 * ## Separation of concerns
 *
 * The runner owns ONLY the orchestration: stage ordering, source
 * iteration, raw stderr capture, per-stage wall-clock timing. It
 * does NOT own:
 *
 *   - **Tool loading** — Caller-supplied via `deps.loadCc1/As/Ld/Elf2Mac`.
 *     Browser side returns the existing module-cached loaders;
 *     Node side dynamic-imports from disk. The runner just
 *     calls these factories.
 *
 *   - **Diagnostic parsing** — Returns the raw per-stage stderr.
 *     The browser wrapper turns it into structured `Diagnostic[]`
 *     for clickable Output-panel rows; the audit wrapper greps it
 *     for the first error line. Same data, different consumers.
 *
 *   - **Result shaping** — Returns a uniform `PipelineResult`.
 *     Wrappers project it into their own richer shapes (the
 *     browser adds SIZE-resource splice + sha hash + cache key;
 *     audit only needs `ok` + `binLen`).
 *
 *   - **Caching** — Lives in the browser wrapper. The audit
 *     re-compiles every sample on every CI run by design.
 *
 * Plain `.mjs` (no TS) so both Node and Vite import it without
 * extra build steps. A sibling `.d.mts` provides type hints for
 * the TS side.
 */

import {
  cc1Args,
  asArgs,
  ldArgs,
  elf2macArgs,
} from "./compileArgs.mjs";

/**
 * Sanitize a relative source filename into a MEMFS-safe segment.
 * Mirrors the browser-side rule (cc1.ts:safeRelativePath) so both
 * runtimes lay sources out under /tmp/ with the same names. Returns
 * `null` on un-sanitisable input (absolute path, .. escape, etc.).
 *
 * Allowed segment chars: A-Z a-z 0-9 . _ -. Anything else becomes `_`.
 * Empty / absolute / dot-segment paths reject.
 */
function safeRelativePath(rel) {
  if (!rel || rel.startsWith("/")) return null;
  const parts = rel.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const cleaned = [];
  for (const part of parts) {
    if (part === "." || part === "..") return null;
    const s = part.replace(/[^A-Za-z0-9._-]/g, "_");
    if (!s) return null;
    cleaned.push(s);
  }
  return cleaned.join("/");
}

/** mkdir -p inside MEMFS, caching the set of dirs we've already made
 *  so re-calls don't throw-and-catch dozens of times. */
function mkdirP(Module, absPath, madeDirs) {
  const parts = absPath.split("/").filter((p) => p.length > 0);
  let path = "";
  for (let i = 0; i < parts.length - 1; i++) {
    path += "/" + parts[i];
    if (madeDirs.has(path)) continue;
    try { Module.FS.mkdir(path); } catch { /* race with sibling mkdir, harmless */ }
    madeDirs.add(path);
  }
}

/** Drain a Tool's stderr buffer, returning the joined string (and
 *  clearing for the next call). Convention: tool factories push
 *  per-line strings into `tool.stderr` via `print` + `printErr`
 *  callbacks. */
function drainStderr(tool) {
  const joined = tool.stderr.join("\n");
  tool.stderr.length = 0;
  return joined;
}

/** Call Module.callMain, mapping ExitStatus → rc and wasm-trap → rc=2
 *  with the trap message pushed onto stderr. Matches the existing
 *  browser/audit conventions so wrappers don't have to translate.
 *
 *  The wasm-trap branch (most common: cc1 hitting its 1 GB memory
 *  ceiling under -Os/-O2 on a large source) gets a richer message
 *  including the "Try -O0" hint — useful for the browser playground
 *  user and harmless in the audit's error report. */
function callMainSafe(tool, argv) {
  try {
    return tool.Module.callMain(argv);
  } catch (e) {
    if (e?.name === "ExitStatus") return e.status ?? 1;
    const msg = e?.message ?? String(e);
    if (e?.name === "RuntimeError" || /out of bounds|unreachable/.test(msg)) {
      tool.stderr.push(
        `wasm trap: ${msg || "memory access out of bounds"}. ` +
          `Often caused by cc1 hitting its memory ceiling under -Os/-O2 on a large source. ` +
          `Try -O0 in the Optimize dropdown.`,
      );
      return 2;
    }
    tool.stderr.push(`wasm trap: ${msg}`);
    return 2;
  }
}

/**
 * Run the full cc1 → as → ld → Elf2Mac pipeline over a set of source
 * files. Returns a uniform PipelineResult; wrappers shape their own
 * richer output around it.
 *
 * @param {Object} input
 * @param {Array<{filename: string, content: string|Uint8Array}>} input.sources
 *        All source files (.c, .h, …) for this compile. Header files
 *        are co-mounted alongside .c files so quoted #include works.
 *        At least one .c source is required.
 * @param {string} [input.primaryName]
 *        Filename to attribute pipeline-level failures to (e.g. ld
 *        errors). Defaults to the first .c source.
 * @param {"O0"|"Os"|"O2"} [input.optLevel="O0"]
 *        cc1 optimization flag.
 * @param {Object} deps
 * @param {() => Promise<{Module, stderr: string[]}>} deps.loadCc1
 *        Factory: returns a fresh cc1 Module with the headers sysroot
 *        mounted at /sysroot. Caller decides how to load (dynamic
 *        import from URL in browser, from disk in Node).
 * @param {() => Promise<{Module, stderr: string[]}>} deps.loadAs
 *        Factory for as (no sysroot mount needed).
 * @param {() => Promise<{Module, stderr: string[]}>} deps.loadLd
 *        Factory for ld with the libs sysroot mounted.
 * @param {() => Promise<{Module, stderr: string[]}>} deps.loadElf2Mac
 *        Factory for Elf2Mac (no sysroot mount needed).
 *
 * @returns {Promise<PipelineResult>} See typedef below.
 *
 * @typedef {Object} PipelineResult
 * @property {boolean} ok
 *           True iff every stage exited rc=0 and a MacBinary was
 *           written. On false, `failedStage` and `failedFile`
 *           identify where.
 * @property {Uint8Array} [bin]
 *           The final MacBinary II bytes. Present only when ok=true.
 * @property {string} [asm]
 *           The .s text from the FIRST .c source compiled. Useful
 *           for the Show ASM viewer; audit ignores it.
 * @property {{cc1Ms: number, asMs: number, ldMs: number, elf2macMs: number}} stages
 *           Per-stage cumulative wall time (cc1 + as sum across all
 *           .c sources; ld + elf2mac are single calls).
 * @property {string[]} stderrPerStage
 *           Raw stderr captured per stage call, in invocation order.
 *           Each entry is prefixed with `[stage filename?]` so the
 *           browser wrapper can split for per-file diagnostics; the
 *           audit wrapper greps the whole blob.
 * @property {"cc1"|"as"|"ld"|"elf2mac"} [failedStage]
 *           Which stage exited non-zero. Present only when ok=false.
 * @property {string} [failedFile]
 *           For cc1/as failures: which .c source caused it. For
 *           ld/elf2mac (which run once over all objects): undefined.
 */
export async function runCompilePipeline({ sources, primaryName, optLevel = "O0" }, deps) {
  const cSources = sources.filter((s) => /\.c$/i.test(s.filename));
  if (cSources.length === 0) {
    return {
      ok: false,
      stages: { cc1Ms: 0, asMs: 0, ldMs: 0, elf2macMs: 0 },
      stderrPerStage: [],
      failedStage: "cc1",
      failedFile: primaryName ?? "(no source)",
    };
  }

  const stages = { cc1Ms: 0, asMs: 0, ldMs: 0, elf2macMs: 0 };
  const stderrPerStage = [];
  /** @type {Array<{name: string, bytes: Uint8Array}>} */
  const objects = [];
  /** @type {string | undefined} */
  let asmText;

  // ── Stage 1+2: per-.c source, compile then assemble ─────────────
  // Each stage gets a fresh Module instance — cc1/as/ld/Elf2Mac are
  // not re-entrant (LEARNINGS "cc1.wasm is not re-entrant"). The
  // expensive parts (wasm bytes, sysroot index) are cached inside
  // the deps' loader closures so per-source re-instantiation is
  // ~100-300ms per tool, not the full cold-start cost.
  for (const c of cSources) {
    const safe = safeRelativePath(c.filename) ?? "in.c";
    const baseNoExt = safe.replace(/\.c$/i, "");

    // ── cc1 → .s
    const cc1 = await deps.loadCc1();
    const tmpDirs = new Set(["/tmp"]);
    // Co-mount every source (.c + .h siblings) so quoted #include
    // resolves relative to the source dir.
    for (const s of sources) {
      const sSafe = safeRelativePath(s.filename);
      if (!sSafe) continue;
      const path = `/tmp/${sSafe}`;
      mkdirP(cc1.Module, path, tmpDirs);
      cc1.Module.FS.writeFile(path, s.content);
    }
    const cc1In = `/tmp/${safe}`;
    const cc1Out = `/tmp/${baseNoExt}.s`;
    const cc1Start = nowMs();
    const cc1Rc = callMainSafe(cc1, cc1Args({ source: cc1In, output: cc1Out, optLevel }));
    stages.cc1Ms += nowMs() - cc1Start;
    const cc1Err = drainStderr(cc1);
    if (cc1Err) stderrPerStage.push(`[cc1 ${c.filename}]\n${cc1Err}`);
    if (cc1Rc !== 0) {
      return {
        ok: false,
        stages,
        stderrPerStage,
        failedStage: "cc1",
        failedFile: c.filename,
      };
    }
    const sBytes = cc1.Module.FS.readFile(cc1Out);
    if (asmText === undefined) asmText = new TextDecoder().decode(sBytes);

    // ── as → .o
    const as = await deps.loadAs();
    const asIn = `/tmp/${baseNoExt}.s`;
    const asOut = `/tmp/${baseNoExt}.o`;
    as.Module.FS.writeFile(asIn, sBytes);
    const asStart = nowMs();
    const asRc = callMainSafe(as, asArgs({ source: asIn, output: asOut }));
    stages.asMs += nowMs() - asStart;
    const asErr = drainStderr(as);
    if (asErr) stderrPerStage.push(`[as ${c.filename}]\n${asErr}`);
    if (asRc !== 0) {
      return {
        ok: false,
        stages,
        stderrPerStage,
        failedStage: "as",
        failedFile: c.filename,
      };
    }
    objects.push({ name: `${baseNoExt}.o`, bytes: as.Module.FS.readFile(asOut) });
  }

  // ── Stage 3: ld → ELF ────────────────────────────────────────────
  const ld = await deps.loadLd();
  const ldTmpDirs = new Set(["/tmp"]);
  for (const o of objects) {
    const p = `/tmp/${o.name}`;
    mkdirP(ld.Module, p, ldTmpDirs);
    ld.Module.FS.writeFile(p, o.bytes);
  }
  // Defensive: clear any stale /tmp/out.gdb from a prior call. (The
  // Module is fresh, so this is paranoid — but cheap and matches the
  // browser path's original behaviour.)
  try { ld.Module.FS.unlink("/tmp/out.gdb"); } catch { /* not present */ }
  const objPaths = objects.map((o) => `/tmp/${o.name}`);
  const ldStart = nowMs();
  const ldRc = callMainSafe(ld, ldArgs({ objects: objPaths, output: "/tmp/out.gdb" }));
  stages.ldMs = nowMs() - ldStart;
  const ldErr = drainStderr(ld);
  if (ldErr) stderrPerStage.push(`[ld]\n${ldErr}`);
  if (ldRc !== 0) {
    return { ok: false, stages, stderrPerStage, failedStage: "ld" };
  }
  const elfBytes = ld.Module.FS.readFile("/tmp/out.gdb");

  // ── Stage 4: Elf2Mac → MacBinary ─────────────────────────────────
  const e2m = await deps.loadElf2Mac();
  // Elf2Mac wants the ELF at /tmp/out.bin.gdb (sibling of the
  // --elf2mac -o /tmp/out.bin output path).
  e2m.Module.FS.writeFile("/tmp/out.bin.gdb", elfBytes);
  const e2mStart = nowMs();
  const e2mRc = callMainSafe(e2m, elf2macArgs({ output: "/tmp/out.bin" }));
  stages.elf2macMs = nowMs() - e2mStart;
  const e2mErr = drainStderr(e2m);
  if (e2mErr) stderrPerStage.push(`[elf2mac]\n${e2mErr}`);
  if (e2mRc !== 0) {
    return { ok: false, stages, stderrPerStage, failedStage: "elf2mac" };
  }

  let bin;
  try {
    bin = e2m.Module.FS.readFile("/tmp/out.bin");
  } catch (e) {
    stderrPerStage.push(`[elf2mac]\nfailed to read /tmp/out.bin: ${e?.message ?? e}`);
    return { ok: false, stages, stderrPerStage, failedStage: "elf2mac" };
  }

  return {
    ok: true,
    bin,
    asm: asmText,
    stages,
    stderrPerStage,
  };
}

/** Wall-clock now in ms. `performance.now()` works in both modern
 *  Node and browsers; fall back to Date.now() for any environment
 *  where it isn't available. */
function nowMs() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
