#!/usr/bin/env node
/*
 * suppress-boot-windows.mjs — patch the unchunked boot .dsk to
 * suppress the Finder's auto-opening of windows on boot (cv-mac #245).
 *
 * Strategy (Approach A from #245):
 *   1. Walk the boot disk's HFS catalog B-tree.
 *   2. For every directory record (cdrType=1), zero the `frOpenChain`
 *      field in DXInfo (data offset 42 within cdrDirRec).
 *   3. Save the patched disk in-place.
 *
 * The HFS Finder maintains the "auto-open these on boot" list as a
 * linked chain of folder IDs threaded through every folder's
 * frOpenChain field. Zeroing the field across the board truncates
 * every chain that runs through any of them — equivalent to "no
 * folders were open at last shutdown."
 *
 * If this works, the Finder honours the catalog state and we're done.
 * If it doesn't (because the Finder re-derives state from Desktop DB
 * regardless), we'll see windows still open in the post-boot
 * screenshot and need to escalate to Desktop DB patching (a separate
 * deeper project).
 *
 * The script is idempotent — re-running on an already-patched disk
 * is a no-op.
 *
 * Usage: node scripts/suppress-boot-windows.mjs <path-to-disk.dsk>
 */
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: suppress-boot-windows.mjs <disk.dsk>");
  process.exit(2);
}

const disk = new Uint8Array(readFileSync(path));
const dv = new DataView(disk.buffer, disk.byteOffset, disk.byteLength);

// ── MDB at logical-block 2 (= byte 1024) ──
const MDB = 1024;
if (dv.getUint16(MDB, false) !== 0x4244) {
  console.error(`error: ${path} does not look like HFS (drSigWord != 'BD')`);
  process.exit(1);
}

const drAlBlkSiz = dv.getUint32(MDB + 20, false); // allocation block size
const drAlBlSt = dv.getUint16(MDB + 28, false);   // first alloc block in volume
const drCTFlSize = dv.getUint32(MDB + 146, false); // catalog file size, bytes
const drCTExtRecBlk0 = dv.getUint16(MDB + 150, false); // catalog first extent start
const drCTExtRecCnt0 = dv.getUint16(MDB + 152, false); // catalog first extent count

console.log(`[boot-windows] HFS volume detected`);
console.log(`[boot-windows] drAlBlkSiz=${drAlBlkSiz} drAlBlSt=${drAlBlSt}`);
console.log(`[boot-windows] catalog file size=${drCTFlSize}, first extent start=${drCTExtRecBlk0} count=${drCTExtRecCnt0}`);

// Catalog disk offset = drAlBlSt (in 512-blocks) * 512 + catalogStartAllocBlock * drAlBlkSiz
const catalogDiskOffset = drAlBlSt * 512 + drCTExtRecBlk0 * drAlBlkSiz;
console.log(`[boot-windows] catalog starts at byte offset ${catalogDiskOffset} (0x${catalogDiskOffset.toString(16)})`);

// ── Catalog header node (node 0) ──
// Node descriptor: fLink(4) bLink(4) kind(1) height(1) numRecs(2) reserved(2)
// Header record at offset 14 in node 0. BTHeader layout:
//   bthDepth   u16   (record +0  = node +14)
//   bthRoot    u32   (record +2  = node +16)
//   bthNRecs   u32   (record +6  = node +20)
//   bthFNode   u32   (record +10 = node +24)
//   bthLNode   u32   (record +14 = node +28)
//   bthNodeSize u16  (record +18 = node +32)
//   …
const headerNode = catalogDiskOffset;
const bthFNode = dv.getUint32(headerNode + 24, false);  // first leaf node
const bthLNode = dv.getUint32(headerNode + 28, false);  // last leaf node
const bthNodeSize = dv.getUint16(headerNode + 32, false);
console.log(`[boot-windows] node size=${bthNodeSize}, first leaf=${bthFNode}, last leaf=${bthLNode}`);

// ── Walk every leaf node, find dir records, patch frOpenChain ──
let nodesScanned = 0;
let dirRecordsSeen = 0;
let dirRecordsPatched = 0;
let alreadyZero = 0;

let nodeIdx = bthFNode;
const visited = new Set();
while (nodeIdx !== 0 && !visited.has(nodeIdx)) {
  visited.add(nodeIdx);
  nodesScanned++;
  const nodeOff = catalogDiskOffset + nodeIdx * bthNodeSize;
  const fLink = dv.getUint32(nodeOff, false);
  const kind = disk[nodeOff + 8];
  if (kind !== 0xff) {
    // Not a leaf (-1 = leaf in two's-complement signed byte = 0xff).
    // Stop — header chain may have pointed somewhere unexpected.
    console.warn(`[boot-windows] node ${nodeIdx} kind=${kind}, not a leaf — stopping walk`);
    break;
  }
  const numRecs = dv.getUint16(nodeOff + 10, false);

  // Read record offsets from trailer (descending).
  const trailerEnd = nodeOff + bthNodeSize;
  const offsets = [];
  for (let i = 0; i <= numRecs; i++) {
    offsets.push(dv.getUint16(trailerEnd - 2 * (i + 1), false));
  }

  for (let r = 0; r < numRecs; r++) {
    const recOff = nodeOff + offsets[r];
    const keyLength = disk[recOff];
    if (keyLength === 0) continue; // deleted/empty
    const dataOff = recOff + 1 + keyLength;
    const cdrType = disk[dataOff];

    if (cdrType === 1) {
      // cdrDirRec — directory record. Patch DXInfo.frOpenChain (data
      // offset 42, u32 BE).
      dirRecordsSeen++;
      // Read the key for diagnostic logging — key area starts at
      // byte 1 of the record, structure: reserved(1) parentID(4)
      // nameLen(1) name(N).
      const parentID = dv.getUint32(recOff + 2, false);
      const nameLen = disk[recOff + 6];
      const nameBytes = disk.subarray(recOff + 7, recOff + 7 + nameLen);
      const name = new TextDecoder("latin1").decode(nameBytes);
      const frOpenChainOff = dataOff + 42;
      const cur = dv.getUint32(frOpenChainOff, false);
      if (cur === 0) {
        alreadyZero++;
      } else {
        dv.setUint32(frOpenChainOff, 0, false);
        dirRecordsPatched++;
        console.log(
          `[boot-windows]   patched dir parentID=${parentID} name='${name}' frOpenChain was 0x${cur.toString(16)}`,
        );
      }
    }
  }

  nodeIdx = fLink;
}

console.log(`[boot-windows] scanned ${nodesScanned} leaf node(s)`);
console.log(`[boot-windows] dir records seen: ${dirRecordsSeen} (already zero: ${alreadyZero}, patched: ${dirRecordsPatched})`);

writeFileSync(path, Buffer.from(disk));
console.log(`[boot-windows] wrote ${path}`);
