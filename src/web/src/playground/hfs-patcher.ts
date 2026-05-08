/**
 * hfs-patcher.ts — in-browser HFS volume patcher.
 *
 * Phase 3 hot-load. Inputs: an empty mounted-blessed HFS volume blob
 * (vendored in `public/playground/empty-secondary.dsk`, baked once by
 * hfsutils' `hformat -l Apps`) plus a freshly compiled MacBinary `.bin`
 * from the playground's Build pipeline. Output: a complete HFS disk
 * image with one file at the volume root, ready to be mounted by
 * BasiliskII as a removable secondary disk.
 *
 * Why "patcher" not "encoder"? An honest HFS encoder is 1.5–2.5k lines
 * of B-tree, bitmap, MDB, and extent overflow code. We avoid all of
 * that by starting from a known-good empty volume and inserting one
 * file via three localized edits:
 *
 *   1. Catalog B-tree leaf node 1: append a new file record after the
 *      two existing root-directory records (thread + dir). The leaf is
 *      already half-empty in the baked template (free space starts at
 *      offset 150 of a 512-byte node), and one file record is ~116
 *      bytes — comfortably within budget.
 *   2. Volume bitmap: mark N consecutive allocation blocks used (where
 *      N covers data fork + resource fork of the new file).
 *   3. MDB (and alternate MDB at end-of-volume): decrement drFreeBks,
 *      bump drFilCnt and drNxtCNID, refresh modtime, increment write
 *      counter. The rest of the MDB stays identical.
 *
 * That's it. We do NOT split B-tree nodes, do NOT handle the extent
 * overflow file, do NOT try to insert into the middle of an existing
 * leaf with multiple files. v1 is "one app per disk": each click of
 * Build & Run produces a fresh disk with exactly one file at the root.
 *
 * The empty template encodes the heavy structural decisions for us:
 *   - 1.44 MB volume, 512-byte allocation blocks, 2874 alloc blocks
 *   - drVBMSt=3, drAlBlSt=4, catalog at allocBlock 22 (bytes 0x3400)
 *   - Catalog node size = 512, keyLen=37
 *   - Single leaf node (node 1) with thread record + root-dir record
 *
 * If we ever need to reformat the template (different volume name, size,
 * etc.), `scripts/bake-empty-secondary.sh` rebuilds it via hfsutils.
 *
 * References:
 *   Inside Macintosh: Files (1992), chapter 2 "File Manager".
 *   Apple TN1150 (HFS+, but the HFS sections are still the canonical
 *     reference for HFS).
 *   hfsutils source (libhfs/btree.c, libhfs/data.c) for the encoding
 *     conventions we replicate.
 */

const NODE_SIZE = 512;

/** Byte offsets the patcher cares about inside the template. Captured by
 *  inspecting the baked empty-secondary.dsk; assert in TESTS that they
 *  still hold so a reformat doesn't silently break us. */
export const TEMPLATE_LAYOUT = {
  /** Master Directory Block. */
  mdbOffset: 1024,
  /** Volume bitmap (drVBMSt=3 → 3*512). 1 byte = 8 alloc blocks. */
  bitmapOffset: 3 * 512,
  /** Bytes per allocation block (drAlBlkSiz). */
  allocBlockSize: 512,
  /** First 512-byte block of the allocation area (drAlBlSt). */
  allocStartBlock: 4,
  /** Total allocation blocks on the volume (drNmAlBlks). */
  totalAllocBlocks: 2874,
  /** Catalog B-tree first allocation block (drCTExtRec[0]). */
  catalogFirstAllocBlock: 22,
  /** Catalog B-tree node 1 (the only leaf in the empty volume). */
  catalogLeafNodeIndex: 1,
} as const;

/** Convert an alloc-block index to a byte offset on the disk image. */
function allocBlockToDiskOffset(allocBlock: number): number {
  return (
    TEMPLATE_LAYOUT.allocStartBlock * 512 +
    allocBlock * TEMPLATE_LAYOUT.allocBlockSize
  );
}

/** Pad a byte length up to the next allocation-block boundary. */
function roundUpToAllocBlocks(byteLen: number): number {
  const ab = TEMPLATE_LAYOUT.allocBlockSize;
  return Math.ceil(byteLen / ab) * ab;
}

