#!/usr/bin/env node
/*
 * build-icon-gallery-rsrc.mjs — generate the wasm-icon-gallery
 * binary resource file (cv-mac #233 ★★★★★+ tier demo).
 *
 * Output: src/app/wasm-icon-gallery/icons.rsrc.bin
 *
 * Contains 6 ICN# resources (32×32 1-bit icon + 32×32 1-bit mask)
 * at IDs 128–133 — heart, star, diamond, circle, triangle, square.
 * The app opens this file via `OpenResFile("Icons")` at startup
 * and draws each icon in a 3×2 grid using `PlotIconHandle`.
 *
 * This is the first consumer of the splice infrastructure landed
 * in #251 (ExtraFile.resourceFork). Run this script once at repo-
 * editing time; the .bin gets committed alongside the .c/.r source.
 * The Vite plugin (vite.config.ts) copies it to
 * public/sample-projects/wasm-icon-gallery/, the build pipeline
 * reads it and passes through patchEmptyVolumeWithBinary's
 * extraFiles with the resourceFork field populated.
 *
 * Encoding format mirrors `floppy-icon.ts:buildIconResourceFork`
 * but extended for a multi-resource fork: one type ('ICN#'), six
 * resources at sequential IDs, no names.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "..", "src/app/wasm-icon-gallery/icons.rsrc.bin");

// ── Icon designs (32×32 ASCII grids, # = inked, . = transparent) ───
//
// Each icon is the silhouette of a recognisable shape. Mask is the
// silhouette filled solid so clicks anywhere in the bounding shape
// register on the icon — same convention as floppy-icon.ts.

const ICONS = {
  heart: [
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    ".....######.........######......",
    "....##########...##########.....",
    "...############.############....",
    "..##############################",
    "..##############################",
    "..##############################",
    "..##############################",
    "..##############################",
    "...############################.",
    "....##########################..",
    ".....########################...",
    "......######################....",
    ".......####################.....",
    "........##################......",
    ".........################.......",
    "..........##############........",
    "...........############.........",
    "............##########..........",
    ".............########...........",
    "..............######............",
    "...............####.............",
    "................##..............",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
  ],
  star: [
    "................................",
    "................................",
    "................................",
    "...............##...............",
    "...............##...............",
    "..............####..............",
    "..............####..............",
    ".............######.............",
    ".............######.............",
    "............########............",
    "............########............",
    "#####################...........",
    "########################........",
    "..#######################.......",
    "....######################......",
    "......####################......",
    ".......##################.......",
    "........################........",
    ".........##############.........",
    ".........##############.........",
    "........###############.........",
    ".......##################.......",
    "......####################......",
    "....######################......",
    "..######...##########...######..",
    "###..........######..........###",
    "..............####..............",
    "..............##................",
    "................................",
    "................................",
    "................................",
    "................................",
  ],
  diamond: [
    "................................",
    "................................",
    "...............##...............",
    "..............####..............",
    ".............######.............",
    "............########............",
    "...........##########...........",
    "..........############..........",
    ".........##############.........",
    "........################........",
    ".......##################.......",
    "......####################......",
    ".....######################.....",
    "....########################....",
    "...##########################...",
    "..############################..",
    "..############################..",
    "...##########################...",
    "....########################....",
    ".....######################.....",
    "......####################......",
    ".......##################.......",
    "........################........",
    ".........##############.........",
    "..........############..........",
    "...........##########...........",
    "............########............",
    ".............######.............",
    "..............####..............",
    "...............##...............",
    "................................",
    "................................",
  ],
  circle: [
    "................................",
    "................................",
    "..........##########............",
    ".......################.........",
    ".....####################.......",
    "....######################......",
    "...########################.....",
    "..##########################....",
    ".############################...",
    ".############################...",
    ".##############################.",
    ".##############################.",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    "################################",
    ".##############################.",
    ".##############################.",
    ".############################...",
    ".############################...",
    "..##########################....",
    "...########################.....",
    "....######################......",
    ".....####################.......",
    ".......################.........",
    "..........##########............",
    "................................",
    "................................",
  ],
  triangle: [
    "................................",
    "................................",
    "................................",
    "................................",
    "...............##...............",
    "..............####..............",
    "..............####..............",
    ".............######.............",
    ".............######.............",
    "............########............",
    "............########............",
    "...........##########...........",
    "...........##########...........",
    "..........############..........",
    "..........############..........",
    ".........##############.........",
    ".........##############.........",
    "........################........",
    "........################........",
    ".......##################.......",
    ".......##################.......",
    "......####################......",
    "......####################......",
    ".....######################.....",
    ".....######################.....",
    "....########################....",
    "....########################....",
    "...##########################...",
    "...##########################...",
    "..############################..",
    "................................",
    "................................",
  ],
  square: [
    "................................",
    "................................",
    "..############################..",
    "..############################..",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..##########################.##.",
    "..############################..",
    "................................",
    "................................",
    "................................",
  ],
};

// ── ICN# packer: 32×32 bitmap (ASCII rows) → 128 bytes ─────────────

function packBitmap(rows) {
  if (rows.length !== 32) throw new Error(`bitmap needs 32 rows, got ${rows.length}`);
  const out = new Uint8Array(128);
  for (let y = 0; y < 32; y++) {
    const row = rows[y];
    if (row.length !== 32) throw new Error(`row ${y} length ${row.length}, want 32`);
    for (let x = 0; x < 32; x++) {
      if (row[x] === "#") {
        out[y * 4 + (x >> 3)] |= 1 << (7 - (x & 7));
      }
    }
  }
  return out;
}

// Mask = silhouette: filled in every cell that is `#` in the icon
// OR in any pixel of the icon's bounding rect. For these designs
// where the icon is convex, the mask = icon works fine. For more
// complex (non-convex) icons you'd compute an actual silhouette;
// for our gallery the simpler approach reads correctly.

function buildIcnHash(rows) {
  const icon = packBitmap(rows);
  const out = new Uint8Array(256);
  out.set(icon, 0);
  // Mask = icon for these convex designs (every inked pixel is
  // part of the hit area). PlotIconHandle uses the mask for
  // background erasure when drawing; matching the icon means the
  // erase region equals the draw region.
  out.set(icon, 128);
  return out;
}

// ── Multi-resource fork encoder ────────────────────────────────────
//
// Same layout as floppy-icon.ts:buildIconResourceFork but for N
// resources at sequential IDs starting from BASE_ID. The map's
// reference list grows by 12 bytes per resource; the data section
// grows by (4 + 256) bytes per resource.
//
// Layout reminder:
//   bytes 0..15    resource header (dataOffset, mapOffset, dataLen, mapLen)
//   bytes 16..0xff system + app data (zero)
//   bytes 0x100..  resource data section (per resource: u32 length + body)
//   bytes mapOff.. resource map (header copy + reserved + attrs +
//                  typeListOff + nameListOff + type list + ref list)

const ICN_TYPE = 0x49434e23; // 'ICN#'
const BASE_ID = 128;

const order = ["heart", "star", "diamond", "circle", "triangle", "square"];
const bodies = order.map((name) => buildIcnHash(ICONS[name]));
const N = bodies.length;

const dataOffset = 0x100;
const dataSectionLen = bodies.reduce((sum, b) => sum + 4 + b.length, 0);
const mapOffset = dataOffset + dataSectionLen;

// Map layout (offsets are FROM map start):
//   0..15  header copy
//   16..19 nextResourceMap (reserved)
//   20..21 fileRef (reserved)
//   22..23 file attributes
//   24..25 typeListOffset    (from map start; = 28)
//   26..27 nameListOffset    (from map start; = end of refList)
//   28..29 numTypes - 1
//   30..37 type entry (typeCode u32 + (numRefs-1) u16 + refListOff u16)
//   38..   ref list: 12 bytes per ref (resID + nameOff(-1) + attrs +
//          dataOff (3 bytes from data-section start) + reserved u32)
const typeListOff = 28;
const refListOff = 38; // = 28 + 2 (numTypes) + 8 (one type entry)
const refListLen = N * 12;
const nameListOff = refListOff + refListLen;
const mapSize = nameListOff; // no names, so nameList is empty

const fileSize = mapOffset + mapSize;
const out = new Uint8Array(fileSize);
const dv = new DataView(out.buffer);

// Resource header
dv.setUint32(0, dataOffset, false);
dv.setUint32(4, mapOffset, false);
dv.setUint32(8, dataSectionLen, false);
dv.setUint32(12, mapSize, false);

// Resource data section + ref-list dataOffsets
const refDataOffsets = [];
let p = dataOffset;
for (const body of bodies) {
  refDataOffsets.push(p - dataOffset); // ref's u24 dataOffset from data-section start
  dv.setUint32(p, body.length, false);
  p += 4;
  out.set(body, p);
  p += body.length;
}

// Map header copy
for (let i = 0; i < 16; i++) out[mapOffset + i] = out[i];

// nextResourceMap + fileRef + attrs already zero (16..23 in the map).
dv.setUint16(mapOffset + 24, typeListOff, false);
dv.setUint16(mapOffset + 26, nameListOff, false);
dv.setUint16(mapOffset + 28, 0, false); // numTypes - 1 → 1 type → 0

// Type entry @ map+30
dv.setUint32(mapOffset + 30, ICN_TYPE, false);
dv.setUint16(mapOffset + 34, N - 1, false); // numRefs - 1
dv.setUint16(mapOffset + 36, refListOff - typeListOff, false); // refListOff from typeList start (= 10)

// Ref list @ map+38
let r = mapOffset + refListOff;
for (let i = 0; i < N; i++) {
  dv.setInt16(r, BASE_ID + i, false);
  r += 2;
  dv.setInt16(r, -1, false); // nameOffset = -1 (no name)
  r += 2;
  out[r++] = 0; // attributes
  // u24 dataOffset
  const off = refDataOffsets[i];
  out[r++] = (off >> 16) & 0xff;
  out[r++] = (off >> 8) & 0xff;
  out[r++] = off & 0xff;
  // u32 reserved
  r += 4;
}

writeFileSync(OUT, out);
console.log(`wrote ${OUT} (${out.length} bytes, ${N} ICN# resources at IDs ${BASE_ID}-${BASE_ID + N - 1})`);
