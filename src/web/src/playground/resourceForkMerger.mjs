/**
 * resourceForkMerger.mjs — the one Mac OS resource-fork decoder /
 * encoder / merger in the tree (#280 Path B, fork-composition gap).
 *
 * Callers:
 *   - build.ts `spliceResourceFork` — folds the user's wasm-rez fork
 *     onto the Elf2Mac-built fork (CODE / RELA / SIZE) on every build.
 *   - editor.ts `mergeUserForkWithPrecompiledAssets` — folds a
 *     project's precompiledForkAssets under the user's fork.
 *   - scripts/splice-bin.mjs — offline reproducer of the build.ts
 *     splice.
 *
 * Conflict policy is an explicit option, not an argument-order
 * convention: `mergeResourceForks(forks, { onConflict })` with
 * `"first"` (default: the earliest fork in the array wins a duplicate
 * `(type, id)`) or `"last"` (the latest fork wins). Array order also
 * fixes the output type order, so build.ts passes `[base, user]` with
 * `onConflict: "last"`: base types keep their position, user wins.
 * Whichever policy you pick, the rule is the same for a duplicate
 * `(type, id)` *inside* one fork as across forks.
 *
 * Until 2026-09 build.ts carried its own private two-fork merger with
 * the opposite (second-wins) precedence; see LEARNINGS "Two
 * resource-fork mergers". The encoder below reproduces that merger's
 * byte layout exactly so the consolidation didn't change a single
 * byte of any built app.
 *
 * Plain .mjs (no TS) so both Vite (browser-side) and Node (audit /
 * scripts tooling) can import without build steps. Sibling .d.mts
 * provides type hints for the TS side.
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
 * @typedef {Object} DecodedResourceFork
 * @property {number} mapAttrs            Resource-map attributes word
 *                                        (map+22: mapReadOnly etc.)
 * @property {DecodedResource[]} resources
 */

/**
 * Merge the input resource forks into a single fork.
 *
 * @param {Uint8Array[]} forks  Input forks. Array order decides the
 *                              output type order (types in first-seen
 *                              order) and, with `onConflict`, who wins.
 * @param {{ onConflict?: "first" | "last" }} [options]
 *   onConflict: which occurrence of a duplicate `(type, id)` survives.
 *   "first" (default) keeps the earliest; "last" keeps the latest. A
 *   winner takes over the loser's slot (name-list order), so the
 *   choice changes only which bytes survive, not the layout.
 * @returns {Uint8Array}        New resource fork. Its map attributes
 *                              are copied from forks[0].
 */
export function mergeResourceForks(forks, options = {}) {
  const onConflict = options.onConflict ?? "first";
  if (onConflict !== "first" && onConflict !== "last") {
    throw new Error(
      `mergeResourceForks: onConflict must be "first" or "last", got ${JSON.stringify(onConflict)}`,
    );
  }
  if (forks.length === 0) return encodeResourceFork([]);
  /** @type {Map<string, DecodedResource>} */
  const collected = new Map();
  let mapAttrs = 0;
  forks.forEach((fork, i) => {
    const decoded = decodeResourceForkMap(fork);
    if (i === 0) mapAttrs = decoded.mapAttrs;
    for (const r of decoded.resources) {
      const key = keyOf(r.type, r.id);
      // Map.set on an existing key keeps its insertion position, so a
      // "last" winner inherits the loser's slot.
      if (onConflict === "last" || !collected.has(key)) {
        collected.set(key, r);
      }
    }
  });
  return encodeResourceFork([...collected.values()], { mapAttrs });
}