/** Mac epoch is 1904-01-01 00:00:00 UTC; Unix is 1970-01-01. */
function macEpochSeconds(): number {
  return Math.floor(Date.now() / 1000) + 2082844800;
}

// ── MacBinary header decode ────────────────────────────────────────────

export interface MacBinaryView {
  /** 4-byte type code, e.g. "APPL" → 0x4150504c. */
  type: number;
  /** 4-byte creator code. */
  creator: number;
  /** Internal Mac filename (Pascal string from MacBinary header). */
  filename: string;
  /** Bytes of data fork (unpadded). */
  dataLen: number;
  /** Bytes of resource fork (unpadded). */
  rsrcLen: number;
  /** Slice into the input bytes for the data fork (unpadded). */
  dataFork: Uint8Array;
  /** Slice into the input bytes for the resource fork (unpadded). */
  resourceFork: Uint8Array;
  /** Finder flags from MacBinary header (offset 73, big-endian 16-bit). */
  finderFlags: number;
}

/** Parse the bits of a MacBinary II header we need to plant a file
 *  record. Throws on length / signature mismatches that would obviously
 *  produce a malformed disk. */
export function parseMacBinary(bin: Uint8Array): MacBinaryView {
  if (bin.length < 128) {
    throw new Error(`MacBinary too short: ${bin.length} bytes`);
  }
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  // Old version byte (offset 0) and "version II" zero (offset 74) must be 0.
  if (dv.getUint8(0) !== 0) {
    throw new Error(`MacBinary header[0] = ${dv.getUint8(0)} (expected 0)`);
  }
  const nameLen = dv.getUint8(1);
  if (nameLen > 63) {
    throw new Error(`MacBinary filename length ${nameLen} > 63`);
  }
  const filename = String.fromCharCode(
    ...Array.from(bin.subarray(2, 2 + nameLen)),
  );
  const type = dv.getUint32(65, false);
  const creator = dv.getUint32(69, false);
  const finderFlags = dv.getUint16(73, false);
  const dataLen = dv.getUint32(83, false);
  const rsrcLen = dv.getUint32(87, false);
  const dataStart = 128;
  const dataPad = Math.ceil(dataLen / 128) * 128;
  const rsrcStart = dataStart + dataPad;
  if (rsrcStart + rsrcLen > bin.length) {
    throw new Error(
      `MacBinary truncated: rsrc end ${rsrcStart + rsrcLen} > buffer ${bin.length}`,
    );
  }
  return {
    type,
    creator,
    filename,
    dataLen,
    rsrcLen,
    dataFork: bin.subarray(dataStart, dataStart + dataLen),
    resourceFork: bin.subarray(rsrcStart, rsrcStart + rsrcLen),
    finderFlags,
  };
}

// ── MDB read/update ────────────────────────────────────────────────────

interface MdbView {
  drNmFls: number; // u16, count of files in root
  drNxtCNID: number; // u32, next unused catalog node ID
  drFreeBks: number; // u16, unused alloc blocks
  drFilCnt: number; // u32, file count on volume
  drDirCnt: number; // u32, directory count on volume
  drWrCnt: number; // u32, write counter
}

function readMdb(disk: Uint8Array): MdbView {
  const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);
  const m = TEMPLATE_LAYOUT.mdbOffset;
  return {
    drNmFls: dv.getUint16(m + 12, false),
    drNxtCNID: dv.getUint32(m + 30, false),
    drFreeBks: dv.getUint16(m + 34, false),
    drFilCnt: dv.getUint32(m + 84, false),
    drDirCnt: dv.getUint32(m + 88, false),
    drWrCnt: dv.getUint32(m + 70, false),
  };
}

/** Apply our delta to the MDB. Also bumps drLsMod (offset 6) so the OS
 *  notices the volume has changed. We DO NOT rewrite the entire MDB —
 *  only the fields we touch — to keep the diff minimal and reduce the
 *  chance of breaking some structural invariant we don't know about. */
