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
 * Out of scope: the .r resource fork. wasm-rez splicing only happens
 * in the browser today; this script verifies the C side links. If
 * the C side compiles, the .r splice is unlikely to be the failure
 * mode (it's been stable since cv-mac #88).
 *
 * Exit codes:
 *   0  every sample compiled
 *   1  ≥1 sample failed (failures printed at end)
 *   2  toolchain bundle missing / unreadable
 */
import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
} from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const APP_DIR = resolve(REPO, "src/app");
const BUNDLE_DIR = resolve(REPO, "src/web/public/wasm-cc1");

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

function callMain(tool, argv) {
  tool.stderr.length = 0;
  try {
    return tool.Module.callMain(argv);
  } catch (e) {
    if (e?.name === "ExitStatus") return e.status ?? 1;
    tool.stderr.push(`wasm trap: ${e?.message ?? e}`);
    return 2;
  }
}

// ── compile a single project (multi-file aware) ─────────────────────
async function compileProject(projectDir) {
  const files = readdirSync(projectDir).filter((f) => statSync(join(projectDir, f)).isFile());
  const cSources = files.filter((f) => /\.c$/i.test(f));
  if (cSources.length === 0) {
    return { ok: false, reason: "no .c file in directory" };
  }
  const allSources = files.filter((f) => /\.(c|h)$/i.test(f));
  const sourceContents = Object.fromEntries(
    allSources.map((f) => [f, readFileSync(join(projectDir, f), "utf8")]),
  );

  const objects = [];

  // Stage 1+2 per .c source
  for (const cFile of cSources) {
    const baseNoExt = basename(cFile, ".c");

    // cc1
    const cc1 = await loadTool("cc1.mjs", "headers");
    for (const [f, content] of Object.entries(sourceContents)) {
      cc1.Module.FS.writeFile(`/tmp/${f}`, content);
    }
    const cc1Rc = callMain(cc1, [
      "-quiet",
      "-isystem", "/sysroot/gcc-include",
      "-isystem", "/sysroot/include",
      "-mcpu=68020",
      "-O0",
      `/tmp/${cFile}`,
      "-o", `/tmp/${baseNoExt}.s`,
    ]);
    if (cc1Rc !== 0) {
      const errLine =
        cc1.stderr.find((l) => /error/i.test(l)) ??
        cc1.stderr[0] ??
        "compilation failed (no error message)";
      return { ok: false, stage: "cc1", file: cFile, reason: errLine };
    }
    const asmBytes = cc1.Module.FS.readFile(`/tmp/${baseNoExt}.s`);

    // as
    const as = await loadTool("as.mjs", null);
    as.Module.FS.writeFile(`/tmp/${baseNoExt}.s`, asmBytes);
    const asRc = callMain(as, [
      "-march=68020",
      `/tmp/${baseNoExt}.s`,
      "-o", `/tmp/${baseNoExt}.o`,
    ]);
    if (asRc !== 0) {
      return {
        ok: false,
        stage: "as",
        file: cFile,
        reason: as.stderr[0] ?? "assembly failed (no error message)",
      };
    }
    objects.push({ name: `${baseNoExt}.o`, bytes: as.Module.FS.readFile(`/tmp/${baseNoExt}.o`) });
  }

  // Stage 3: ld
  const ld = await loadTool("ld.mjs", "libs");
  for (const o of objects) ld.Module.FS.writeFile(`/tmp/${o.name}`, o.bytes);
  const objPaths = objects.map((o) => `/tmp/${o.name}`);
  const ldRc = callMain(ld, [
    "-T", "/sysroot/ld/retro68-multiseg.ld",
    "-L", "/sysroot/lib",
    "--no-warn-rwx-segments",
    "--emit-relocs",
    "-o", "/tmp/out.gdb",
    "/sysroot/lib/start.c.obj",
    ...objPaths,
    "--start-group",
    "/sysroot/lib/libretrocrt.a",
    "/sysroot/lib/libInterface.a",
    "/sysroot/lib/libc.a",
    "/sysroot/lib/libm.a",
    "/sysroot/lib/libgcc.a",
    "--end-group",
  ]);
  if (ldRc !== 0) {
    return { ok: false, stage: "ld", reason: ld.stderr[0] ?? "" };
  }
  const elfBytes = ld.Module.FS.readFile("/tmp/out.gdb");

  // Stage 4: Elf2Mac
  const e2m = await loadTool("Elf2Mac.mjs", null);
  e2m.Module.FS.writeFile("/tmp/out.bin.gdb", elfBytes);
  const e2mRc = callMain(e2m, ["--elf2mac", "-o", "/tmp/out.bin"]);
  if (e2mRc !== 0) {
    return { ok: false, stage: "Elf2Mac", reason: e2m.stderr[0] ?? "" };
  }
  const bin = e2m.Module.FS.readFile("/tmp/out.bin");
  return { ok: true, binLen: bin.length };
}

// ── main: walk every wasm-* directory ───────────────────────────────
const samples = readdirSync(APP_DIR)
  .filter((d) => d.startsWith("wasm-") && statSync(join(APP_DIR, d)).isDirectory())
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
