#!/usr/bin/env node
/*
 * stress-wasm-rez.mjs — feed a large .r file through the vendored
 * wasm-rez and report timing + outcome. One-off experiment for
 * issue #280 (asset-handling architecture): does WASM-Rez handle
 * the upstream Glypha III resource fork (2.7 MB) without OOM?
 * If yes → #280 gap #1 is "wire it up." If no → we need a
 * separate fork-extraction path.
 *
 * Usage:
 *   node scripts/stress-wasm-rez.mjs <path-to-input.r>
 *
 * What we measure:
 *   - Wall-clock from input write → output read
 *   - cc-trapped (out-of-bounds) vs clean failure vs success
 *   - Output size if successful
 *   - Heap residency at peak if available
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO = resolve(__dirname, "..");
const REZ_DIR = resolve(REPO, "src/web/public/wasm-rez");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("usage: node scripts/stress-wasm-rez.mjs <path-to-input.r>");
  process.exit(2);
}

const inputBytes = readFileSync(inputPath);
console.log(`[stress] input: ${inputPath}`);
console.log(`[stress]   size: ${inputBytes.length} bytes (${(inputBytes.length / 1024).toFixed(1)} KB)`);

// wasm-rez.js is an Emscripten-emitted CJS-style bundle with a
// top-level `var createRezModule = ...`. To load it from a Node ESM
// script, we read it as text and execute via `new Function`, which
// runs in global scope so all Node built-ins (TextDecoder, fetch,
// WebAssembly, ...) are available without sandbox plumbing.
const require = createRequire(import.meta.url);

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

console.log(`[stress] instantiating wasm-rez module...`);
const t0 = performance.now();
const stderr = [];
const Module = await createRezModule({
  noInitialRun: true,
  print: (s) => stderr.push(s),
  printErr: (s) => stderr.push(s),
  locateFile: (p) => {
    // The Emscripten glue's hardcoded wasm name is `mini-rez.wasm`;
    // we vendored under `wasm-rez.wasm`. Mirror the rename the
    // browser-side rez.ts does (cf. comments around its locateFile).
    if (p === "mini-rez.wasm") return join(REZ_DIR, "wasm-rez.wasm");
    return join(REZ_DIR, p);
  },
});
console.log(`[stress] module ready (${(performance.now() - t0).toFixed(0)}ms)`);

// Mount RIncludes from the vendored folder (the in-browser pipeline
// uses a fetch-based vfs; in Node we read files directly from disk
// and seed the MEMFS).
const RINC_DIR = join(REZ_DIR, "RIncludes");
const fs = require("node:fs");
try { Module.FS.mkdir("/RIncludes"); } catch { /* exists */ }
let rincludeCount = 0;
for (const name of fs.readdirSync(RINC_DIR)) {
  if (!/\.r$/i.test(name)) continue;
  const bytes = readFileSync(join(RINC_DIR, name));
  Module.FS.writeFile(`/RIncludes/${name}`, bytes);
  rincludeCount++;
}
console.log(`[stress] mounted ${rincludeCount} RIncludes`);

Module.FS.writeFile("/in.r", inputBytes);
console.log(`[stress] wrote /in.r (${inputBytes.length} bytes)`);

const tCompile0 = performance.now();
let rc;
try {
  rc = Module.callMain([
    "-I", "/RIncludes",
    "-o", "/out.rsrc.bin",
    "/in.r",
  ]);
} catch (e) {
  const msg = e?.message ?? String(e);
  const trap = /out of bounds|unreachable|memory access/.test(msg) ? "TRAP" : "EXC";
  console.error(`[stress] callMain threw ${trap}: ${msg.slice(0, 200)}`);
  console.error(`[stress] stderr captured (${stderr.length} lines):`);
  for (const line of stderr.slice(-20)) console.error(`  ${line}`);
  console.error(`[stress] outcome: FAIL (${trap})`);
  process.exit(1);
}
const compileMs = performance.now() - tCompile0;
console.log(`[stress] callMain exited rc=${rc} in ${compileMs.toFixed(0)}ms (${(compileMs / 1000).toFixed(2)}s)`);

if (rc !== 0) {
  console.error(`[stress] stderr (last 30 lines):`);
  for (const line of stderr.slice(-30)) console.error(`  ${line}`);
  console.error(`[stress] outcome: FAIL (rc=${rc})`);
  process.exit(1);
}

try {
  const outBytes = Module.FS.readFile("/out.rsrc.bin");
  console.log(`[stress] output: ${outBytes.length} bytes (${(outBytes.length / 1024).toFixed(1)} KB)`);
  const outPath = "/tmp/stress-wasm-rez-output.rsrc.bin";
  writeFileSync(outPath, outBytes);
  console.log(`[stress] wrote ${outPath}`);
  console.log(`[stress] outcome: SUCCESS`);
} catch (e) {
  console.error(`[stress] callMain rc=0 but couldn't read /out.rsrc.bin: ${e?.message}`);
  console.error(`[stress] outcome: FAIL (no output)`);
  process.exit(1);
}