function patchMdb(
  disk: Uint8Array,
  delta: { addedBlocks: number; addedFiles: number; assignedCNID: number },
): void {
  const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);
  const m = TEMPLATE_LAYOUT.mdbOffset;
  const cur = readMdb(disk);
  const now = macEpochSeconds();
  // drLsMod (last modification, offset 6, 4 bytes)
  dv.setUint32(m + 6, now, false);
  // drNmFls (offset 12) — files in root directory; we add to root.
  dv.setUint16(m + 12, cur.drNmFls + delta.addedFiles, false);
  // drNxtCNID (offset 30) — bump past the CNID we just assigned.
  dv.setUint32(m + 30, Math.max(cur.drNxtCNID, delta.assignedCNID + 1), false);
  // drFreeBks (offset 34)
  dv.setUint16(m + 34, cur.drFreeBks - delta.addedBlocks, false);
  // drWrCnt (offset 70) — bumps every modification.
  dv.setUint32(m + 70, cur.drWrCnt + 1, false);
  // drFilCnt (offset 84) — file count volume-wide.
  dv.setUint32(m + 84, cur.drFilCnt + delta.addedFiles, false);

  // Alternate MDB lives in the SECOND-TO-LAST 512-byte sector. Per IM:Files
  // 2-58: the alternate MDB is in the next-to-last logical block of the
  // volume, providing a recovery point if the primary is corrupted. The
  // disk-utility "Disk First Aid" can rebuild from it.
  const altMdbOff = disk.length - 2 * 512;
  if (altMdbOff > 0) {
    // Copy the modified primary MDB block over the alt. MDB block (162 B
    // structure, but the surrounding sector content for both is the same:
    // the MDB occupies bytes 0..162 of its sector and the rest is zero in
    // a freshly-formatted disk).
    disk.set(
      disk.subarray(TEMPLATE_LAYOUT.mdbOffset, TEMPLATE_LAYOUT.mdbOffset + 512),
      altMdbOff,
    );
  }
}

// ── Volume bitmap ──────────────────────────────────────────────────────

/** Find a run of `n` consecutive free allocation blocks, starting from
 *  `startBlock`. Returns the alloc-block index, or -1 if not enough
 *  contiguous space exists. */
function findFreeRun(
  disk: Uint8Array,
  startBlock: number,
  n: number,
): number {
  const total = TEMPLATE_LAYOUT.totalAllocBlocks;
  let runStart = -1;
  let runLen = 0;
  for (let b = startBlock; b < total; b++) {
    const byte = TEMPLATE_LAYOUT.bitmapOffset + (b >> 3);
    const bit = 7 - (b & 7);
    const used = (disk[byte]! >> bit) & 1;
    if (used === 0) {
      if (runStart === -1) runStart = b;
      runLen++;
      if (runLen >= n) return runStart;
    } else {
      runStart = -1;
      runLen = 0;
    }
  }
  return -1;
}

function markBlocksUsed(disk: Uint8Array, start: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = start + i;
    const byte = TEMPLATE_LAYOUT.bitmapOffset + (b >> 3);
    const bit = 7 - (b & 7);
    disk[byte] = disk[byte]! | (1 << bit);
  }
}

// ── Catalog leaf node patch ────────────────────────────────────────────

/** Build the cdrType=2 (file record) bytes the empty-volume leaf insert
 *  needs. The structure is a "key + data" pair, with a count byte at the
 *  end of node memory pointing at the start of this record.
 *
 *  Key (variable length, prefixed with a 1-byte keyLength NOT counted in
 *  the keyLength itself):
 *    u8  keyLength   — bytes that follow up to (but not including) padding
 *    u8  reserved    (always 0 in HFS)
 *    u32 parentID    (root dir = 2)
 *    pstring name    (1-byte length + Mac-Roman bytes; ≤ 31 chars for HFS)
 *    [pad byte]      so the full key region (keyLength byte + keyLength
 *                    payload + optional pad) is even-byte aligned
 *
 *  Data (cdrType=2, file record, IM:Files fig 2-25):
 *    u8  cdrType (= 2)
 *    u8  reserved (0)
 *    u8  filFlags        (bit 7 = locked, etc; set 0 by default)
 *    u8  filTyp          (file type, 0)
 *    16  filUsrWds       (FInfo: type, creator, flags, location, folder)
 *    u32 filFlNum        (file ID = CNID)
 *    u16 filStBlk        (data fork first alloc block — 0 if data fork empty)
 *    u32 filLgLen        (data fork logical bytes)
 *    u32 filPyLen        (data fork physical = round up to alloc block)
 *    u16 filRStBlk       (resource fork first alloc block)
 *    u32 filRLgLen       (resource fork logical)
 *    u32 filRPyLen       (resource fork physical)
 *    u32 filCrDat        (creation date, Mac epoch seconds)
 *    u32 filMdDat        (modification date)
 *    u32 filBkDat        (backup date — 0 for never)
 *    16  filFndrInfo     (FXInfo: type-specific Finder info, all zero is fine)
 *    u16 filClpSize      (clump size, 0 inherits from MDB)
 *    12  filExtRec       (data fork extents, ExtDataRec = 3 × (u16 start, u16 count))
 *    12  filRExtRec      (resource fork extents)
 *    u32 filResrv        (reserved, 0)
 */
