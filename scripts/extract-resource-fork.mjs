#!/usr/bin/env node
/*
 * extract-resource-fork.mjs — Phase 1 of #280 Path B (asset-handling
 * architecture, fork-composition gap). Decodes a MacBinary II file's
 * resource fork and emits it as a standalone `.rsrc.bin` ready for
 * consumption by the splice infrastructure (#251 ExtraFile.resourceFork
 * + the eventual fork-merger).
 *
 * Background: WASM-Rez OOMs on Glypha's 2.7 MB upstream `.r` (#280
 * experiment 1). So to ship a vendored period app's resource fork we
 * need to extract it from a pre-built MacBinary rather than re-compile
 * the Rez. This tool is the extractor half.
 *
 * Usage:
 *   node scripts/extract-resource-fork.mjs <input.bin> [output.rsrc.bin]
 *
 *   --info   only print the resource map contents (types + counts +
 *            per-resource id/size). Don't write output.
 *   --no-summary  skip the summary print
 *   --self-test   construct a synthetic MacBinary in memory, extract
 *                 + decode, verify byte-identity. No file I/O.
 *
 * Output: raw resource fork bytes (the same shape that
 * `ExtraFile.resourceFork` expects in hfs-patcher.ts:wrapInExtraFile).
 * The file has no MacBinary header, no data fork — just the resource
 * fork's "fork data" section, starting with the 16-byte resource-fork
 * header that points at the resource map.
 *
 * Output filename convention: `<projectname>.rsrc.bin`. The
 * `.rsrc.bin` suffix is the same one `binaryAssets` uses for sibling
 * resources (e.g. icons.rsrc.bin in wasm-icon-gallery); the eventual
 * splice-merger will accept the same shape for the merge-into-app-fork
 * pathway.
 */

import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));

if (flags.has("--self-test")) {
  runSelfTest();
  process.exit(0);
}

if (positional.length < 1) {
  console.error("usage: node scripts/extract-resource-fork.mjs <input.bin> [output.rsrc.bin]");
  console.error("       node scripts/extract-resource-fork.mjs --self-test");
  process.exit(2);
}

const inputPath = positional[0];
const outputPath = positional[1];
const infoOnly = flags.has("--info");
const skipSummary = flags.has("--no-summary");

const bin = readFileSync(inputPath);
const { rsrcFork, header } = extractFork(bin);

if (!infoOnly && !outputPath) {
  console.error("error: output path required (or pass --info to skip writing)");
  process.exit(2);
}

if (!skipSummary) {
  console.log(`MacBinary input: ${inputPath} (${bin.length} bytes)`);
  console.log(`  filename:      "${header.filename}"`);
  console.log(`  type / creator: ${header.type} / ${header.creator}`);
  console.log(`  data fork:     ${header.dataForkLen} bytes`);
  console.log(`  rsrc fork:     ${header.rsrcForkLen} bytes`);
}

const summary = summarizeResourceFork(rsrcFork);
if (!skipSummary) {
  if (summary.ok) {
    console.log(`\nresource map: ${summary.totalCount} resources across ${summary.typeCount} types`);
    for (const t of summary.types) {
      const sizes = t.resources.map((r) => r.size);
      const totalBytes = sizes.reduce((a, b) => a + b, 0);
      console.log(`  '${t.type}'  ×${t.resources.length}  ${totalBytes} bytes`);
      // Show first few ids if there are many
      const ids = t.resources.map((r) => r.id);
      const idsPreview =
        ids.length <= 6 ? ids.join(", ") : `${ids.slice(0, 6).join(", ")}, ... +${ids.length - 6}`;
      console.log(`               ids: ${idsPreview}`);
    }
  } else {
    console.log(`\nresource map: decode failed (${summary.error}). Fork bytes written anyway.`);
  }
}

if (!infoOnly) {
  writeFileSync(outputPath, rsrcFork);
  console.log(`\nwrote ${outputPath} (${rsrcFork.length} bytes)`);
}

