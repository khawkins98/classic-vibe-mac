/**
 * resourceForkMerger.mjs — Phase 2A of #280 Path B (asset-handling
 * architecture, fork-composition gap).
 *
 * Merge N Mac OS resource forks into a single fork. Used to combine
 * the wasm-rez-compiled fork from a project's .r source with one or
 * more pre-built forks extracted from upstream MacBinaries (via
 * scripts/extract-resource-fork.mjs, #284). Conflict policy:
 * **first-fork wins** on duplicate `(type, id)` — i.e. the user's
 * Rez source overrides the upstream prebuilt, not the other way
 * around. Same reasoning as a .gitignore or CSS layer cascade: the
 * thing the user can directly edit should outrank the thing they
 * just inherited.
 *
 * Plain .mjs (no TS) so both Vite (browser-side, called from the
 * splice pipeline) and Node (audit script + scripts/-side tooling)
 * can import without build steps. Sibling .d.mts provides type
 * hints for the TS side.
 *
 * Resource fork format reference: Inside Macintosh: More Macintosh
 * Toolbox §1-121 (resource map structure). Same decode logic as
 * scripts/extract-resource-fork.mjs — kept independent here to
 * avoid Node-only dependencies leaking into the browser path.
 */

/**
 * @typedef {Object} DecodedResource
 * @property {string} type            FourCC, e.g. "PICT"
 * @property {number} id              16-bit signed
 * @property {string|null} name       Pascal-string name, or null if unnamed
 * @property {number} attrs           Resource attributes byte
 * @property {Uint8Array} data        Resource data bytes (without the
 *                                    4-byte length prefix that lives
 *                                    in the on-disk data section)
 */

/**
 * Merge the input resource forks into a single fork.
 * First-fork wins on `(type, id)` conflict.
 *
 * @param {Uint8Array[]} forks  Input forks in priority order. forks[0]
 *                              wins conflicts.
 * @returns {Uint8Array}        New resource fork.
 */
export function mergeResourceForks(forks) {
  if (forks.length === 0) return makeEmptyFork();
  /** @type {Map<string, DecodedResource>} */
  const collected = new Map();
  for (const fork of forks) {
    const decoded = decodeResourceFork(fork);
    for (const r of decoded) {
      const key = keyOf(r.type, r.id);
      if (!collected.has(key)) {
        collected.set(key, r);
      }
    }
  }
  return encodeResourceFork([...collected.values()]);
}

function keyOf(type, id) {
  // Use a length-prefixed encoding so e.g. ("PICT", 0) doesn't collide
  // with ("PICT0", 0). Type is always 4 bytes so we can just concat,
  // but the explicit separator is cheap and readable.
  return `${type}|${id}`;
}

// ── Decode ────────────────────────────────────────────────────────────
//
// Format (Inside Macintosh: More Macintosh Toolbox §1-121):
//
//   Fork header (16 bytes):
//     0..3    offset to resource data section
//     4..7    offset to resource map
//     8..11   length of resource data section
//     12..15  length of resource map
//
//   Resource map:
//     0..15   copy of fork header (zeroed on disk)
//     16..19  next-map handle (zeroed on disk)
//     20..21  file refnum (zeroed on disk)
//     22..23  file attributes
//     24..25  offset (from map start) to type list
//     26..27  offset (from map start) to name list
//     28..29  count of types MINUS 1 (0xFFFF means 0 types)
//
//   Type list entry (8 bytes per type):
//     0..3    type (4 ASCII chars)
//     4..5    count MINUS 1
//     6..7    offset to reference list (from type-list start)
//
//   Reference list entry (12 bytes per resource):
//     0..1    id (signed 16-bit)
//     2..3    offset to name (from name-list start); -1 = no name
//     4       attributes
//     5..7    offset to resource data (24-bit, from data section start)
//     8..11   reserved (handle in memory; zero on disk)
//
//   Name list entries: Pascal strings (1 length byte + bytes).
//
//   Resource data: at the data offset, 4-byte length prefix, then bytes.
//
/**
 * @param {Uint8Array} fork
 * @returns {DecodedResource[]}
 */