function encodeFileRecord(opts: {
  parentID: number;
  name: string;
  cnid: number;
  type: number;
  creator: number;
  finderFlags: number;
  dataStartBlock: number; // 0 if dataLen===0
  dataLgLen: number;
  dataPyLen: number;
  rsrcStartBlock: number;
  rsrcLgLen: number;
  rsrcPyLen: number;
}): Uint8Array {
  const nameBytes = new TextEncoder().encode(opts.name);
  if (nameBytes.length > 31) {
    // HFS limit; the empty-volume catalog has keyLen=37 = 1 (reserved) +
    // 4 (parentID) + 1 (name length) + 31 (max name) = 37. Larger names
    // require key extensions we don't handle.
    throw new Error(`HFS filename too long: ${nameBytes.length} > 31`);
  }
  // Catalog key layout (HFS, IM:Files fig 2-15):
  //   u8  keyLength    (the key area's byte count after this byte, INCLUDING
  //                     any trailing pad byte that brings the total to even)
  //   u8  reserved (= 0)
  //   u32 parentID
  //   pstring name     (1-byte length + bytes)
  //   [u8 pad]         present when needed so the entire key area
  //                    (1 keyLength byte + keyLength payload) ends on
  //                    an even byte → data record starts even-aligned
  //
  // Empirical check vs hfsutils (libhfs): "Reader" has 6 bytes of name and
  // hfsutils writes keyLength = 13 (1 reserved + 4 parentID + 1 nameLen +
  // 6 name + 1 PAD = 13). The data record (cdrType=2 …) starts at offset
  // (1 keyLength + 13 keyArea) = 14 from record start — even, as required.
  const keyDataBytes = 1 + 4 + 1 + nameBytes.length; // before pad
  const keyNeedsPad = (1 + keyDataBytes) % 2 !== 0;
  const keyLength = keyDataBytes + (keyNeedsPad ? 1 : 0);
  // File-record data is 102 bytes total (per IM:Files fig 2-25 sizing).
  const DATA_SIZE = 102;
  const recLen = 1 + keyLength + DATA_SIZE;
  const buf = new Uint8Array(recLen);
  const dv = new DataView(buf.buffer);
  let p = 0;
  // u8 keyLength — INCLUDES the trailing pad byte (hfsutils convention).
  buf[p++] = keyLength;
  // u8 reserved = 0
  buf[p++] = 0;
  // u32 parentID
  dv.setUint32(p, opts.parentID, false);
  p += 4;
  // pstring name
  buf[p++] = nameBytes.length;
  buf.set(nameBytes, p);
  p += nameBytes.length;
  // pad byte (if needed), to make the data record start on an even offset.
  if (keyNeedsPad) {
    buf[p++] = 0;
  }
  // ── Data record (cdrType=2 file record) ──
  buf[p++] = 2; // cdrType
  buf[p++] = 0; // reserved
  buf[p++] = 0; // filFlags
  buf[p++] = 0; // filTyp
  // FInfo (16 bytes): type(4) + creator(4) + flags(2) + location(4: 2 u16) + window(2)
  dv.setUint32(p, opts.type, false); p += 4;
  dv.setUint32(p, opts.creator, false); p += 4;
  dv.setUint16(p, opts.finderFlags, false); p += 2;
  // location (Y, X) and window — leave zero so the Finder picks defaults.
  for (let i = 0; i < 6; i++) buf[p++] = 0;
  // u32 filFlNum (CNID)
  dv.setUint32(p, opts.cnid, false); p += 4;
  // Data fork
  dv.setUint16(p, opts.dataStartBlock, false); p += 2; // filStBlk
  dv.setUint32(p, opts.dataLgLen, false); p += 4; // filLgLen
  dv.setUint32(p, opts.dataPyLen, false); p += 4; // filPyLen
  // Resource fork
  dv.setUint16(p, opts.rsrcStartBlock, false); p += 2; // filRStBlk
  dv.setUint32(p, opts.rsrcLgLen, false); p += 4; // filRLgLen
  dv.setUint32(p, opts.rsrcPyLen, false); p += 4; // filRPyLen
  // Dates: created, modified, backup
  const now = macEpochSeconds();
  dv.setUint32(p, now, false); p += 4; // filCrDat
  dv.setUint32(p, now, false); p += 4; // filMdDat
  dv.setUint32(p, 0, false); p += 4; // filBkDat
  // FXInfo (16 bytes), all zero = sensible defaults.
  for (let i = 0; i < 16; i++) buf[p++] = 0;
  // u16 filClpSize = 0 → inherit from MDB drClpSiz
  dv.setUint16(p, 0, false); p += 2;
  // filExtRec — data fork extents (3 × (u16 start, u16 count))
  // Only first extent is populated; the rest are (0,0).
  if (opts.dataLgLen > 0) {
    dv.setUint16(p, opts.dataStartBlock, false); p += 2;
    dv.setUint16(p, opts.dataPyLen / TEMPLATE_LAYOUT.allocBlockSize, false); p += 2;
  } else {
    p += 4;
  }
  // remaining 8 bytes zero
  p += 8;
  // filRExtRec — resource fork extents
  dv.setUint16(p, opts.rsrcStartBlock, false); p += 2;
  dv.setUint16(p, opts.rsrcPyLen / TEMPLATE_LAYOUT.allocBlockSize, false); p += 2;
  p += 8;
  // u32 filResrv
  p += 4;
  if (p !== recLen) {
    throw new Error(`internal: encoded ${p} bytes, expected ${recLen}`);
  }
  return buf;
}

