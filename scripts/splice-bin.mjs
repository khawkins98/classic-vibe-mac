#!/usr/bin/env node
/*
 * splice-bin.mjs — offline reproducer of the browser-side splice that
 * combines a `.code.bin` (cc1 → as → ld → elf2mac output) with a
 * `.rsrc.bin` (wasm-rez output) into a final MacBinary II APPL.
 *
 * Mirrors what `src/web/src/playground/build.ts::spliceResourceFork`
 * does inside the playground, but runs in plain Node so you can
 * inspect the merged fork without spinning up a browser.
 *
 * Why this exists at all: when a vendored Mac app fails silently in
 * the playground, the first question is "did my resources actually
 * end up in the final .bin?" The browser pipeline answers that lazily
 * (you'd download the .bin, run the extractor, eyeball the output);
 * this script collapses that into one command, so you can rule the
 * splice/build path in or out as the cause in seconds rather than
 * minutes. cv-mac #256 used a one-off version of this script to
 * confirm Glypha's 17 snd resources DID survive splice — narrowing
 * the bug to heap exhaustion rather than a missing-resource issue.
 *
 * Usage:
 *   node scripts/splice-bin.mjs <code.bin> <rsrc.bin> <output.bin>
 *
 *   # then inspect:
 *   node scripts/extract-resource-fork.mjs --info <output.bin>
 *
 * Conflict resolution matches the browser:
 *   "user-wins" on (type, id) collision — `rsrc.bin`'s resources
 *   override the `.code.bin`'s where they overlap. This is how Rez's
 *   --copy semantics work, and what the user expects when they edit
 *   a sample's .r and rebuild.
 *
 * Caveats:
 *   - Does NOT recompute the MacBinary CRC. Doesn't matter for
 *     extract-resource-fork.mjs or for any tool that just reads the
 *     resource fork. BasiliskII / real Mac OS may complain — for that
 *     use the browser path.
 *   - Uses `resourceForkMerger.mjs`'s "first-fork wins" merger called
 *     with `[user, code]` to get "user wins" semantics. Stays in
 *     lockstep with the browser merger automatically.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeResourceFork,
  encodeResourceFork,
  mergeResourceForks,
} from "../src/web/src/playground/resourceForkMerger.mjs";

const HEADER_SIZE = 128;
const padBytes = (n) => Math.ceil(n / 128) * 128;

function extractRsrcFork(binPath) {
  const bin = readFileSync(binPath);
  if (bin.length < HEADER_SIZE) {
    throw new Error(`${binPath}: too small for a MacBinary header (${bin.length}B)`);
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const dataLen = dv.getUint32(83, false);
  const rsrcLen = dv.getUint32(87, false);
  const rsrcStart = HEADER_SIZE + padBytes(dataLen);
  return {
    bin,
    header: bin.subarray(0, HEADER_SIZE),
    dataLen,
    dataFork: bin.subarray(HEADER_SIZE, HEADER_SIZE + dataLen),
    rsrcFork: bin.subarray(rsrcStart, rsrcStart + rsrcLen),
  };
}

const [codePath, rsrcPath, outPath] = process.argv.slice(2);
if (!codePath || !rsrcPath || !outPath) {
  console.error("usage: node scripts/splice-bin.mjs <code.bin> <rsrc.bin> <output.bin>");
  process.exit(2);
}

const code = extractRsrcFork(resolve(codePath));
const rsrc = extractRsrcFork(resolve(rsrcPath));

console.log(`[splice]    code: data=${code.dataLen}B rsrc=${code.rsrcFork.length}B`);
console.log(`[splice]    rsrc: data=${rsrc.dataLen}B rsrc=${rsrc.rsrcFork.length}B`);

// "first-fork wins" called with [user, code] = user wins on collisions,
// matching the browser's spliceResourceFork semantics.
const merged = mergeResourceForks([rsrc.rsrcFork, code.rsrcFork]);
console.log(`[splice]  merged: rsrc=${merged.length}B`);

// Compose output: code's header (with patched rsrc length) + code's data
// fork + merged resource fork. Padding per MacBinary convention.
const outDataPad = padBytes(code.dataLen);
const outRsrcPad = padBytes(merged.length);
const out = new Uint8Array(HEADER_SIZE + outDataPad + outRsrcPad);
out.set(code.header, 0);
if (code.dataLen > 0) out.set(code.dataFork, HEADER_SIZE);
out.set(merged, HEADER_SIZE + outDataPad);

// Patch rsrc-length in the cloned header so downstream tools see the
// new size. (CRC not recomputed — see header comment.)
const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);
outDv.setUint32(87, merged.length, false);

writeFileSync(outPath, out);
console.log(`[splice]  wrote ${outPath} (${out.length}B)`);

// Helpful follow-up the reader will want next 90% of the time.
const here = dirname(fileURLToPath(import.meta.url));
console.log(`\n[splice]  inspect: node ${here}/extract-resource-fork.mjs --info ${outPath}`);