export function decodeResourceFork(fork) {
  if (fork.length < 16) {
    throw new Error(`resource fork too short: ${fork.length} bytes`);
  }
  const dv = new DataView(fork.buffer, fork.byteOffset, fork.byteLength);
  const dataOff = dv.getUint32(0, false);
  const mapOff = dv.getUint32(4, false);
  const mapLen = dv.getUint32(12, false);
  if (mapOff + mapLen > fork.length) {
    throw new Error(
      `resource map extends past fork end: ${mapOff}+${mapLen} > ${fork.length}`,
    );
  }
  const typeListOffInMap = dv.getUint16(mapOff + 24, false);
  const nameListOffInMap = dv.getUint16(mapOff + 26, false);
  const numTypesMinus1 = dv.getUint16(mapOff + 28, false);
  const numTypes = numTypesMinus1 === 0xffff ? 0 : numTypesMinus1 + 1;
  const typeListStart = mapOff + typeListOffInMap;
  const nameListStart = mapOff + nameListOffInMap;

  /** @type {DecodedResource[]} */
  const out = [];
  for (let i = 0; i < numTypes; i++) {
    // Type list entries start AFTER the 2-byte numTypes-1 field that lives
    // at typeListOff. So entry i is at typeListStart + 2 + i*8.
    const entryOff = typeListStart + 2 + i * 8;
    const type = readFourCC(fork, entryOff);
    const countMinus1 = dv.getUint16(entryOff + 4, false);
    const count = countMinus1 + 1;
    const refListOffFromTypeList = dv.getUint16(entryOff + 6, false);
    const refListStart = typeListStart + refListOffFromTypeList;
    for (let j = 0; j < count; j++) {
      const refOff = refListStart + j * 12;
      const id = dv.getInt16(refOff, false);
      const nameOffRaw = dv.getInt16(refOff + 2, false);
      const attrs = fork[refOff + 4];
      const dataOffsetFromDataStart =
        (fork[refOff + 5] << 16) | (fork[refOff + 6] << 8) | fork[refOff + 7];
      const resDataOff = dataOff + dataOffsetFromDataStart;
      if (resDataOff + 4 > fork.length) {
        throw new Error(
          `resource ${type} ${id}: data length prefix would overrun fork`,
        );
      }
      const dataLen = dv.getUint32(resDataOff, false);
      const dataStart = resDataOff + 4;
      if (dataStart + dataLen > fork.length) {
        throw new Error(
          `resource ${type} ${id}: data extends past fork (${dataStart}+${dataLen} > ${fork.length})`,
        );
      }
      let name = null;
      if (nameOffRaw !== -1 && nameListOffInMap !== 0xffff) {
        const namePOff = nameListStart + nameOffRaw;
        if (namePOff < fork.length) {
          const nameLen = fork[namePOff];
          if (namePOff + 1 + nameLen <= fork.length) {
            name = readMacRoman(fork, namePOff + 1, nameLen);
          }
        }
      }
      out.push({
        type,
        id,
        name,
        attrs,
        data: fork.subarray(dataStart, dataStart + dataLen),
      });
    }
  }
  return out;
}

// ── Encode ────────────────────────────────────────────────────────────
//
// Layout the output as:
//   [0..15]            Fork header
//   [16..255]          240 bytes of "system reserved" zero padding
//                       (matches what real classic Mac fork emitters use;
//                        ResEdit puts the data section at offset 256)
//   [256..256+D)       Data section (length-prefixed resources, concatenated)
//   [256+D..256+D+M)   Resource map
//
// We always pack names: any resource that has a non-null name goes into
// the name list, and its reference entry's nameOff field points at it.
// Unnamed resources get nameOff = -1.
//
/**
 * @param {DecodedResource[]} resources
 * @returns {Uint8Array}
 */