/** Insert a new record at the end of the catalog leaf node 1, updating
 *  the per-record offset trailer and the BTHeader's bthNRecs / bthFree
 *  counters. Assumes the only existing records are the two root-dir
 *  records (thread + dir), keyed by parentID=1 and parentID=2 — both
 *  alphabetically/key-numerically sort BEFORE any file record keyed by
 *  parentID=2 + name (because the empty-volume leaf has only the
 *  directory record at parentID=2 with empty name, which sorts before
 *  any non-empty name). So append-at-end matches HFS key order.
 */
function appendCatalogLeafRecord(
  disk: Uint8Array,
  catalogDiskOffset: number,
  record: Uint8Array,
): void {
  const leafOffset = catalogDiskOffset + TEMPLATE_LAYOUT.catalogLeafNodeIndex * NODE_SIZE;
  const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);
  // Node descriptor: fLink(4) bLink(4) kind(1) height(1) numRecs(2) reserved(2)
  const numRecs = dv.getUint16(leafOffset + 10, false);
  // Read existing record offset trailer. Trailer at end-of-node, descending:
  // last 2 bytes = offset[0] (start of first record), preceding 2 bytes =
  // offset[1] (start of second record), ..., and offset[numRecs] = where
  // the next record would start (= current free pointer).
  const trailerEnd = leafOffset + NODE_SIZE;
  const offsets: number[] = [];
  for (let i = 0; i <= numRecs; i++) {
    offsets.push(dv.getUint16(trailerEnd - 2 * (i + 1), false));
  }
  const freePtr = offsets[numRecs]!;
  const newFreePtr = freePtr + record.length;
  // Total offsets after insert = numRecs+1 records + 1 free pointer.
  const trailerBytes = 2 * (numRecs + 2);
  if (newFreePtr + trailerBytes > NODE_SIZE) {
    throw new Error(
      `catalog leaf node 1 would overflow: free=${freePtr} + rec=${record.length} + trailer=${trailerBytes} > ${NODE_SIZE}. ` +
        `One-app-per-disk template was sized for this fitting; did the file record encoding change?`,
    );
  }
  // Write the new record bytes.
  disk.set(record, leafOffset + freePtr);
  // Update numRecs.
  dv.setUint16(leafOffset + 10, numRecs + 1, false);
  // Rewrite the offset trailer with one extra entry. The existing
  // offsets[0..numRecs] stay where they are; we write the new free pointer
  // at position numRecs+1.
  for (let i = 0; i <= numRecs; i++) {
    dv.setUint16(trailerEnd - 2 * (i + 1), offsets[i]!, false);
  }
  dv.setUint16(trailerEnd - 2 * (numRecs + 2), newFreePtr, false);
  // Patch BTHeader (in node 0): bthNRecs += 1, bthFree -= 1.
  // Header node 0, header record starts at offset 14 inside the node.
  const headerNodeOff = catalogDiskOffset;
  // Header record offset: trailer last 2 bytes points at it. For the
  // baked template the first record in node 0 is at offset 14.
  const hdrRecOff = headerNodeOff + 14;
  const bthNRecs = dv.getUint32(hdrRecOff + 6, false);
  dv.setUint32(hdrRecOff + 6, bthNRecs + 1, false);
  const bthFree = dv.getUint32(hdrRecOff + 26, false);
  if (bthFree > 0) dv.setUint32(hdrRecOff + 26, bthFree - 1, false);
}

