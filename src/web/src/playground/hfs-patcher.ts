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

// ── Volume rename (drVN + catalog rec0 + rec1 thread record) ──────────

/** Maximum HFS volume name length (drVN is a Pascal string in a
 *  28-byte field — 1 length byte + 27 name bytes). HFS also caps
 *  catalog filenames at 31 bytes; the volume-name field is the
 *  binding constraint here. */
const MAX_VOLUME_NAME_BYTES = 27;

/**
 * Rename the volume in-place: patches MDB drVN, then patches the
 * catalog root-directory record (leaf node 1 rec0)'s key name and
 * the root-dir thread record (rec1)'s thdCName, then reflows rec1
 * if rec0's keyLength changed.
 *
 * Why all three: HFS keeps the volume name in three places that all
 * have to agree, or various consumers get confused:
 *   - MDB drVN — what the Finder/OS shows on the desktop
 *   - Catalog leaf rec0 (parentID=1 + name) — the root directory's
 *     own entry; tools like hfsutils' `hls` look it up by name and
 *     fail with "Expected volume X not found" if it doesn't match
 *     drVN
 *   - Catalog leaf rec1 (the thread record for the root dir) — its
 *     thdCName field also stores the root's name; some Disk First
 *     Aid checks compare it against drVN
 *
 * NB: Must run BEFORE any `injectFileAtRoot` call, because injection
 * appends records after rec1 — reflowing rec1 after that is much
 * more work (would need to walk + shift every subsequent record).
 * The convenient ordering happens naturally in
 * patchEmptyVolumeWithBinary below.
 *
 * Mac Roman 1-byte encoding only (ASCII works as a subset). Names
 * longer than 27 bytes throw.
 */