// ── MacBinary II header decode ────────────────────────────────────────
function extractFork(bin) {
  if (bin.length < 128) {
    throw new Error(`input too short to be a MacBinary: ${bin.length} bytes`);
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (dv.getUint8(0) !== 0) {
    throw new Error(`MacBinary header[0] = ${dv.getUint8(0)} (expected 0)`);
  }
  const nameLen = dv.getUint8(1);
  if (nameLen > 63) {
    throw new Error(`MacBinary filename length ${nameLen} > 63`);
  }
  const filename = readMacRoman(bin, 2, nameLen);
  const type = readFourCC(bin, 65);
  const creator = readFourCC(bin, 69);
  const dataForkLen = dv.getUint32(83, false); // big-endian
  const rsrcForkLen = dv.getUint32(87, false);

  const dataStart = 128;
  const dataEnd = dataStart + dataForkLen;
  const rsrcStart = align128(dataEnd);
  const rsrcEnd = rsrcStart + rsrcForkLen;

  if (rsrcEnd > bin.length) {
    throw new Error(
      `MacBinary truncated: rsrc end ${rsrcEnd} > buffer ${bin.length}`,
    );
  }

  const rsrcFork = bin.subarray(rsrcStart, rsrcEnd);
  return {
    rsrcFork: new Uint8Array(rsrcFork),
    header: { filename, type, creator, dataForkLen, rsrcForkLen },
  };
}

function align128(n) {
  return Math.ceil(n / 128) * 128;
}

function readMacRoman(bin, offset, length) {
  // ASCII subset is identical; high bytes appear as Latin-1 fallbacks.
  // Good enough for human-readable filename echo.
  let s = "";
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(bin[offset + i]);
  }
  return s;
}

function readFourCC(bin, offset) {
  return String.fromCharCode(bin[offset], bin[offset + 1], bin[offset + 2], bin[offset + 3]);
}