/** Find the root-directory directory record in catalog leaf node 1 and
 *  bump its valence (child count) by 1, plus refresh its modtime. The
 *  baked empty-volume template has rec0 = the root-dir directory record
 *  (key parentID=1, name="Apps"); we don't search by key — we just trust
 *  the well-known position of rec0. If a future template changes that
 *  the assertion in `appendCatalogLeafRecord` will catch the breakage
 *  before it produces a corrupt disk.
 */
function bumpRootDirValence(disk: Uint8Array, catalogDiskOffset: number): void {
  const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);
  const leafOffset = catalogDiskOffset + TEMPLATE_LAYOUT.catalogLeafNodeIndex * NODE_SIZE;
  // rec0 lives at offset 14 in the leaf (per the trailer).
  const rec0 = leafOffset + 14;
  // rec0 layout for the root-dir directory record (cdrDirRec):
  //   keyLength(1) reserved(1) parentID(4) nameLen(1) name(N) [pad]
  //   cdrType(1) cdrResrv2(1) dirFlags(2) dirVal(2) dirDirID(4)
  //   dirCrDat(4) dirMdDat(4) dirBkDat(4) dirUsrInfo(16) dirFndrInfo(16)
  //   dirResrv(16)
  // For our template name "Apps" (4 bytes) the key spans bytes:
  //   1 (keyLength) + 1 (reserved) + 4 (parentID) + 1 (nameLen) + 4 (name)
  //   = 11 → keyLength=11. (1+11) = 12 even, no pad. Data starts at offset 12.
  // Empirically the ground-truth has keyLength=11 (`0b`).
  // dirFlags at +14, dirVal at +16, dirDirID at +18, dirCrDat at +22,
  // dirMdDat at +26.
  const dataOff = rec0 + 12;
  const dirVal = dv.getUint16(dataOff + 4, false);
  dv.setUint16(dataOff + 4, dirVal + 1, false);
  // dirMdDat refresh.
  dv.setUint32(dataOff + 12, macEpochSeconds(), false);
}

// ── Top-level API ──────────────────────────────────────────────────────

export interface PatchOptions {
  /** Bytes of the empty HFS template — public/playground/empty-secondary.dsk. */
  templateBytes: Uint8Array;
  /** Compiled MacBinary `.bin` from the playground build pipeline. */
  macBinary: Uint8Array;
  /** Filename to give the file at the volume root. Falls back to the
   *  MacBinary header's filename if omitted. ≤31 Mac-Roman bytes. */
  filename?: string;
}

/**
 * Patch the empty volume to contain one file at the root. Returns a
 * fresh Uint8Array — the input `templateBytes` is NOT mutated. Caller
 * hands the result to InMemoryDisk in the worker.
 */