export function renameVolume(disk: Uint8Array, newName: string): void {
  const nameBytes = new TextEncoder().encode(newName);
  if (nameBytes.length > MAX_VOLUME_NAME_BYTES) {
    throw new Error(
      `HFS volume name too long: ${nameBytes.length} > ${MAX_VOLUME_NAME_BYTES} ('${newName}')`,
    );
  }
  if (nameBytes.length === 0) {
    throw new Error("HFS volume name cannot be empty");
  }

  // ── 1. MDB drVN (offset 36, Pascal string in 28-byte field) ──
  const m = TEMPLATE_LAYOUT.mdbOffset;
  disk[m + 36] = nameBytes.length;
  for (let i = 0; i < 27; i++) {
    disk[m + 37 + i] = i < nameBytes.length ? nameBytes[i]! : 0;
  }
  // Alternate MDB sync — patchMdb already does a full 512-byte copy
  // of the primary MDB sector to the alternate MDB sector after
  // every modification, so subsequent patchMdb calls will pick this
  // up. But our caller may not invoke patchMdb (e.g. if zero files
  // are injected), so mirror the drVN field explicitly here too.
  const altMdbOff = disk.length - 2 * 512;
  if (altMdbOff > 0) {
    disk[altMdbOff + 36] = nameBytes.length;
    for (let i = 0; i < 27; i++) {
      disk[altMdbOff + 37 + i] = i < nameBytes.length ? nameBytes[i]! : 0;
    }
  }

  // ── 2. Catalog leaf rec0 key (root-dir directory record) ──
  const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);
  const catalogDiskOffset = allocBlockToDiskOffset(
    TEMPLATE_LAYOUT.catalogFirstAllocBlock,
  );
  const leafOffset =
    catalogDiskOffset + TEMPLATE_LAYOUT.catalogLeafNodeIndex * NODE_SIZE;

  const numRecs = dv.getUint16(leafOffset + 10, false);
  if (numRecs < 2) {
    throw new Error(
      `catalog leaf has ${numRecs} records, expected at least 2 (rec0 dir + rec1 thread)`,
    );
  }

  // Read existing offsets (descending trailer at end of node).
  const trailerEnd = leafOffset + NODE_SIZE;
  const offsets: number[] = [];
  for (let i = 0; i <= numRecs; i++) {
    offsets.push(dv.getUint16(trailerEnd - 2 * (i + 1), false));
  }
  const rec0Off = offsets[0]!;
  const rec1Off = offsets[1]!;

  // Compute old key length: byte 0 of rec0 is keyLength.
  const oldKeyLength = disk[leafOffset + rec0Off]!;
  const oldRec0Size = 1 + oldKeyLength + (rec1Off - rec0Off - 1 - oldKeyLength);
  // Rec0 data record (cdrDirRec) is 70 bytes; verify by subtracting.
  const dirDataSize = rec1Off - rec0Off - 1 - oldKeyLength;

  // Compute new key bytes:
  //   1 reserved + 4 parentID + 1 nameLen + N name + optional pad
  // The key area's byte count (after the leading keyLength byte) is
  // 1 + 4 + 1 + N = 6 + N; total record area before data = 1 + (6 + N)
  // + optional pad. Per hfsutils convention, keyLength INCLUDES the
  // trailing pad byte (so that 1 + keyLength is always even and the
  // data record starts on an even-byte boundary).
  const keyDataBytes = 1 + 4 + 1 + nameBytes.length;
  const keyNeedsPad = (1 + keyDataBytes) % 2 !== 0;
  const newKeyLength = keyDataBytes + (keyNeedsPad ? 1 : 0);
  const newRec0Size = 1 + newKeyLength + dirDataSize;
  const delta = newRec0Size - oldRec0Size;

  // Bounds check the leaf node has room.
  const oldFreePtr = offsets[numRecs]!;
  const newFreePtr = oldFreePtr + delta;
  const newTrailerBytes = 2 * (numRecs + 1);
  if (newFreePtr + newTrailerBytes > NODE_SIZE) {
    throw new Error(
      `volume rename would overflow leaf node: freePtr=${oldFreePtr} delta=${delta} trailer=${newTrailerBytes} > node size ${NODE_SIZE}`,
    );
  }

  // Preserve the existing dir-record data (the 70 bytes after rec0's
  // key) before we shift things around.
  const dirData = disk.slice(
    leafOffset + rec0Off + 1 + oldKeyLength,
    leafOffset + rec0Off + 1 + oldKeyLength + dirDataSize,
  );

  // Capture all records FROM rec1 onward so we can shift them.
  // rec1 lives at rec1Off; everything from there to oldFreePtr is
  // record bytes; copy out, then write back at shifted offset.
  const tailLen = oldFreePtr - rec1Off;
  const tailBytes = disk.slice(
    leafOffset + rec1Off,
    leafOffset + rec1Off + tailLen,
  );

  // ── Write new rec0 ──
  let p = leafOffset + rec0Off;
  disk[p++] = newKeyLength;
  disk[p++] = 0; // reserved
  dv.setUint32(p, 1, false); // parentID = 1 (root dir's parent)
  p += 4;
  disk[p++] = nameBytes.length;
  for (const b of nameBytes) disk[p++] = b;
  if (keyNeedsPad) disk[p++] = 0;
  // Restore the dir-record data (cdrDirRec) — same 70 bytes that were
  // there before. We are NOT modifying the dirNameLen inside the
  // cdrDirRec because the dir record doesn't store its own name (the
  // name lives in the key); only the data fields (CNID, valence,
  // dates, finder info) stay.
  disk.set(dirData, p);
  p += dirDataSize;

  // ── Write rec1 (and any further records) at the shifted offset ──
  // The tail we captured is byte-for-byte identical EXCEPT we need to
  // update the thread record's thdCName inside it, which still says
  // the old name.
  //
  // rec1 layout (positions WITHIN tailBytes):
  //   0:        keyLength
  //   1:        reserved
  //   2..5:     parentID (= 2)
  //   6:        nameLen (= 0 for thread records)
  //   7:        pad (since 1+1+4+1=7 is odd → +1 pad)
  //   8:        cdrType (= 3)
  //   9:        cdrResrv2
  //   10..17:   thdResrv[8]
  //   18..21:   thdParID (= 1)
  //   22..53:   thdCName — Pascal string padded to 32 bytes
  //     22:     nameLen (= 4 in stock template, "Apps")
  //     23+:    name bytes, zero-padded
  //
  // Update thdCName to match newName.
  tailBytes[22] = nameBytes.length;
  for (let i = 0; i < 31; i++) {
    tailBytes[23 + i] = i < nameBytes.length ? nameBytes[i]! : 0;
  }
  disk.set(tailBytes, leafOffset + rec0Off + newRec0Size);

  // ── Zero out the gap between old freePtr and new freePtr if delta
  //    is negative (shrinking name). When delta > 0 (growing name)
  //    the new freePtr is past the old; no gap to clear, and the
  //    tail bytes we wrote already cover the expanded region. ──
  if (delta < 0) {
    for (let i = newFreePtr; i < oldFreePtr; i++) {
      disk[leafOffset + i] = 0;
    }
  }

  // ── Update offset trailer ──
  // New offsets[i] for i > 0 shifts by delta.
  for (let i = 0; i <= numRecs; i++) {
    const newOffset = i === 0 ? rec0Off : offsets[i]! + delta;
    dv.setUint16(trailerEnd - 2 * (i + 1), newOffset, false);
  }
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
  //
  // The data area starts at byte (1 + keyLength) from rec0 — past the
  // keyLength byte itself and all of its key payload (incl. any pad
  // byte). This was hardcoded to `rec0 + 12` (the offset that's true
  // for "Apps", which gives keyLength=11) until cv-mac #220 added the
  // renameVolume function — after a rename the keyLength changes
  // ("Wasm Hello" → keyLength=17 → data at rec0+18), and a hardcoded
  // 12 ends up scribbling into the key area. Compute it dynamically.
  //
  // dirFlags at dataOff+2, dirVal at dataOff+4, dirDirID at dataOff+6,
  // dirCrDat at dataOff+10, dirMdDat at dataOff+14.
  const keyLength = disk[rec0]!;
  const dataOff = rec0 + 1 + keyLength;
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
  /** Rename the volume from the template's default "Apps" to something
   *  project-specific (e.g. "Wasm Sound"). Updates MDB drVN AND the
   *  catalog root-directory record's key name AND its thread record's
   *  thdCName, all of which HFS requires to agree (cv-mac #220). ≤27
   *  Mac-Roman bytes. Leave undefined to keep the template's "Apps". */
  volumeName?: string;
  /** Additional non-MacBinary files to drop at the volume root alongside the
   *  main app. Useful for shipping a small diagnostic README the user can
   *  open in TeachText. Each filename MUST sort AFTER the main file's
   *  filename in HFS catalog key order (parentID=2, then case-insensitive
   *  name) because we append-only to the catalog leaf and HFS requires
   *  records sorted by key. Empirically: pick a name starting with a
   *  character that case-folds higher than the main file's first character
   *  (e.g. main = "hello_toolbox", extra = "info.txt" — 'i' > 'h'). */
  extraFiles?: ExtraFile[];
}