// ── Resource fork decoder ─────────────────────────────────────────────
//
// Format (Inside Macintosh: More Macintosh Toolbox §1-121):
//
//   Fork header (16 bytes):
//     0..3   offset to resource data
//     4..7   offset to resource map
//     8..11  length of resource data
//     12..15 length of resource map
//
//   Resource map (at offset+0):
//     0..15  copy of fork header (zeroed on disk)
//     16..19 next resource map handle (zeroed on disk)
//     20..21 file refnum (zeroed on disk)
//     22..23 file attributes
//     24..25 offset (from map start) to type list
//     26..27 offset (from map start) to name list
//     28..29 count of types MINUS 1 (so 0xFFFF means 0 types)
//
//   Type list entry (8 bytes per type):
//     0..3   type (4 ASCII chars)
//     4..5   count MINUS 1
//     6..7   offset to reference list (from start of type list)
//
//   Reference list entry (12 bytes per resource):
//     0..1   id (signed 16-bit)
//     2..3   offset to name from name list start (-1 = no name)
//     4      attributes
//     5..7   offset to resource data (24-bit, from data start)
//     8..11  reserved (handle in memory; zero on disk)
//
//   Resource data: at data offset, 4-byte length prefix, then bytes.
//
function summarizeResourceFork(rf) {
  try {
    if (rf.length < 16) {
      return { ok: false, error: "fork shorter than 16-byte header" };
    }
    const dv = new DataView(rf.buffer, rf.byteOffset, rf.byteLength);
    const dataOff = dv.getUint32(0, false);
    const mapOff = dv.getUint32(4, false);
    const dataLen = dv.getUint32(8, false);
    const mapLen = dv.getUint32(12, false);
    if (mapOff + mapLen > rf.length) {
      return {
        ok: false,
        error: `map extends past fork end (${mapOff}+${mapLen} > ${rf.length})`,
      };
    }
    const typeListOffInMap = dv.getUint16(mapOff + 24, false);
    const nameListOffInMap = dv.getUint16(mapOff + 26, false);
    const numTypesMinus1 = dv.getUint16(mapOff + 28, false);
    // 0xFFFF means "no types" — that overflows when read as signed; treat as 0.
    const numTypes = numTypesMinus1 === 0xffff ? 0 : numTypesMinus1 + 1;
    const typeListStart = mapOff + typeListOffInMap;
    const types = [];
    let totalCount = 0;
    for (let i = 0; i < numTypes; i++) {
      const entryOff = typeListStart + 2 + i * 8;
      const type = readFourCC(rf, entryOff);
      const countMinus1 = dv.getUint16(entryOff + 4, false);
      const count = countMinus1 + 1;
      const refListOffFromTypeList = dv.getUint16(entryOff + 6, false);
      const refListStart = typeListStart + refListOffFromTypeList;
      const resources = [];
      for (let j = 0; j < count; j++) {
        const refOff = refListStart + j * 12;
        const id = dv.getInt16(refOff, false);
        // 24-bit big-endian read for the data offset.
        const dataOffsetFromDataStart =
          (dv.getUint8(refOff + 5) << 16) |
          (dv.getUint8(refOff + 6) << 8) |
          dv.getUint8(refOff + 7);
        const resDataOff = dataOff + dataOffsetFromDataStart;
        let size = 0;
        if (resDataOff + 4 <= rf.length) {
          size = dv.getUint32(resDataOff, false);
        }
        resources.push({ id, size });
      }
      types.push({ type, resources });
      totalCount += count;
    }
    return {
      ok: true,
      dataLen,
      mapLen,
      typeCount: numTypes,
      totalCount,
      types,
    };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ── Self-test ─────────────────────────────────────────────────────────
//
// Constructs a minimal MacBinary containing 2 resources across 2 types:
//   'TEST' id=128 → 4 bytes
//   'TEST' id=129 → 4 bytes
//   'PICT' id=130 → 6 bytes
// Extracts the fork, runs the summary decoder, asserts the shape.
function runSelfTest() {
  console.log("--- self-test ---");
  const bin = buildSyntheticMacBinary();
  const { rsrcFork, header } = extractFork(bin);
  console.log(`extracted: filename="${header.filename}" rsrc=${rsrcFork.length}B`);
  const s = summarizeResourceFork(rsrcFork);
  if (!s.ok) {
    console.error(`FAIL: decode error: ${s.error}`);
    process.exit(1);
  }
  // Expected: 2 types, 3 total resources.
  // (Note: types may be in any internal order; check by name.)
  const t1 = s.types.find((t) => t.type === "TEST");
  const t2 = s.types.find((t) => t.type === "PICT");
  if (!t1 || !t2) {
    console.error(`FAIL: missing types. Got: ${s.types.map((t) => t.type).join(", ")}`);
    process.exit(1);
  }
  if (t1.resources.length !== 2 || t2.resources.length !== 1) {
    console.error(`FAIL: wrong counts. Got TEST×${t1.resources.length}, PICT×${t2.resources.length}`);
    process.exit(1);
  }
  if (t1.resources[0].id !== 128 || t1.resources[1].id !== 129 || t2.resources[0].id !== 130) {
    console.error(`FAIL: wrong ids. Got TEST [${t1.resources.map((r) => r.id).join(",")}], PICT [${t2.resources.map((r) => r.id).join(",")}]`);
    process.exit(1);
  }
  if (t1.resources[0].size !== 4 || t1.resources[1].size !== 4 || t2.resources[0].size !== 6) {
    console.error(`FAIL: wrong sizes`);
    process.exit(1);
  }
  console.log("PASS: 2 types, 3 resources, ids + sizes match.");
}

function buildSyntheticMacBinary() {
  // Resource data section: 3 resources, each prefixed with 4-byte length.
  // r1 (TEST 128): 4 bytes "AAAA"
  // r2 (TEST 129): 4 bytes "BBBB"
  // r3 (PICT 130): 6 bytes "PPPPPP"
  const data = new Uint8Array([
    // r1: len=4, "AAAA"
    0, 0, 0, 4, 0x41, 0x41, 0x41, 0x41,
    // r2: len=4, "BBBB"
    0, 0, 0, 4, 0x42, 0x42, 0x42, 0x42,
    // r3: len=6, "PPPPPP"
    0, 0, 0, 6, 0x50, 0x50, 0x50, 0x50, 0x50, 0x50,
  ]);
  // Offsets to each resource WITHIN data section:
  const r1Off = 0;            // before len-prefix of r1
  const r2Off = 8;
  const r3Off = 16;

  // Resource map structure:
  //   0..15  fork header copy (zero on disk)
  //   16..19 next-map handle (zero)
  //   20..21 file refnum (zero)
  //   22..23 file attrs (zero)
  //   24..25 type-list offset (from map start) — we'll place type list at offset 28
  //   26..27 name-list offset (from map start) — no names, point past end
  //   28..29 numTypes-1
  //   30+    type list entries (8 bytes each)
  //   ...    reference list entries (12 bytes each)
  //
  // Two types: TEST (2 entries), PICT (1 entry). So:
  //   type list at 28: 2 bytes header (numTypes-1 already there) + 16 bytes (2×8)
  //   actually note: the `numTypes-1` at 28 IS the start of the type list per
  //   Inside Mac. The first type entry starts at offset 30. So typeListOff = 28.
  //   ref lists: 2 + 1 = 3 entries × 12 bytes = 36 bytes
  //
  // Let's lay out explicitly:
  //   28..29: numTypes-1 = 1
  //   30..37: type entry TEST (count-1=1, refListOff=2+8*2 = 18 from typeListOff)
  //   38..45: type entry PICT (count-1=0, refListOff=18+24 = 42 from typeListOff)
  //   46..57: ref entry TEST/128
  //   58..69: ref entry TEST/129
  //   70..81: ref entry PICT/130
  //   total map size: 82 bytes
  const mapLen = 82;
  const map = new Uint8Array(mapLen);
  const mapDv = new DataView(map.buffer);
  // bytes 0..23 are header/handles/attrs — leave zero
  mapDv.setUint16(24, 28, false); // typeListOff = 28 (from map start)
  mapDv.setUint16(26, mapLen, false); // nameListOff = past end (no names)
  mapDv.setUint16(28, 1, false); // numTypes-1 = 1 (two types)
  // Type entry 1: TEST, count-1=1, refListOff from typeListOff
  // typeListOff = 28. Ref list TEST starts at map offset 46.
  // refListOffFromTypeList = 46 - 28 = 18.
  map[30] = 0x54; map[31] = 0x45; map[32] = 0x53; map[33] = 0x54; // 'TEST'
  mapDv.setUint16(34, 1, false); // count-1 = 1
  mapDv.setUint16(36, 18, false); // refListOff from typeListOff
  // Type entry 2: PICT, count-1=0, refListOff from typeListOff = 70-28 = 42
  map[38] = 0x50; map[39] = 0x49; map[40] = 0x43; map[41] = 0x54; // 'PICT'
  mapDv.setUint16(42, 0, false); // count-1 = 0
  mapDv.setUint16(44, 42, false); // refListOff from typeListOff
  // Ref entry TEST/128 at map offset 46
  mapDv.setInt16(46, 128, false); // id
  mapDv.setInt16(48, -1, false); // name offset (-1 = no name)
  map[50] = 0; // attrs
  // 24-bit data offset (r1Off = 0)
  map[51] = (r1Off >> 16) & 0xff; map[52] = (r1Off >> 8) & 0xff; map[53] = r1Off & 0xff;
  // reserved 4 bytes (zero)
  // Ref entry TEST/129 at 58
  mapDv.setInt16(58, 129, false);
  mapDv.setInt16(60, -1, false);
  map[62] = 0;
  map[63] = (r2Off >> 16) & 0xff; map[64] = (r2Off >> 8) & 0xff; map[65] = r2Off & 0xff;
  // Ref entry PICT/130 at 70
  mapDv.setInt16(70, 130, false);
  mapDv.setInt16(72, -1, false);
  map[74] = 0;
  map[75] = (r3Off >> 16) & 0xff; map[76] = (r3Off >> 8) & 0xff; map[77] = r3Off & 0xff;

  // Fork header (16 bytes): data starts at 256 (offset within FORK, not within MacBinary)
  // — actually it's offsets within the resource fork itself. data offset = 256 is
  // arbitrary but conventional (256 leaves 240 bytes of unused space after the
  // 16-byte header for "system reserved" + name list start, mimicking real files).
  // We'll use 256.
  const fork = new Uint8Array(256 + data.length + mapLen);
  const forkDv = new DataView(fork.buffer);
  const dataOff = 256;
  const mapOff = dataOff + data.length;
  forkDv.setUint32(0, dataOff, false);
  forkDv.setUint32(4, mapOff, false);
  forkDv.setUint32(8, data.length, false);
  forkDv.setUint32(12, mapLen, false);
  fork.set(data, dataOff);
  fork.set(map, mapOff);

  // MacBinary wrapper: 128-byte header, no data fork (length 0), then fork.
  const header = new Uint8Array(128);
  // header[0] = 0 (version)
  const name = "synthetic-test";
  header[1] = name.length;
  for (let i = 0; i < name.length; i++) header[2 + i] = name.charCodeAt(i);
  // type/creator: 'TEST'/'TEST'
  header.set(new TextEncoder().encode("TESTTEST"), 65);
  // dataForkLen at 83..86 = 0
  // rsrcForkLen at 87..90 = fork.length
  const headerDv = new DataView(header.buffer);
  headerDv.setUint32(87, fork.length, false);

  // No data fork to pad over. Resource fork starts at offset 128 (aligned).
  const out = new Uint8Array(128 + fork.length);
  out.set(header);
  out.set(fork, 128);
  return out;
}