export function patchEmptyVolumeWithBinary(opts: PatchOptions): Uint8Array {
  const { templateBytes, macBinary } = opts;

  // Defensive copy. We're going to write into the disk extensively.
  const disk = new Uint8Array(templateBytes.length);
  disk.set(templateBytes);

  // 1. Decode the MacBinary so we know the forks + Type/Creator.
  const mb = parseMacBinary(macBinary);
  const filename = opts.filename ?? mb.filename;

  // 2. Snapshot pre-MDB state.
  const mdb = readMdb(disk);
  const cnid = mdb.drNxtCNID;

  // 3. Allocate alloc-blocks. HFS files always store data fork before
  //    resource fork in a contiguous-extent layout; we follow suit so
  //    the start blocks are simple to compute.
  const ab = TEMPLATE_LAYOUT.allocBlockSize;
  const dataPy = roundUpToAllocBlocks(mb.dataLen);
  const rsrcPy = roundUpToAllocBlocks(mb.rsrcLen);
  const dataBlocks = dataPy / ab;
  const rsrcBlocks = rsrcPy / ab;
  const totalNeeded = dataBlocks + rsrcBlocks;
  if (totalNeeded > mdb.drFreeBks) {
    throw new Error(
      `not enough free space: need ${totalNeeded} blocks, have ${mdb.drFreeBks}`,
    );
  }

  // 4. Find a contiguous run starting from drAllocPtr (44 in the
  //    template — first free block after the catalog). We do contiguous
  //    even though HFS supports up to 3 extents per record, because
  //    finding any 41-block run in 2830 free blocks is trivial in the
  //    empty template.
  const startBlock = findFreeRun(disk, /*from=*/ 44, totalNeeded);
  if (startBlock < 0) {
    throw new Error(
      `cannot find ${totalNeeded} contiguous free alloc blocks (template fragmented?)`,
    );
  }
  const dataStartBlock = mb.dataLen > 0 ? startBlock : 0;
  const rsrcStartBlock = startBlock + dataBlocks;

  // 5. Copy the data fork bytes. Start offset = allocStart + dataStartBlock*ab.
  if (mb.dataLen > 0) {
    const off = allocBlockToDiskOffset(dataStartBlock);
    disk.set(mb.dataFork, off);
    // Trailing bytes from `off + dataLen` to `off + dataPy` stay zero —
    // they're already zero in the template (fresh format).
  }
  // 6. Copy the resource fork.
  if (mb.rsrcLen > 0) {
    const off = allocBlockToDiskOffset(rsrcStartBlock);
    disk.set(mb.resourceFork, off);
  }

  // 7. Mark the bitmap.
  markBlocksUsed(disk, startBlock, totalNeeded);

  // 8. Bump the root directory record's valence and modtime. The root dir's
  //    cdrDirRec lives in catalog leaf node 1 record 0 (key parentID=1
  //    name="Apps"). dirVal (u16) and dirMdDat (u32) live at known offsets
  //    inside the data portion of that record — offsets verified against
  //    hfsutils ground truth.
  bumpRootDirValence(disk, allocBlockToDiskOffset(
    TEMPLATE_LAYOUT.catalogFirstAllocBlock,
  ));

  // 9. Encode the catalog file record and append to the leaf.
  const record = encodeFileRecord({
    parentID: 2, // root directory CNID is always 2 in HFS
    name: filename,
    cnid,
    type: mb.type,
    creator: mb.creator,
    finderFlags: mb.finderFlags,
    dataStartBlock,
    dataLgLen: mb.dataLen,
    dataPyLen: dataPy,
    rsrcStartBlock,
    rsrcLgLen: mb.rsrcLen,
    rsrcPyLen: rsrcPy,
  });
  const catalogDiskOff = allocBlockToDiskOffset(
    TEMPLATE_LAYOUT.catalogFirstAllocBlock,
  );
  appendCatalogLeafRecord(disk, catalogDiskOff, record);

  // 10. Update MDB + alt MDB.
  patchMdb(disk, {
    addedBlocks: totalNeeded,
    addedFiles: 1,
    assignedCNID: cnid,
  });

  return disk;
}

// ── Test helpers (export so unit tests in tests/unit can reach them) ───

export const __test = {
  TEMPLATE_LAYOUT,
  allocBlockToDiskOffset,
  roundUpToAllocBlocks,
  findFreeRun,
  markBlocksUsed,
  encodeFileRecord,
  appendCatalogLeafRecord,
  readMdb,
  patchMdb,
  parseMacBinary,
};