export interface ExtraFile {
  /** ≤31 Mac-Roman bytes. Must sort after PatchOptions.filename — see note. */
  filename: string;
  /** OSType file type (u32, big-endian). E.g. 'TEXT' = 0x54455854. */
  type: number;
  /** OSType creator. E.g. 'ttxt' = 0x74747874 (SimpleText/TeachText). */
  creator: number;
  /** Finder flags (high byte). 0 is fine for a plain document. */
  finderFlags?: number;
  /** File data fork bytes. */
  dataFork: Uint8Array;
}

/** Inject one file at the volume root. Mutates `disk` in place: allocates
 *  blocks, copies forks, marks bitmap, appends catalog record, bumps root
 *  valence, and patches MDB. Returns nothing — caller orchestrates ordering
 *  of multiple injections.
 *
 *  NB: the catalog leaf is append-only here, so successive injections must
 *  pass files whose keys (parentID=2 + name) sort in ascending order.
 */
function injectFileAtRoot(
  disk: Uint8Array,
  file: {
    filename: string;
    type: number;
    creator: number;
    finderFlags: number;
    dataFork: Uint8Array;
    resourceFork: Uint8Array;
  },
): void {
  const ab = TEMPLATE_LAYOUT.allocBlockSize;
  const mdb = readMdb(disk);
  const cnid = mdb.drNxtCNID;

  const dataLen = file.dataFork.length;
  const rsrcLen = file.resourceFork.length;
  const dataPy = roundUpToAllocBlocks(dataLen);
  const rsrcPy = roundUpToAllocBlocks(rsrcLen);
  const dataBlocks = dataPy / ab;
  const rsrcBlocks = rsrcPy / ab;
  const totalNeeded = dataBlocks + rsrcBlocks;
  if (totalNeeded > mdb.drFreeBks) {
    throw new Error(
      `not enough free space for ${file.filename}: need ${totalNeeded} blocks, have ${mdb.drFreeBks}`,
    );
  }

  // The empty-template allocPtr is 44; subsequent allocations need to walk
  // past whatever's already marked used by a prior injection.  findFreeRun
  // scans the bitmap, so starting from 44 still works for the second file.
  const startBlock = findFreeRun(disk, /*from=*/ 44, totalNeeded);
  if (startBlock < 0) {
    throw new Error(
      `cannot find ${totalNeeded} contiguous free alloc blocks for ${file.filename}`,
    );
  }
  const dataStartBlock = dataLen > 0 ? startBlock : 0;
  const rsrcStartBlock = startBlock + dataBlocks;

  if (dataLen > 0) {
    disk.set(file.dataFork, allocBlockToDiskOffset(dataStartBlock));
  }
  if (rsrcLen > 0) {
    disk.set(file.resourceFork, allocBlockToDiskOffset(rsrcStartBlock));
  }
  markBlocksUsed(disk, startBlock, totalNeeded);
  bumpRootDirValence(
    disk,
    allocBlockToDiskOffset(TEMPLATE_LAYOUT.catalogFirstAllocBlock),
  );

  const record = encodeFileRecord({
    parentID: 2, // root directory CNID is always 2 in HFS
    name: file.filename,
    cnid,
    type: file.type,
    creator: file.creator,
    finderFlags: file.finderFlags,
    dataStartBlock,
    dataLgLen: dataLen,
    dataPyLen: dataPy,
    rsrcStartBlock,
    rsrcLgLen: rsrcLen,
    rsrcPyLen: rsrcPy,
  });
  appendCatalogLeafRecord(
    disk,
    allocBlockToDiskOffset(TEMPLATE_LAYOUT.catalogFirstAllocBlock),
    record,
  );

  patchMdb(disk, {
    addedBlocks: totalNeeded,
    addedFiles: 1,
    assignedCNID: cnid,
  });
}

