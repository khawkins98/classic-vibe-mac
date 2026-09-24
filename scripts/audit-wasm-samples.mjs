#!/usr/bin/env node
/*
 * audit-wasm-samples.mjs — compile every wasm-* sample under src/app/
 * via the vendored wasm-cc1 toolchain, report pass/fail per sample.
 *
 * Intended for CI: catches the failure mode that's bitten us
 * repeatedly — a sample becomes uncompilable (often without anyone
 * noticing because the toolchain runs in the browser, not in CI)
 * and the Build button starts erroring on that project. The pre-#173
 * audit caught three such regressions (wasm-calculator's comment
 * bug, wasm-scrollwin's Controls.h dependency, wasm-dialog's
 * legacy API names). Running this script in CI on every PR catches
 * them at PR-review time rather than at "user clicks Build".
 *
 * Mirrors wasm-retro-cc/scripts/compile-c-cli.mjs but:
 *   - walks every src/app/wasm-* directory
 *   - reads the vendored bundle from src/web/public/wasm-cc1/
 *   - handles multi-file projects (cc1 over each .c, ld over the
 *     resulting .o files)
 *   - prints a one-line per-sample summary + final pass/fail tally
 *
 * Out of scope: the .r resource fork — that's audit-wasm-rez.mjs's
 * companion job. For a combined .c + .r run see audit-wasm-e2e.mjs.
 *
 * Usage:
 *   node scripts/audit-wasm-samples.mjs           # all wasm-* samples
 *   node scripts/audit-wasm-samples.mjs <name>    # one sample
 *
 * Exit codes:
 *   0  every audited sample compiled
 *   1  ≥1 sample failed (failures printed at end), or two
 *      SAMPLE_PROJECTS share an appCreator code
 *   2  toolchain bundle missing / unreadable
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompilePipeline } from "../src/web/src/playground/compilePipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const APP_DIR = resolve(REPO, "src/app");
const BUNDLE_DIR = resolve(REPO, "src/web/public/wasm-cc1");

// ── creator-code uniqueness guard ───────────────────────────────────
// Two SAMPLE_PROJECTS sharing an `appCreator` makes the Finder mis-
// associate documents and icons (the Desktop DB keys on creator). Parse
// types.ts textually: each `id: "..."` is paired with the next
// `appCreator: "...."` before the following `id:`. "????" (no creator)
// is exempt. Runs before compiling so it's cheap and fails fast.
{
  const typesPath = resolve(REPO, "src/web/src/playground/types.ts");
  const src = readFileSync(typesPath, "utf8");
  const re = /\bid:\s*["']([^"']+)["']|\bappCreator:\s*["']([^"']*)["']/g;
  const byCreator = new Map();
  let currentId = null;
  let pairs = 0;
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) {
      currentId = m[1];
      continue;
    }
    const creator = m[2];
    if (currentId === null) continue;
    pairs++;
    if (creator.length !== 4) {
      console.error(`error: ${currentId} appCreator "${creator}" is not 4 chars.`);
      process.exit(1);
    }
    if (creator !== "????") {
      if (!byCreator.has(creator)) byCreator.set(creator, []);
      byCreator.get(creator).push(currentId);
    }
    currentId = null;
  }
  if (pairs === 0) {
    console.error(`error: found no id/appCreator pairs in ${typesPath}; parser out of date?`);
    process.exit(1);
  }
  const dups = [...byCreator].filter(([, ids]) => ids.length > 1);
  if (dups.length > 0) {
    console.error("error: duplicate appCreator codes in SAMPLE_PROJECTS:");
    for (const [c, ids] of dups) console.error(`       '${c}': ${ids.join(", ")}`);
    process.exit(1);
  }
  console.log(`[audit] ${pairs} appCreator codes checked, all unique.`);
}

if (!existsSync(join(BUNDLE_DIR, "cc1.mjs"))) {
  console.error(`error: bundle missing at ${BUNDLE_DIR}.`);
  console.error(
    "       Run `node scripts/vendor-wasm-cc1.mjs` (or rebuild via " +
      "wasm-retro-cc + vendor) before auditing.",
  );
  process.exit(2);
}

// ── sysroot blob loader ─────────────────────────────────────────────
const blobCache = new Map();
function loadSysrootBlob(binName, indexName) {
  if (blobCache.has(binName)) return blobCache.get(binName);
  const blob = readFileSync(join(BUNDLE_DIR, binName));
  const index = JSON.parse(readFileSync(join(BUNDLE_DIR, indexName), "utf8"));
  const out = {
    blob: new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength),
    index,
  };
  blobCache.set(binName, out);
  return out;
}

function mkdirPInMem(Module, fullPath, made) {
  const parts = fullPath.split("/").filter(Boolean);
  parts.pop();
  let cur = "";
  for (const p of parts) {
    cur += "/" + p;
    if (made.has(cur)) continue;
    try { Module.FS.mkdir(cur); } catch {}
    made.add(cur);
  }
}

// cv-mac system headers — mirrors src/web/src/playground/cc1.ts
// CVM_SYSTEM_HEADERS. Keep in sync. To add a header: append here
// AND in the runtime list at the top of cc1.ts.
const CVM_SYSTEM_HEADERS = [
  {
    path: "/sysroot/include/cvm_log.h",
    sourcePath: join(APP_DIR, "wasm-debug-console", "cvm_log.h"),
  },
];

async function mountSysroot(Module, which) {
  const { blob, index } =
    which === "headers"
      ? loadSysrootBlob("sysroot.bin", "sysroot.index.json")
      : loadSysrootBlob("sysroot-libs.bin", "sysroot-libs.index.json");
  try { Module.FS.mkdir("/sysroot"); } catch {}
  const made = new Set(["/sysroot"]);
  for (const entry of index) {
    const full = "/sysroot/" + entry.p;
    mkdirPInMem(Module, full, made);
    Module.FS.writeFile(full, blob.subarray(entry.o, entry.o + entry.l));
  }
  if (which === "headers") {
    for (const { path, sourcePath } of CVM_SYSTEM_HEADERS) {
      mkdirPInMem(Module, path, made);
      Module.FS.writeFile(path, readFileSync(sourcePath));
    }
  }
}

async function loadTool(mjsName, mount) {
  const factoryMod = await import(join(BUNDLE_DIR, mjsName));
  const factory = factoryMod.default;
  const stderr = [];
  const Module = await factory({
    noInitialRun: true,
    print: (s) => stderr.push(s),
    printErr: (s) => stderr.push(s),
    locateFile: (path) => join(BUNDLE_DIR, path),
  });
  if (mount) await mountSysroot(Module, mount);
  return { Module, stderr };
}

// ── compile a single project ────────────────────────────────────────
//
// Delegates the cc1 → as → ld → Elf2Mac sequence to the shared
// `runCompilePipeline` so the audit and the in-browser Build path
// stay structurally identical (cv-mac #271). We only own:
//   - reading the project's source files off disk
//   - the audit-flavoured `{ ok, binLen, stage, file, reason }` shape
//     (the pipeline returns `{ ok, bin, failedStage, failedFile,
//     stderrPerStage, ...}` — we project that into our shape so
//     existing audit output stays unchanged).
async function compileProject(projectDir) {
  const files = readdirSync(projectDir).filter((f) => statSync(join(projectDir, f)).isFile());
  const cSources = files.filter((f) => /\.c$/i.test(f));
  if (cSources.length === 0) {
    return { ok: false, reason: "no .c file in directory" };
  }
  const allSourceFiles = files.filter((f) => /\.(c|h)$/i.test(f));
  const sources = allSourceFiles.map((filename) => ({
    filename,
    content: readFileSync(join(projectDir, filename), "utf8"),
  }));

  const result = await runCompilePipeline(
    { sources, optLevel: "O0" },
    {
      loadCc1:     () => loadTool("cc1.mjs", "headers"),
      loadAs:      () => loadTool("as.mjs", null),
      loadLd:      () => loadTool("ld.mjs", "libs"),
      loadElf2Mac: () => loadTool("Elf2Mac.mjs", null),
    },
  );

  if (!result.ok) {
    // Map the pipeline's `stderrPerStage` back to the first error
    // line (audit's existing one-liner format). The last entry in
    // stderrPerStage corresponds to the failing stage; older entries
    // are stages that succeeded but emitted warnings.
    const failedStderr = result.stderrPerStage[result.stderrPerStage.length - 1] ?? "";
    const lines = failedStderr.split("\n");
    const errLine =
      lines.find((l) => /error/i.test(l)) ??
      lines[1] ??  // [0] is the "[stage filename]" prefix
      `compilation failed at ${result.failedStage}`;
    return {
      ok: false,
      stage: result.failedStage === "elf2mac" ? "Elf2Mac" : result.failedStage,
      file: result.failedFile,
      reason: errLine,
    };
  }
  return { ok: true, binLen: result.bin.length };
}

// ── main: walk every wasm-* directory (or just the one named on the CLI) ──
const filter = process.argv[2];
const samples = readdirSync(APP_DIR)
  .filter((d) => d.startsWith("wasm-") && statSync(join(APP_DIR, d)).isDirectory())
  .filter((d) => !filter || d === filter)
  .sort();

console.log(`[audit] ${samples.length} wasm-* samples under ${APP_DIR}`);
const failures = [];
for (const name of samples) {
  const t0 = performance.now();
  let result;
  try {
    result = await compileProject(join(APP_DIR, name));
  } catch (e) {
    result = { ok: false, reason: `host error: ${e?.message ?? e}` };
  }
  const dt = Math.round(performance.now() - t0);
  if (result.ok) {
    console.log(`  ✓  ${name.padEnd(22)} ${String(result.binLen).padStart(6)} B  ${dt}ms`);
  } else {
    const where = result.stage ? `[${result.stage}${result.file ? " " + result.file : ""}] ` : "";
    console.log(`  ✗  ${name.padEnd(22)} ${where}${result.reason || ""}`);
    failures.push({ name, ...result });
  }
}

console.log("");
if (failures.length === 0) {
  console.log(`[audit] all ${samples.length} samples compiled.`);
  process.exit(0);
}
console.log(`[audit] ${failures.length}/${samples.length} samples FAILED:`);
for (const f of failures) {
  const where = f.stage ? `[${f.stage}${f.file ? " " + f.file : ""}] ` : "";
  console.log(`         ${f.name}: ${where}${f.reason}`);
}
process.exit(1);
