/**
 * floppy-icon.ts — a custom 32×32 floppy-disk icon for the hot-loaded
 * volume (cv-mac #244).
 *
 * Classic Mac volumes get a custom Finder icon by:
 *   1. Adding an invisible file named `Icon\r` (with literal 0x0d CR
 *      suffix — the canonical convention; same byte sequence we hit
 *      when removing the Aladdin folder in #243) at the volume root.
 *   2. Putting an `ICN#` resource (32×32 1-bit icon + 32×32 1-bit
 *      mask) at the conventional ID -16455 in that file's resource
 *      fork.
 *   3. Flipping the **HasCustomIcon** bit (frFlags bit 10, mask
 *      0x0400) in the volume root's DInfo.
 *
 * The Finder picks up the icon and uses it for the volume on the
 * desktop. This module owns the bitmap + the resource-fork bytes;
 * the actual injection (filename, root-flag flip) happens in
 * hfs-patcher.ts.
 *
 * Icon design: a classic Mac 3.5" floppy disk silhouette — rectangular
 * body, metal shutter at the top with the small notch, paper label
 * area in the lower two-thirds with one ruled line. Drawn 1-bit at
 * 32×32 to read crisply at the size the Finder shows volumes.
 */

// ── Icon bitmap (32×32, 1-bit) ─────────────────────────────────────
//
// Each row is 32 bits = 4 bytes. Row 0 is the top of the icon.
// `#` = black ink, `.` = transparent. The mask below is the same
// silhouette filled solid for click-detection: clicks anywhere in
// the body register on the icon, not just on inked pixels.

// Body geometry: cols 2-29 (28 wide), rows 3-30 (28 tall). Border
// runs single-# at the outermost row/col of that rectangle. Shutter
// (top half) and paper label (bottom half) drawn inside.
const FLOPPY_ROWS: readonly string[] = [
  // 0         1         2         3
  // 0123456789012345678901234567890123
  "................................", //  0
  "................................", //  1
  "................................", //  2
  "..############################..", //  3 — body top edge
  "..#..........................#..", //  4
  "..#.....###############......#..", //  5 — shutter top
  "..#.....#.............#......#..", //  6 — shutter sides
  "..#.....#.....###.....#......#..", //  7 — shutter notch
  "..#.....#.............#......#..", //  8 — shutter sides
  "..#.....###############......#..", //  9 — shutter bottom
  "..#..........................#..", // 10
  "..#..........................#..", // 11
  "..#...####################...#..", // 12 — label top
  "..#...#..................#...#..", // 13
  "..#...#..................#...#..", // 14
  "..#...#..................#...#..", // 15
  "..#...#..................#...#..", // 16
  "..#...####################...#..", // 17 — separator within label
  "..#...#..................#...#..", // 18
  "..#...#..................#...#..", // 19
  "..#...#..................#...#..", // 20
  "..#...#..................#...#..", // 21
  "..#...#..................#...#..", // 22
  "..#...#..................#...#..", // 23
  "..#...#..................#...#..", // 24
  "..#...#..................#...#..", // 25
  "..#...#..................#...#..", // 26
  "..#...#..................#...#..", // 27
  "..#...####################...#..", // 28 — label bottom
  "..#..........................#..", // 29
  "..############################..", // 30 — body bottom edge
  "................................", // 31
];

const MASK_ROWS: readonly string[] = [
  // The mask is the SILHOUETTE — every pixel of the icon's shape is 1,
  // so clicks anywhere inside the floppy body register on the icon
  // (not just on the inked pixels). Outside the body (corners + any
  // surrounding transparent area) is 0.
  "................................", //  0
  "................................", //  1
  "................................", //  2
  "..############################..", //  3
  "..############################..", //  4
  "..############################..", //  5
  "..############################..", //  6
  "..############################..", //  7
  "..############################..", //  8
  "..############################..", //  9
  "..############################..", // 10
  "..############################..", // 11
  "..############################..", // 12
  "..############################..", // 13
  "..############################..", // 14
  "..############################..", // 15
  "..############################..", // 16
  "..############################..", // 17
  "..############################..", // 18
  "..############################..", // 19
  "..############################..", // 20
  "..############################..", // 21
  "..############################..", // 22
  "..############################..", // 23
  "..############################..", // 24
  "..############################..", // 25
  "..############################..", // 26
  "..############################..", // 27
  "..############################..", // 28
  "..############################..", // 29
  "..############################..", // 30
  "................................", // 31
];

