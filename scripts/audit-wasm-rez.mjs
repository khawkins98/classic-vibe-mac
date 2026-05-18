#!/usr/bin/env node
/*
 * audit-wasm-rez.mjs — run every sample's .r file through wasm-rez and
 * report pass/fail. The audit-wasm-samples.mjs script covers the .c
 * side; this is the .r side companion.
 *
 * Run BEFORE pushing changes to a sample's .r — bugs in resource
 * templates (malformed ALRT stage records, undefined enum identifiers,
 * etc) only surface here. The existing CI doesn't run this because
 * wasm-rez crashes are noisy and slow to diagnose in CI; the
 * intent is local-dev-loop signal, not gate-on-PR.
 *
 * Usage:
 *   node scripts/audit-wasm-rez.mjs           # all wasm-* samples
 *   node scripts/audit-wasm-rez.mjs <name>    # one sample
 *
 * Exit codes:
 *   0  every audited sample's .r compiled cleanly
 *   1  ≥1 sample failed
 *   2  toolchain bundle missing / unreadable
 *
 * Implementation note: wasm-rez expects already-preprocessed input
 * (see src/web/src/playground/rez.ts header). The browser pipeline
 * runs preprocessor.ts to inline #includes; here we do the equivalent
 * inline expansion in plain Node so the script has no TS dependency.
 * The expander handles `#include "Filename.r"`, recursion through
 * nested includes, and re-include guards (#ifndef / #define / #endif).
 */
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const APP_DIR = resolve(REPO, "src/app");
const REZ_DIR = resolve(REPO, "src/web/public/wasm-rez");
const RINC_DIR = resolve(REZ_DIR, "RIncludes");

if (!existsSync(join(REZ_DIR, "wasm-rez.js"))) {
  console.error(`error: wasm-rez bundle missing at ${REZ_DIR}.`);
  console.error("       Run scripts/build-wasm-rez.sh first.");
  process.exit(2);
}

const require = createRequire(import.meta.url);

// ── Preprocessor: inline #includes + strip guards ────────────────────
//
// Minimum-viable C-preprocessor subset. Handles:
//   - #include "Filename.r"  → resolves against $RINC_DIR (system) or
//                              the .r file's own directory (project-local)
//   - #ifndef _FOO_ / #define _FOO_ / #endif  → re-include guards
//
// Does NOT handle: #define macros, #if / #elif / #else, computed
// includes. The cv-mac sample .r files don't use any of those.
function preprocess(rPath) {
  const seen = new Set();          // guards we've defined (won't re-include)
  const out = [];

  function readWithIncludes(filePath, includerDir) {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    /** stack of conditional states — true = include, false = skip */
    const cond = [true];
    let activeGuard = null;        // name of guard we're inside, if any

    for (const line of lines) {
      const active = cond.every(Boolean);
      const trimmed = line.trim();

      const ifndefMatch = trimmed.match(/^#ifndef\s+(\w+)/);
      if (ifndefMatch) {
        const name = ifndefMatch[1];
        cond.push(!seen.has(name));
        if (active) activeGuard = name;
        continue;
      }
      const defineMatch = trimmed.match(/^#define\s+(\w+)/);
      if (defineMatch) {
        if (active) seen.add(defineMatch[1]);
        continue;
      }
      if (trimmed.startsWith("#endif")) {
        cond.pop();
        activeGuard = null;
        continue;
      }
      const includeMatch = trimmed.match(/^#include\s+"([^"]+)"/);
      if (includeMatch && active) {
        const inc = includeMatch[1];
        const candidates = [
          join(RINC_DIR, inc),
          join(includerDir, inc),
        ];
        const resolved = candidates.find((p) => existsSync(p));
        if (!resolved) {
          throw new Error(`#include "${inc}" — file not found in RIncludes or ${includerDir}`);
        }
        readWithIncludes(resolved, dirname(resolved));
        continue;
      }

      if (active) out.push(line);
    }
  }

  readWithIncludes(rPath, dirname(rPath));
  return out.join("\n");
}

// ── wasm-rez loader (mirrors scripts/stress-wasm-rez.mjs) ──────────
const rezSource = readFileSync(join(REZ_DIR, "wasm-rez.js"), "utf8");
const loader = new Function(
  "module", "exports", "require", "__dirname", "__filename",
  rezSource + "\nreturn createRezModule;",
);
const moduleStub = { exports: null };
const createRezModule = loader(
  moduleStub,
  moduleStub.exports ?? {},
  require,
  REZ_DIR,
  join(REZ_DIR, "wasm-rez.js"),
);

async function compileR(rPath) {
  let preprocessed;
  try {
    preprocessed = preprocess(rPath);
  } catch (e) {
    return { ok: false, reason: `preprocess: ${e.message}` };
  }

  const stderr = [];
  const Module = await createRezModule({
    noInitialRun: true,
    print: (s) => stderr.push(s),
    printErr: (s) => stderr.push(s),
    locateFile: (p) => {
      if (p === "mini-rez.wasm") return join(REZ_DIR, "wasm-rez.wasm");
      return join(REZ_DIR, p);
    },
  });

  Module.FS.writeFile("/in.r", preprocessed);

  let rc;
  try {
    rc = Module.callMain(["/in.r", "-o", "/out.rsrc.bin"]);
  } catch (e) {
    const msg = e?.message ?? String(e);
    return {
      ok: false,
      reason: `wasm-rez: ${msg.slice(0, 200)}`,
      stderr: stderr.slice(-10),
    };
  }
  if (rc !== 0) {
    return {
      ok: false,
      reason: `wasm-rez exit ${rc}`,
      stderr: stderr.slice(-10),
    };
  }
  let outBytes;
  try {
    outBytes = Module.FS.readFile("/out.rsrc.bin");
  } catch (e) {
    return { ok: false, reason: `read /out.rsrc.bin: ${e?.message}` };
  }
  return { ok: true, binLen: outBytes.length };
}

// ── main ────────────────────────────────────────────────────────────
const filter = process.argv[2];
const samples = readdirSync(APP_DIR)
  .filter((d) => d.startsWith("wasm-") && statSync(join(APP_DIR, d)).isDirectory())
  .filter((d) => !filter || d === filter)
  .sort();

console.log(`[audit-rez] ${samples.length} wasm-* samples; preprocessing + wasm-rez`);
const failures = [];
for (const name of samples) {
  const dir = join(APP_DIR, name);
  const rFiles = readdirSync(dir).filter((f) => /\.r$/i.test(f));
  if (rFiles.length === 0) {
    console.log(`  ·  ${name.padEnd(22)} no .r file — skipped`);
    continue;
  }
  if (rFiles.length > 1) {
    console.log(`  ·  ${name.padEnd(22)} multiple .r files: ${rFiles.join(", ")} — skipping`);
    continue;
  }
  const rPath = join(dir, rFiles[0]);
  const t0 = performance.now();
  const result = await compileR(rPath);
  const dt = Math.round(performance.now() - t0);
  if (result.ok) {
    console.log(`  ✓  ${name.padEnd(22)} ${String(result.binLen).padStart(6)} B  ${dt}ms`);
  } else {
    console.log(`  ✗  ${name.padEnd(22)} ${result.reason}`);
    if (result.stderr?.length) {
      for (const line of result.stderr) console.log(`       ${line}`);
    }
    failures.push({ name, ...result });
  }
}

if (failures.length === 0) {
  console.log(`\n[audit-rez] all ${samples.length - failures.length} samples passed.`);
  process.exit(0);
}
console.log(`\n[audit-rez] ${failures.length} of ${samples.length} samples FAILED.`);
process.exit(1);