function keyOf(type, id) {
  // Explicit separator: cheap and readable, and robust if a caller ever
  // hands us a non-4-char type.
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
//     0..15   copy of fork header (or zero)
//     16..19  next-map handle (zeroed on disk)
//     20..21  file refnum (zeroed on disk)
//     22..23  resource map attributes
//     24..25  offset (from map start) to type list
//     26..27  offset (from map start) to name list
//
//   Type list (at typeListOff; normally 28):
//     0..1    count of types MINUS 1 (0xFFFF means 0 types)
//     then 8 bytes per type:
//       0..3    type (4 ASCII chars)
//       4..5    count MINUS 1
//       6..7    offset to reference list (from type-list start)
//
//   Reference list entry (12 bytes per resource):
//     0..1    id (signed 16-bit)
//     2..3    offset to name (from name-list start); 0xFFFF = no name
//     4       attributes
//     5..7    offset to resource data (24-bit, from data section start)
//     8..11   reserved (handle in memory; zero on disk)
//
//   Name list entries: Pascal strings (1 length byte + bytes).
//
//   Resource data: at the data offset, 4-byte length prefix, then bytes.
//
/**
 * Decode a fork into its resources, in on-disk reference-list order.
 * A zero-length fork decodes as no resources (a MacBinary with no
 * resource fork hands us exactly that).
 *
 * @param {Uint8Array} fork
 * @returns {DecodedResource[]}
 */
export function decodeResourceFork(fork) {
  return decodeResourceForkMap(fork).resources;
}

/**
 * Like decodeResourceFork, but also returns the resource-map
 * attributes word so a re-encode can carry it through.
 *
 * @param {Uint8Array} fork
 * @returns {DecodedResourceFork}
 */
export function decodeResourceForkMap(fork) {
  if (fork.length === 0) return { mapAttrs: 0, resources: [] };
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
  const mapAttrs = dv.getUint16(mapOff + 22, false);
  const typeListOffInMap = dv.getUint16(mapOff + 24, false);
  const nameListOffInMap = dv.getUint16(mapOff + 26, false);
  const typeListStart = mapOff + typeListOffInMap;
  // The numTypes-1 word is the first field OF the type list, so read it
  // at typeListStart (not a hard-coded map+28): forks whose type list
  // offset isn't the canonical 28 would otherwise get a garbage count
  // while the entries below are (correctly) read relative to typeListStart.
  const numTypesMinus1 = dv.getUint16(typeListStart, false);
  const numTypes = numTypesMinus1 === 0xffff ? 0 : numTypesMinus1 + 1;
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
      // Unsigned: name offsets are 0..0xFFFE; 0xFFFF means unnamed.
      const nameOff = dv.getUint16(refOff + 2, false);
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
      if (nameOff !== 0xffff && nameListOffInMap !== 0xffff) {
        const namePOff = nameListStart + nameOff;
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
  return { mapAttrs, resources: out };
}

// ── Encode ────────────────────────────────────────────────────────────
//
// Canonical layout (byte-identical to the pre-consolidation build.ts
// merger, which every shipped app was built with):
//
//   [0..15]            Fork header
//   [16..255]          zero (system-reserved area; data starts at 256
//                       like ResEdit / the Resource Manager emit)
//   [256..256+D)       Data section: for each type (first-seen order),
//                       each resource in ascending-ID order: u32 len + bytes
//   [256+D..)          Resource map:
//                        0..15   copy of the fork header
//                        16..21  zero (next-map handle, refnum)
//                        22..23  map attributes (options.mapAttrs)
//                        24..25  type list offset = 28
//                        26..27  name list offset
//                        28..29  numTypes-1 (0xFFFF when empty)
//                        30..    type entries, then ref lists (packed,
//                                same order as the data section), then
//                                the name list
//
// Types appear in the order they first occur in `resources`; within a
// type, resources are stably sorted by ID (Mac convention, and what
// GetIndResource then walks). The name list is written in `resources`
// input order. No padding / alignment anywhere: resource data is
// packed back to back.
//
/**
 * @param {DecodedResource[]} resources  No duplicate `(type, id)`s.
 * @param {{ mapAttrs?: number }} [options]
 * @returns {Uint8Array}
 */
export function encodeResourceFork(resources, options = {}) {
  const mapAttrs = options.mapAttrs ?? 0;

  // Group by type, preserving the order each type first appears, then
  // sort each group by ID (Array.prototype.sort is stable).
  /** @type {Map<string, DecodedResource[]>} */
  const byType = new Map();
  for (const r of resources) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type).push(r);
  }
  for (const list of byType.values()) list.sort((x, y) => x.id - y.id);
  const types = [...byType.keys()];
  const numTypes = types.length;

  // Data section offsets, in type-then-ID order.
  /** @type {Map<DecodedResource, number>} */
  const dataOffsets = new Map();
  let dataLen = 0;
  for (const list of byType.values()) {
    for (const r of list) {
      dataOffsets.set(r, dataLen);
      dataLen += 4 + r.data.length;
    }
  }

  // Name list, in input order. A name of "" is still a (zero-length)
  // name; only null/undefined means unnamed.
  /** @type {Map<DecodedResource, number>} */
  const nameOffsets = new Map();
  /** @type {Uint8Array[]} */
  const nameChunks = [];
  let nameLen = 0;
  for (const r of resources) {
    if (r.name === null || r.name === undefined) continue;
    nameOffsets.set(r, nameLen);
    const nameBytes = writeMacRoman(r.name);
    const trimmed = nameBytes.length > 255 ? nameBytes.subarray(0, 255) : nameBytes;
    const chunk = new Uint8Array(1 + trimmed.length);
    chunk[0] = trimmed.length;
    chunk.set(trimmed, 1);
    nameChunks.push(chunk);
    nameLen += chunk.length;
  }

  const typeListOffInMap = 28;
  const typeListSize = 2 + 8 * numTypes; // numTypes-1 word + entries
  const refListsStart = typeListOffInMap + typeListSize;
  const nameListOffInMap = refListsStart + resources.length * 12;
  const mapLen = nameListOffInMap + nameLen;

  const dataOff = 256;
  const mapOff = dataOff + dataLen;
  const fork = new Uint8Array(mapOff + mapLen);
  const dv = new DataView(fork.buffer);

  // Fork header.
  dv.setUint32(0, dataOff, false);
  dv.setUint32(4, mapOff, false);
  dv.setUint32(8, dataLen, false);
  dv.setUint32(12, mapLen, false);

  // Data section.
  for (const [r, off] of dataOffsets) {
    dv.setUint32(dataOff + off, r.data.length, false);
    fork.set(r.data, dataOff + off + 4);
  }

  // Map header: copy of the fork header (Resource Manager convention),
  // then attrs + list offsets.
  fork.copyWithin(mapOff, 0, 16);
  dv.setUint16(mapOff + 22, mapAttrs, false);
  dv.setUint16(mapOff + 24, typeListOffInMap, false);
  dv.setUint16(mapOff + 26, nameListOffInMap, false);
  dv.setUint16(mapOff + 28, numTypes === 0 ? 0xffff : numTypes - 1, false);

  // Type entries + ref lists. Ref-list offsets are relative to the start
  // of the type list (the numTypes-1 word).
  let refListOffFromTypeList = typeListSize;
  let refOff = mapOff + refListsStart;
  for (let i = 0; i < numTypes; i++) {
    const type = types[i];
    const list = byType.get(type);
    const entryOff = mapOff + typeListOffInMap + 2 + i * 8;
    for (let k = 0; k < 4; k++) fork[entryOff + k] = type.charCodeAt(k) & 0xff;
    dv.setUint16(entryOff + 4, list.length - 1, false);
    dv.setUint16(entryOff + 6, refListOffFromTypeList, false);
    refListOffFromTypeList += list.length * 12;
    for (const r of list) {
      dv.setInt16(refOff, r.id, false);
      dv.setUint16(refOff + 2, nameOffsets.has(r) ? nameOffsets.get(r) : 0xffff, false);
      fork[refOff + 4] = r.attrs;
      const off = dataOffsets.get(r);
      fork[refOff + 5] = (off >> 16) & 0xff;
      fork[refOff + 6] = (off >> 8) & 0xff;
      fork[refOff + 7] = off & 0xff;
      // bytes 8..11: reserved handle, left zero.
      refOff += 12;
    }
  }

  // Name list.
  let nlOff = mapOff + nameListOffInMap;
  for (const c of nameChunks) {
    fork.set(c, nlOff);
    nlOff += c.length;
  }

  return fork;
}

// ── Tiny string helpers ──────────────────────────────────────────────
function readFourCC(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function readMacRoman(buf, off, len) {
  // ASCII subset is identical; we don't translate high bytes. For
  // resource names this is "good enough" — virtually all real-world
  // names are ASCII, and byte-for-byte round-trip is what matters.
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

function writeMacRoman(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