/** Pack a 32-row × 32-col ASCII bitmap into the 128-byte HFS bitmap
 *  format (32 rows × 4 bytes, big-endian rows). Each `#` becomes a 1
 *  bit; any other character becomes 0. Validates 32 rows × 32 chars. */
function packBitmap(rows: readonly string[]): Uint8Array {
  if (rows.length !== 32) {
    throw new Error(`icon bitmap must have 32 rows; got ${rows.length}`);
  }
  const out = new Uint8Array(128);
  for (let y = 0; y < 32; y++) {
    const row = rows[y]!;
    if (row.length !== 32) {
      throw new Error(`row ${y} must be 32 chars; got ${row.length}`);
    }
    for (let x = 0; x < 32; x++) {
      if (row[x] === "#") {
        const byteOff = y * 4 + (x >> 3);
        const bit = 7 - (x & 7);
        out[byteOff] |= 1 << bit;
      }
    }
  }
  return out;
}

// ── ICN# resource: 128 bytes icon + 128 bytes mask = 256 bytes total ─

const ICON_BITMAP = packBitmap(FLOPPY_ROWS);
const MASK_BITMAP = packBitmap(MASK_ROWS);

/** The full ICN# resource body (256 bytes): icon followed by mask. */
const ICN_HASH: Uint8Array = new Uint8Array(256);
ICN_HASH.set(ICON_BITMAP, 0);
ICN_HASH.set(MASK_BITMAP, 128);

// ── Resource fork encoder ──────────────────────────────────────────
//
// HFS resource-fork layout (Inside Macintosh: More Macintosh Toolbox,
// chapter 1, figure 1-13):
//
//   ┌────────────────────────────────┐
//   │ Resource header (16 bytes)     │  offsets in big-endian u32:
//   │   dataOffset                   │    0x0000  → typically 0x100
//   │   mapOffset                    │    0x0004  → after data section
//   │   dataLength                   │    0x0008
//   │   mapLength                    │    0x000c
//   ├────────────────────────────────┤
//   │ System data (112 bytes, zeros) │  0x010–0x07f
//   │ Application data (128 bytes,   │  0x080–0xff (zeros for us)
//   │  zeros)                        │
//   ├────────────────────────────────┤  ← dataOffset = 0x100
//   │ Resource data:                 │
//   │   for each resource:           │
//   │     u32 length                 │
//   │     <length> bytes of data     │
//   ├────────────────────────────────┤  ← mapOffset
//   │ Resource map:                  │
//   │   bytes 0-15:  copy of header  │
//   │   bytes 16-23: reserved (zero) │
//   │   bytes 24-25: file attributes │  (zero)
//   │   bytes 26-27: typeListOffset  │  (from map start; = 28)
//   │   bytes 28-29: nameListOffset  │  (from map start)
//   │   typeList:                    │
//   │     u16 (numTypes - 1)         │
//   │     for each type:             │
//   │       u32 typeCode             │
//   │       u16 (numRefs - 1)        │
//   │       u16 refListOffset (from  │
//   │           typeList start = 28) │
//   │   refList:                     │
//   │     for each ref:              │
//   │       u16 resID (signed)       │
//   │       u16 nameOffset (-1 = no) │
//   │       u8  attributes           │
//   │       u24 dataOffset (from     │
//   │           data section start)  │
//   │       u32 reserved             │
//   │   nameList: (none for us)      │
//   └────────────────────────────────┘
//
// For ONE resource (ICN# id=-16455, no name), the map is:
//   header copy (16) + reserved (8) + typeListOff (2) + nameListOff (2)
//   + typeList (2 numTypes + 8 per type = 10)
//   + refList (12 per ref = 12)
//   = 50 bytes total. typeListOffset = 28, nameListOffset = 50 (= end,
//   no names).
//
// Data section: u32 length (4) + 256 ICN# bytes = 260 bytes.
//
// Full file: 0x100 (header + reserved) + 260 (data) + 50 (map) = 666 bytes.

/**
 * Build the resource-fork bytes for a single ICN# resource at ID -16455
 * (the conventional "custom icon for this file/folder" ID).
 */
