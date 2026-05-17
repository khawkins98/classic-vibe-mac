#!/usr/bin/env node
// One-off: compile wasm-debug-console (smallest sample with a non-trivial
// resource fork: signature data + SIZE), capture the MacBinary output,
// and run the extractor on it. Verifies the extract pipeline against
// real wasm-cc1 / wasm-rez output.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCompilePipeline } from "../src/web/src/playground/compilePipeline.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const BUNDLE_DIR = resolve(REPO, "src/web/public/wasm-cc1");
const APP_DIR = resolve(REPO, "src/app/wasm-debug-console");

// Replica of the audit script's loadTool, just enough to drive the pipeline.
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
  if (mount) {
    // Reproduce just the headers/libs mount we need.
    const blobName = mount === "headers" ? "sysroot.bin" : "sysroot-libs.bin";
    const idxName = mount === "headers" ? "sysroot.index.json" : "sysroot-libs.index.json";
    const blob = readFileSync(join(BUNDLE_DIR, blobName));
    const index = JSON.parse(readFileSync(join(BUNDLE_DIR, idxName), "utf8"));
    try { Module.FS.mkdir("/sysroot"); } catch {}
    const made = new Set(["/sysroot"]);
    for (const entry of index) {
      const full = "/sysroot/" + entry.p;
      const parts = full.split("/").filter(Boolean);
      parts.pop();
      let cur = "";
      for (const p of parts) {
        cur += "/" + p;
        if (made.has(cur)) continue;
        try { Module.FS.mkdir(cur); } catch {}
        made.add(cur);
      }
      Module.FS.writeFile(full, blob.subarray(entry.o, entry.o + entry.l));
    }
    // cvm_log.h system header
    if (mount === "headers") {
      try { Module.FS.mkdir("/sysroot/include"); } catch {}
      const cvmLog = readFileSync(join(APP_DIR, "cvm_log.h"));
      Module.FS.writeFile("/sysroot/include/cvm_log.h", cvmLog);
    }
  }
  return { Module, stderr };
}

const sources = readdirSync(APP_DIR)
  .filter((f) => /\.(c|h)$/i.test(f))
  .map((filename) => ({
    filename,
    content: readFileSync(join(APP_DIR, filename), "utf8"),
  }));

console.log(`compiling ${sources.filter((s) => /\.c$/i.test(s.filename)).length} .c file(s)...`);
const r = await runCompilePipeline(
  { sources, optLevel: "O0" },
  {
    loadCc1: () => loadTool("cc1.mjs", "headers"),
    loadAs: () => loadTool("as.mjs", null),
    loadLd: () => loadTool("ld.mjs", "libs"),
    loadElf2Mac: () => loadTool("Elf2Mac.mjs", null),
  },
);

if (!r.ok) {
  console.error(`compile failed at ${r.failedStage} (${r.failedFile})`);
  console.error(r.stderrPerStage.join("\n"));
  process.exit(1);
}

console.log(`compile ok: ${r.bin.length} bytes; stages cc1=${r.stages.cc1Ms.toFixed(0)}ms as=${r.stages.asMs.toFixed(0)}ms ld=${r.stages.ldMs.toFixed(0)}ms e2m=${r.stages.elf2macMs.toFixed(0)}ms`);

const outPath = "/tmp/debug-console.bin";
writeFileSync(outPath, r.bin);
console.log(`wrote ${outPath}`);
console.log(`\nrun: node scripts/extract-resource-fork.mjs ${outPath}`);