export function encodeResourceFork(resources) {
  if (resources.length === 0) return makeEmptyFork();

  // Group by type, preserving the order each type first appears.
  /** @type {Map<string, DecodedResource[]>} */
  const byType = new Map();
  for (const r of resources) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }
  const types = [...byType.keys()];
  const numTypes = types.length;

  // Build data section: concat (4-byte len + data) for each resource,
  // tracking each resource's offset within the section.
  /** @type {Map<DecodedResource, number>} */
  const dataOffsets = new Map();
  let dataLen = 0;
  for (const r of resources) {
    dataOffsets.set(r, dataLen);
    dataLen += 4 + r.data.length;
  }
  const dataSection = new Uint8Array(dataLen);
  const dataDv = new DataView(dataSection.buffer);
  for (const r of resources) {
    const off = dataOffsets.get(r);
    dataDv.setUint32(off, r.data.length, false);
    dataSection.set(r.data, off + 4);
  }

  // Build name list: concat Pascal strings of named resources, tracking
  // each one's offset within the name list.
  /** @type {Map<DecodedResource, number>} */
  const nameOffsets = new Map();
  let nameLen = 0;
  const nameChunks = [];
  for (const r of resources) {
    if (!r.name) continue;
    nameOffsets.set(r, nameLen);
    const nameBytes = writeMacRoman(r.name);
    const trimmed = nameBytes.length > 255 ? nameBytes.subarray(0, 255) : nameBytes;
    const chunk = new Uint8Array(1 + trimmed.length);
    chunk[0] = trimmed.length;
    chunk.set(trimmed, 1);
    nameChunks.push(chunk);
    nameLen += chunk.length;
  }
  const nameList = concatUint8Arrays(nameChunks);

  // Compute map structure offsets. Layout inside the map:
  //   [0..27]                    24 bytes reserved + 4 type/name list off + type count
  //   [28..29]                   numTypes-1 (also the start of the type list)
  //   [30..30+8*numTypes)        type entries
  //   [...)                      ref lists (12 bytes per resource), packed
  //   [...)                      name list
  const typeListOffInMap = 28; // numTypes-1 lives at 28; type entries at 30
  const typeListSize = 2 + 8 * numTypes; // 2 for numTypes-1 + 8 per type
  const refListsStart = typeListOffInMap + typeListSize;
  const refListSize = resources.length * 12;
  const nameListOffInMap = refListsStart + refListSize;
  const mapLen = nameListOffInMap + nameList.length;

  // Data offset within the fork: 256 (after 16-byte header + 240 bytes of
  // system reserved padding — convention from ResEdit).
  const dataOff = 256;
  const mapOff = dataOff + dataLen;
  const forkLen = mapOff + mapLen;
  const fork = new Uint8Array(forkLen);
  const dv = new DataView(fork.buffer);

  // Fork header
  dv.setUint32(0, dataOff, false);
  dv.setUint32(4, mapOff, false);
  dv.setUint32(8, dataLen, false);
  dv.setUint32(12, mapLen, false);
  // Bytes 16..255 are zero (system reserved + name list start), already zero-init.

  // Data section
  fork.set(dataSection, dataOff);

  // Map: bytes 0..23 are zeroed (header copy, handle, refnum, attrs).
  // Bytes 24..29 + the type/ref/name lists.
  dv.setUint16(mapOff + 24, typeListOffInMap, false);
  dv.setUint16(mapOff + 26, nameListOffInMap, false);
  dv.setUint16(mapOff + 28, numTypes - 1, false);

  // Type entries + ref lists. Ref lists are packed in type order.
  let refListCursorFromTypeList = typeListSize; // start of ref list = end of type-list block
  const typeEntriesStart = mapOff + typeListOffInMap + 2; // skip the 2-byte numTypes-1
  let resourceCursor = 0;
  for (let i = 0; i < numTypes; i++) {
    const type = types[i];
    const list = byType.get(type);
    const entryOff = typeEntriesStart + i * 8;
    // Write type (4 ASCII chars)
    for (let k = 0; k < 4; k++) {
      fork[entryOff + k] = type.charCodeAt(k);
    }
    dv.setUint16(entryOff + 4, list.length - 1, false); // count-1
    dv.setUint16(entryOff + 6, refListCursorFromTypeList, false);
    // Write the ref entries for this type at refListsStart + (resourceCursor*12)
    for (let j = 0; j < list.length; j++) {
      const r = list[j];
      const refOff = mapOff + refListsStart + resourceCursor * 12;
      dv.setInt16(refOff, r.id, false);
      const nameOff = nameOffsets.has(r) ? nameOffsets.get(r) : -1;
      dv.setInt16(refOff + 2, nameOff, false);
      fork[refOff + 4] = r.attrs;
      const off = dataOffsets.get(r);
      fork[refOff + 5] = (off >> 16) & 0xff;
      fork[refOff + 6] = (off >> 8) & 0xff;
      fork[refOff + 7] = off & 0xff;
      // Reserved 4 bytes left zero
      resourceCursor++;
    }
    refListCursorFromTypeList += list.length * 12;
  }

  // Name list
  if (nameList.length > 0) {
    fork.set(nameList, mapOff + nameListOffInMap);
  }

  return fork;
}

/** Empty fork: header pointing at zero-length data + a minimal map with
 *  numTypes-1 = 0xFFFF. Round-trips through decodeResourceFork as zero
 *  resources without throwing. */
function makeEmptyFork() {
  // Map layout: just the 30-byte preamble (header copy + handle + refnum +
  // attrs + typeListOff + nameListOff + numTypes-1).
  const mapLen = 30;
  const dataLen = 0;
  const dataOff = 256;
  const mapOff = dataOff + dataLen;
  const forkLen = mapOff + mapLen;
  const fork = new Uint8Array(forkLen);
  const dv = new DataView(fork.buffer);
  dv.setUint32(0, dataOff, false);
  dv.setUint32(4, mapOff, false);
  dv.setUint32(8, dataLen, false);
  dv.setUint32(12, mapLen, false);
  dv.setUint16(mapOff + 24, 28, false); // typeListOff: standard
  dv.setUint16(mapOff + 26, 30, false); // nameListOff: past the type-count word
  dv.setUint16(mapOff + 28, 0xffff, false); // numTypes-1: empty marker
  return fork;
}

// ── Tiny string helpers ──────────────────────────────────────────────
function readFourCC(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function readMacRoman(buf, off, len) {
  // ASCII subset is identical; we don't translate high bytes. For
  // resource names this is "good enough" — virtually all real-world
  // names are ASCII.
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

function writeMacRoman(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concatUint8Arrays(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