/**
 * Patch the empty volume to contain the main MacBinary file at the root,
 * plus any additional plain files passed in `extraFiles`. Returns a fresh
 * Uint8Array — the input `templateBytes` is NOT mutated. Caller hands the
 * result to InMemoryDisk in the worker.
 *
 * Multi-file ordering: extras are injected after the main file in array
 * order. HFS requires catalog records sorted by key (parentID + name); we
 * append-only to the leaf, so callers MUST pre-sort `extraFiles` by name
 * such that each entry's name compares >= the previous one in
 * case-insensitive Mac Roman order, AND the first entry's name compares
 * >= the main file's name. (Empirically: pick filenames whose first
 * character case-folds higher than the main filename's first character.)
 */
export function patchEmptyVolumeWithBinary(opts: PatchOptions): Uint8Array {
  const { templateBytes, macBinary, extraFiles } = opts;

  // Defensive copy. We're going to write into the disk extensively.
  const disk = new Uint8Array(templateBytes.length);
  disk.set(templateBytes);

  // 1. Decode the MacBinary so we know the forks + Type/Creator.
  const mb = parseMacBinary(macBinary);
  const filename = opts.filename ?? mb.filename;

  // 1.5. Rename the volume BEFORE any file injection — see renameVolume's
  //      doc comment for why this ordering matters (injection appends
  //      records after rec1, which renameVolume needs to be able to
  //      shift safely).
  if (opts.volumeName) {
    renameVolume(disk, opts.volumeName);
  }

  // 2. Inject the main file.
  injectFileAtRoot(disk, {
    filename,
    type: mb.type,
    creator: mb.creator,
    finderFlags: mb.finderFlags,
    dataFork: mb.dataLen > 0 ? mb.dataFork : new Uint8Array(),
    resourceFork: mb.rsrcLen > 0 ? mb.resourceFork : new Uint8Array(),
  });

  // 3. Inject extras (e.g. README.txt).  Catalog is append-only, so caller
  //    must have sorted extras by HFS key order.
  if (extraFiles && extraFiles.length > 0) {
    for (const extra of extraFiles) {
      injectFileAtRoot(disk, {
        filename: extra.filename,
        type: extra.type,
        creator: extra.creator,
        finderFlags: extra.finderFlags ?? 0,
        dataFork: extra.dataFork,
        resourceFork: new Uint8Array(), // plain documents have no rsrc fork
      });
    }
  }

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
  renameVolume,
  MAX_VOLUME_NAME_BYTES,
};