export function buildIconResourceFork(): Uint8Array {
  const ICN_TYPE = 0x49434e23; // 'ICN#'
  const ICON_ID = -16455;
  const RESOURCE_BODY = ICN_HASH;
  const dataOffset = 0x100;
  // Data section: just one resource, prefixed by its u32 length.
  const dataSectionLen = 4 + RESOURCE_BODY.length; // 4 + 256 = 260
  const mapOffset = dataOffset + dataSectionLen; // 0x100 + 260 = 0x204
  // Map: header copy (16) + 8 reserved + 2 attrs + 2 typeListOff +
  //      2 nameListOff + 2 typeListNumMinus1 + 8 per type + 12 per ref
  // = 16 + 8 + 2 + 2 + 2 + 2 + 8 + 12 = 52 bytes? Let me recount per
  // the layout above:
  //   16 (header copy) + 4 (next-map reserved) + 2 (file-ref reserved)
  //   + 2 (file attributes)
  //   = 24 bytes of map preamble. Then:
  //   2 (typeListOff) + 2 (nameListOff) = 28 bytes through nameListOff.
  //   typeList starts at offset 28 from map start.
  //     2 (numTypes - 1) + 8 (one type entry) = 10 bytes typeList.
  //   refList for ICN# starts at offset 28 + 2 + 8 = 38.
  //     12 (one ref entry) = 12 bytes refList.
  //   nameList starts at offset 38 + 12 = 50 (and is empty).
  // Total map size = 50 bytes.
  const mapSize = 50;
  const fileSize = mapOffset + mapSize;

  const out = new Uint8Array(fileSize);
  const dv = new DataView(out.buffer);

  // ── Resource header ──
  dv.setUint32(0, dataOffset, false);
  dv.setUint32(4, mapOffset, false);
  dv.setUint32(8, dataSectionLen, false);
  dv.setUint32(12, mapSize, false);
  // bytes 16..0xff zero — system + app data unused.

  // ── Data section: u32 length + ICN# body ──
  dv.setUint32(dataOffset, RESOURCE_BODY.length, false);
  out.set(RESOURCE_BODY, dataOffset + 4);

  // ── Resource map ──
  let p = mapOffset;
  // 16-byte header copy
  for (let i = 0; i < 16; i++) out[p + i] = out[i];
  p += 16;
  // 4 bytes nextResourceMap (reserved)
  p += 4;
  // 2 bytes fileRef (reserved)
  p += 2;
  // 2 bytes file attributes (zero)
  p += 2;
  // 2 bytes typeListOffset (from map start) = 28
  dv.setUint16(p, 28, false);
  p += 2;
  // 2 bytes nameListOffset (from map start) = 50 (after the refList)
  dv.setUint16(p, 50, false);
  p += 2;
  // typeList: 2 bytes (numTypes - 1)
  dv.setUint16(p, 0, false); // 1 type → 0
  p += 2;
  // Type entry: u32 typeCode + u16 (numRefs-1) + u16 refListOffset
  //   refListOffset is FROM TYPE LIST START (= map offset 28)
  //   typeList header (numTypes-1) = 2 bytes; type entry follows at +2.
  //   After this 8-byte type entry, refList starts at offset 10 from
  //   typeList start → that's offset 28+10 = 38 from map start.
  //   But the refListOffset field is FROM TYPE LIST START → 10.
  dv.setUint32(p, ICN_TYPE, false);
  p += 4;
  dv.setUint16(p, 0, false); // 1 ref → 0
  p += 2;
  dv.setUint16(p, 10, false); // refListOffset from typeList start
  p += 2;
  // refList entry (12 bytes):
  //   u16 resID (signed)
  //   u16 nameOffset (-1 = no name)
  //   u8  attributes
  //   u24 dataOffset (from data-section start; we wrote at offset 0)
  //   u32 reserved (handle)
  dv.setInt16(p, ICON_ID, false);
  p += 2;
  dv.setInt16(p, -1, false); // 0xffff = no name
  p += 2;
  out[p++] = 0; // attributes
  // u24 dataOffset = 0 (first resource in data section)
  out[p++] = 0;
  out[p++] = 0;
  out[p++] = 0;
  // u32 reserved
  p += 4;
  // nameList: empty.

  return out;
}

/** Conventional resource ID for "this file's custom icon" — the
 *  Finder checks `ICN#`, `icl4`, `icl8` at this ID on files/folders
 *  that have the HasCustomIcon flag set. */
export const CUSTOM_ICON_RESOURCE_ID = -16455;
