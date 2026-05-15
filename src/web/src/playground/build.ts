/**
 * build.ts — MacBinary splice + Mac resource fork merge for the
 * playground's Build button.
 *
 * Track 7 of Issue #30. The end-to-end build flow:
 *
 *   1. User clicks Build.
 *   2. We preprocess the user's <project>.r through preprocessor.ts (with
 *      the IDB-VFS bridge for #include resolution).
 *   3. We compile the preprocessed source through wasm-rez (rez.ts), which
 *      yields a MacBinary `*.bin` containing only the user's resource
 *      fork (MENU, WIND, DITL, ALRT, STR#, vers, SIZE, ...).
 *   4. We fetch the precompiled `*.code.bin` from
 *      /precompiled/<id>.code.bin — that's the MacBinary CMake's
 *      Retro68 add_application macro emits as a side artefact alongside
 *      the final `.bin`. Despite the name, .code.bin is RESOURCE-fork
 *      heavy (data fork ≈ 20 bytes of CFM stub; resource fork ≈ 20 KB
 *      of m68k CODE / cfrg / SIZE-from-toolchain / etc.). What's MISSING
 *      from .code.bin is the user-defined resources from `.r` — those
 *      get appended by Retro68's Rez via the `--copy <code.bin>` flag in
 *      the upstream CMake recipe. We do that copy on the JS side here.
 *   5. We do a real Mac resource fork MERGE: parse both forks (the .code.bin's
 *      and the freshly compiled user fork), concatenate the data sections
 *      and the type/ref/name lists with offset patch-ups, write a new
 *      resource fork. Reuse the .code.bin's MacBinary header
 *      (Type/Creator/filename + window/folder bytes), patch the rsrc
 *      length, recompute CRC.
 *
 * Resource fork format reference: Inside Macintosh: More Macintosh Toolbox,
 * "The Resource Manager", section "Format of a Resource Fork". We use
 * the classic structure (16-byte header, data section, map section). All
 * multi-byte ints are big-endian.
 *
 *   Header (16 bytes at offset 0 of the fork):
 *     u32 dataOffset    offset of resource-data area
 *     u32 mapOffset     offset of resource map
 *     u32 dataLength    length of data area
 *     u32 mapLength     length of map
 *
 *   Resource data area: each entry = u32 size + size bytes. Resource ID
 *   pointers (in the map) are byte-offsets into this area, so to merge
 *   two forks we re-emit data area B's bytes at a new base address and
 *   patch every refList entry pointing into B.
 *
 *   Map (at mapOffset):
 *     bytes  0..15       reserved (copy of header in MacOS' impl, 0 OK)
 *     bytes 16..21       reserved (handle to next map; offset to file ref)
 *     u16 attrs          resource fork attributes (we preserve from .code.bin)
 *     u16 typeListOff    offset of type list, relative to mapOffset
 *     u16 nameListOff    offset of name list, relative to mapOffset
 *     u16 typeCount-1    count - 1 (or 0xFFFF if zero types)
 *     [TypeListEntry]    each: u32 type + u16 count-1 + u16 refListOff (rel to typeListOff start)
 *     [RefListEntry]     each: i16 id + u16 nameOff (relative to nameListOff or 0xFFFF) + u8 attrs + u24 dataOff (into data area) + u32 reserved (handle, 0)
 *     [name list]        each: pstring (u8 len + bytes)
 */

/** CRC16-CCITT polynomial 0x1021, init 0x0000, no reflection. The
 *  classic MacBinary CRC: same one used by Retro68's BinaryIO.cc on the
 *  writer side. Matches reference vectors in
 *  http://files.stairways.com/other/macbinaryii-standard-info.txt . */
function crc16Ccitt(bytes: Uint8Array, len: number): number {
  let crc = 0;
  for (let i = 0; i < len; i++) {
    crc ^= (bytes[i]! << 8) & 0xffff;
    for (let b = 0; b < 8; b++) {
      if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xffff;
      else crc = (crc << 1) & 0xffff;
    }
  }
  return crc;
}

const HEADER_SIZE = 128;
const PAD_TO = 128;

function padBytes(len: number): number {
  return Math.ceil(len / PAD_TO) * PAD_TO;
}

export interface SpliceOptions {
  /** Precompiled MacBinary with code resources in its resource fork
   *  (from /precompiled/<id>.code.bin). */
  dataForkBin: Uint8Array;
  /** The freshly-compiled user resource fork (MacBinary-stripped, just
   *  the rfork bytes from rez.ts/extractResourceFork). */
  resourceFork: Uint8Array;
}

/**
 * Splice the user's freshly-compiled resource fork on top of the
 * precompiled .code.bin. Returns a complete new MacBinary with merged
 * resource fork + the .code.bin's data fork preserved.
 */
export function spliceResourceFork(opts: SpliceOptions): Uint8Array {
  const { dataForkBin, resourceFork } = opts;
  if (dataForkBin.length < HEADER_SIZE) {
    throw new Error(
      `precompiled .code.bin is too small (${dataForkBin.length} B)`,
    );
  }

  const inDv = new DataView(
    dataForkBin.buffer,
    dataForkBin.byteOffset,
    dataForkBin.byteLength,
  );

  const inDataLen = inDv.getUint32(83, false);
  const inRsrcLen = inDv.getUint32(87, false);

  // Locate the .code.bin's resource fork bytes. MacBinary lays out:
  //   header (128) + dataPad(dataLen) + rsrcPad(rsrcLen) + ...
  const dataStart = HEADER_SIZE;
  const rsrcStart = dataStart + padBytes(inDataLen);
  const codeRsrc = dataForkBin.subarray(rsrcStart, rsrcStart + inRsrcLen);

  // Merge. If .code.bin has zero resource fork (unusual but possible
  // for stripped builds), the merged fork is just the user's.
  const mergedRsrc =
    inRsrcLen === 0
      ? resourceFork
      : mergeResourceForks(codeRsrc, resourceFork);

  // Build output MacBinary: header (clone) + data fork (from .code.bin) +
  // merged resource fork.
  const outDataPadLen = padBytes(inDataLen);
  const outRsrcPadLen = padBytes(mergedRsrc.length);
  const outLen = HEADER_SIZE + outDataPadLen + outRsrcPadLen;
  const out = new Uint8Array(outLen);
  // Header.
  out.set(dataForkBin.subarray(0, HEADER_SIZE), 0);
  // Data fork (preserve including padding from input).
  if (inDataLen > 0) {
    out.set(dataForkBin.subarray(dataStart, dataStart + inDataLen), HEADER_SIZE);
  }
  // Merged resource fork.
  out.set(mergedRsrc, HEADER_SIZE + outDataPadLen);

  // Patch header: rsrc length, mod time, CRC.
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  outDv.setUint32(87, mergedRsrc.length, false);
  // Bump modification time. Mac epoch = 1904-01-01 00:00:00 UTC =
  // unix timestamp - 2082844800.
  const macEpoch = Math.floor(Date.now() / 1000) + 2082844800;
  outDv.setUint32(95, macEpoch, false);
  // Recompute CRC over header[0..124).
  const crc = crc16Ccitt(out, 124);
  outDv.setUint16(124, crc, false);

  return out;
}

// ── Resource fork merge ─────────────────────────────────────────────────
//
// Approach: parse both inputs into (resources[], dataAreaBytes), then
// concatenate. We pick fork B (the user's) to override fork A (the
// .code.bin's) on (type, id) collisions — this matches Rez's --copy
// semantics: the user's .r definitions win.
//
// We don't re-implement attribute / handle preservation in full fidelity;
// we copy the per-resource attribute byte through, and emit zero for the
// reserved handle field (which the Resource Manager always overwrites
// at runtime anyway).

interface ParsedResource {
  type: number; // u32 type code
  id: number; // signed 16
  attrs: number; // u8 attrs
  name: string | null; // optional name
  data: Uint8Array; // resource body bytes
}

interface ParsedFork {
  attrs: number; // map header attrs (u16)
  resources: ParsedResource[];
}

function parseResourceFork(rfork: Uint8Array): ParsedFork {
  if (rfork.length < 16) return { attrs: 0, resources: [] };
  const dv = new DataView(rfork.buffer, rfork.byteOffset, rfork.byteLength);
  const dataOffset = dv.getUint32(0, false);
  const mapOffset = dv.getUint32(4, false);
  // dataLen at offset 8 is read for sanity but not needed since each
  // resource has its own length prefix in the data area.
  const mapLen = dv.getUint32(12, false);
  if (mapOffset + mapLen > rfork.length) {
    throw new Error("resource fork: map extends past end");
  }
  // Map header is 28 bytes; first 16 are reserved (or copy of fork header),
  // next 4 are reserved (handle to next map + file ref num), then we get
  // the fields we need at +24..+27.
  const attrs = dv.getUint16(mapOffset + 22, false);
  const typeListOffRel = dv.getUint16(mapOffset + 24, false);
  const nameListOffRel = dv.getUint16(mapOffset + 26, false);
  const typeListAbs = mapOffset + typeListOffRel;
  const nameListAbs = mapOffset + nameListOffRel;
  // First u16 of type list = count - 1 (0xFFFF if no types).
  const typeCountM1 = dv.getUint16(typeListAbs, false);
  const typeCount = typeCountM1 === 0xffff ? 0 : typeCountM1 + 1;

  const out: ParsedResource[] = [];
  for (let i = 0; i < typeCount; i++) {
    const teOff = typeListAbs + 2 + i * 8;
    const type = dv.getUint32(teOff, false);
    const refCount = dv.getUint16(teOff + 4, false) + 1;
    const refListOffRel = dv.getUint16(teOff + 6, false);
    const refListAbs = typeListAbs + refListOffRel;
    for (let j = 0; j < refCount; j++) {
      const reOff = refListAbs + j * 12;
      const id = dv.getInt16(reOff, false);
      const nameOff = dv.getUint16(reOff + 2, false);
      const refAttrs = dv.getUint8(reOff + 4);
      // 24-bit big-endian data offset.
      const dataOffRel =
        (dv.getUint8(reOff + 5) << 16) |
        (dv.getUint8(reOff + 6) << 8) |
        dv.getUint8(reOff + 7);
      const dataAbs = dataOffset + dataOffRel;
      const dataSize = dv.getUint32(dataAbs, false);
      let name: string | null = null;
      if (nameOff !== 0xffff) {
        const nameAbs = nameListAbs + nameOff;
        const nameLen = dv.getUint8(nameAbs);
        const nameBytes = rfork.subarray(nameAbs + 1, nameAbs + 1 + nameLen);
        // MacRoman strict ASCII subset suffices for our apps' resource
        // names; byte-equal copy is fine because we'll re-emit verbatim.
        name = String.fromCharCode(...Array.from(nameBytes));
      }
      out.push({
        type,
        id,
        attrs: refAttrs,
        name,
        data: rfork.slice(dataAbs + 4, dataAbs + 4 + dataSize),
      });
    }
  }
  return { attrs, resources: out };
}

/**
 * Merge two parsed resource forks into a single fresh resource fork.
 * Resources from `forkB` (the user's freshly compiled .r output) override
 * resources from `forkA` (the .code.bin's CODE etc) on (type, id) collision.
 *
 * Output bytes layout — we always emit canonical:
 *   data area starts at offset 256 (Resource Manager's `kResourceForkHeaderSize`)
 *   map immediately follows the data area
 */
function mergeResourceForks(a: Uint8Array, b: Uint8Array): Uint8Array {
  const A = parseResourceFork(a);
  const B = parseResourceFork(b);
  const merged = new Map<string, ParsedResource>();
  const key = (r: ParsedResource) => `${r.type}:${r.id}`;
  for (const r of A.resources) merged.set(key(r), r);
  for (const r of B.resources) merged.set(key(r), r); // user wins
  const all = Array.from(merged.values());
  // Group by type. Order types by their first-seen order in (A then B)
  // to keep diffs against reference output minimal.
  const typeOrder: number[] = [];
  const seenType = new Set<number>();
  for (const r of A.resources) {
    if (!seenType.has(r.type)) {
      typeOrder.push(r.type);
      seenType.add(r.type);
    }
  }
  for (const r of B.resources) {
    if (!seenType.has(r.type)) {
      typeOrder.push(r.type);
      seenType.add(r.type);
    }
  }
  const byType = new Map<number, ParsedResource[]>();
  for (const t of typeOrder) byType.set(t, []);
  for (const r of all) byType.get(r.type)!.push(r);
  // Sort each type's resources by ID (stable, ascending) — Mac convention.
  for (const list of byType.values()) list.sort((x, y) => x.id - y.id);

  // ── Compute byte layout ─────────────────────────────────────────────
  //
  // Data area: each resource = u32 size + bytes. We track each resource's
  // dataOffRel as we walk.
  const dataChunks: Uint8Array[] = [];
  let dataLen = 0;
  const resOffsets = new Map<ParsedResource, number>();
  for (const t of typeOrder) {
    for (const r of byType.get(t)!) {
      resOffsets.set(r, dataLen);
      const lenBuf = new Uint8Array(4);
      new DataView(lenBuf.buffer).setUint32(0, r.data.length, false);
      dataChunks.push(lenBuf);
      dataChunks.push(r.data);
      dataLen += 4 + r.data.length;
    }
  }
  // Name list: only resources with names get an entry; we record offset.
  const nameChunks: Uint8Array[] = [];
  let nameLen = 0;
  const nameOffsets = new Map<ParsedResource, number>();
  for (const r of all) {
    if (r.name === null) continue;
    nameOffsets.set(r, nameLen);
    const buf = new Uint8Array(1 + r.name.length);
    buf[0] = r.name.length;
    for (let i = 0; i < r.name.length; i++) buf[1 + i] = r.name.charCodeAt(i) & 0xff;
    nameChunks.push(buf);
    nameLen += buf.length;
  }
  // Type list size = 2 (count-1) + 8 * typeCount
  const typeCount = typeOrder.length;
  const typeListSize = 2 + 8 * typeCount;
  // Ref list size = 12 * total resource count
  const refListSize = 12 * all.length;
  // Map size = 24 (header) + typeListSize + refListSize + nameLen
  const MAP_HDR = 28;
  const mapSize = MAP_HDR + typeListSize + refListSize + nameLen;

  // Layout in fork: header(16) + data(dataLen) + map(mapSize)
  const dataOffset = 256; // Resource Manager canonical offset
  const mapOffset = dataOffset + dataLen;
  const forkLen = mapOffset + mapSize;

  const out = new Uint8Array(forkLen);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  // Fork header.
  dv.setUint32(0, dataOffset, false);
  dv.setUint32(4, mapOffset, false);
  dv.setUint32(8, dataLen, false);
  dv.setUint32(12, mapSize, false);
  // Resource Manager copies the fork header into bytes 16..127 of the
  // first chunk in real-world forks; we leave those zeroed (and the
  // 256-byte reserved gap before data is also zero), which Rez and the
  // Resource Manager both accept on read.

  // Data area.
  let off = dataOffset;
  for (const c of dataChunks) {
    out.set(c, off);
    off += c.length;
  }

  // Map.
  // Bytes 0..15: copy of fork header (Resource Manager convention; not
  //   strictly required for Rez to read but matches reference output).
  // Bytes 16..21: 6 reserved (handle to next map + file ref num).
  // Byte 22..23: attrs.
  // Byte 24..25: type list offset (relative to map start).
  // Byte 26..27: name list offset (relative to map start).
  for (let i = 0; i < 16; i++) out[mapOffset + i] = out[i]!;
  // 16..21 stay zero.
  dv.setUint16(mapOffset + 22, A.attrs, false);
  // Resource fork map layout note: Inside Macintosh defines the type list
  // offset as the byte offset (relative to map start) of the first byte
  // of the type list — i.e. of the count-1 word. We use 28 below.
  // the u16 count-1 and the 8-byte entries follow. The "type list
  // offset" stored in the map is conventionally MAP_HDR-2 = 26 so the
  // count-1 word lives at exactly MAP_HDR-2 from map start when the
  // map header is 28 bytes. Tradition / Inside Mac says: typeList
  // offset = 28 ("offset to type list"). We follow Inside Mac:
  const tlOffRel = 28;
  dv.setUint16(mapOffset + 24, tlOffRel, false);
  const nameListOffRel = MAP_HDR + typeListSize + refListSize;
  dv.setUint16(mapOffset + 26, nameListOffRel, false);
  // Now: typeCount-1 at mapOffset + tlOffRel - 2 = mapOffset + 26 — but
  // that's the same byte we already wrote nameListOffRel into. There's
  // an edge in the spec: the count-1 is at the BEGINNING of the type
  // list (typeListOffRel points TO it), and Inside Mac shows the type
  // list offset as 28 with the word AT 28..29 being count-1. So we
  // don't have a conflict: typeListOff(26-27)=28; count-1 at 28-29;
  // entries at 30..; nameList at MAP_HDR+typeListSize+refListSize.
  dv.setUint16(mapOffset + tlOffRel, typeCount === 0 ? 0xffff : typeCount - 1, false);
  // Type entries.
  let teOff = mapOffset + tlOffRel + 2;
  // Ref list offset is RELATIVE to start of type list (i.e. relative to
  // mapOffset + tlOffRel), not absolute.
  let refListOffRel = typeListSize; // first ref list begins right after the entire type list block
  for (const t of typeOrder) {
    const list = byType.get(t)!;
    dv.setUint32(teOff, t, false);
    dv.setUint16(teOff + 4, list.length - 1, false);
    dv.setUint16(teOff + 6, refListOffRel, false);
    teOff += 8;
    refListOffRel += list.length * 12;
  }
  // Ref entries.
  let reOff = mapOffset + tlOffRel + typeListSize;
  for (const t of typeOrder) {
    const list = byType.get(t)!;
    for (const r of list) {
      dv.setInt16(reOff, r.id, false);
      const nameOff = r.name === null ? 0xffff : nameOffsets.get(r)!;
      dv.setUint16(reOff + 2, nameOff, false);
      out[reOff + 4] = r.attrs;
      const doff = resOffsets.get(r)!;
      out[reOff + 5] = (doff >> 16) & 0xff;
      out[reOff + 6] = (doff >> 8) & 0xff;
      out[reOff + 7] = doff & 0xff;
      // bytes 8..11: reserved handle, leave zero.
      reOff += 12;
    }
  }
  // Name list.
  let nlOff = mapOffset + nameListOffRel;
  for (const c of nameChunks) {
    out.set(c, nlOff);
    nlOff += c.length;
  }
  return out;
}

/**
 * Trigger a browser download for `bytes`. Inert in non-browser test
 * environments (where `document` is undefined).
 */
export function triggerDownload(bytes: Uint8Array, filename: string): void {
  // Slice into a fresh ArrayBuffer-backed Uint8Array because Blob
  // requires an ArrayBuffer view in some browsers and our `bytes` may
  // originate from Emscripten heap.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/**
 * Build a minimal resource fork containing exactly one resource:
 * `SIZE` id `-1` with the Retro68 reference's default payload (flags
 * `0x0080`, preferred + minimum heap both 1 MB). Designed to be passed
 * as the `resourceFork` argument to `spliceResourceFork`, which merges
 * it onto a MacBinary's existing resource fork.
 *
 * Why we need this for in-browser-built `.c` apps (cv-mac #64): without
 * a `SIZE` resource the Mac OS Process Manager allocates the app a
 * tiny default heap. libretrocrt's `Retro68Relocate` runs at app entry
 * to fix up globals at load time; on the tiny default heap it runs out
 * of room and faults with type-3 (illegal instruction) before `main()`
 * is ever called. Symptom on screen: app launches, immediately quits
 * with a "type 3" dialog — verified empirically on deployed Pages
 * with `int main(){ return 0; }` source.
 *
 * The Retro68 reference build (`hello-toolbox-retro68.bin`) ships a
 * SIZE resource generated by Rez from a project `.r` file via the
 * CMake `add_application` macro. Our wasm pipeline doesn't run Rez for
 * `rezFile === null` projects, so we splice a default SIZE in JS-land
 * after `compileToBin` returns.
 *
 * 320 bytes total — that's the minimum resource fork (header 16 +
 * 240 padding to canonical dataOffset=256 + data 14 + map 50).
 *
 * Resource fork format reference: Inside Macintosh: More Macintosh
 * Toolbox, "The Resource Manager", "Format of a Resource Fork". All
 * multi-byte ints are big-endian.
 */
const RETRO68_DEFAULT_SIZE_PAYLOAD = new Uint8Array([
  // flags = 0x0080 — saveScreen | reserved.
  0x00, 0x80,
  // preferred memory size = 0x00100000 = 1 MB.
  0x00, 0x10, 0x00, 0x00,
  // minimum memory size = 0x00100000 = 1 MB.
  0x00, 0x10, 0x00, 0x00,
]);

export function makeRetro68DefaultSizeFork(): Uint8Array {
  const FORK_LEN = 320;
  const DATA_OFFSET = 256; // Resource Manager's canonical kResourceForkHeaderSize.
  const DATA_LENGTH = 14; // 4-byte size + 10-byte SIZE payload.
  const MAP_OFFSET = DATA_OFFSET + DATA_LENGTH; // 270.
  const MAP_LENGTH = 50; // 28 (header) + 2 (count) + 8 (type entry) + 12 (ref entry).

  const fork = new Uint8Array(FORK_LEN);
  const dv = new DataView(fork.buffer);

  // Fork header.
  dv.setUint32(0, DATA_OFFSET, false);
  dv.setUint32(4, MAP_OFFSET, false);
  dv.setUint32(8, DATA_LENGTH, false);
  dv.setUint32(12, MAP_LENGTH, false);
  // Bytes 16..255 stay zero (padding to the canonical data offset).

  // Resource data: u32 size + 10-byte payload.
  dv.setUint32(DATA_OFFSET, 10, false);
  fork.set(RETRO68_DEFAULT_SIZE_PAYLOAD, DATA_OFFSET + 4);

  // Map header (28 bytes at MAP_OFFSET). We leave the first 22 bytes
  // as zeros (16-byte header copy + 6-byte reserved). The Resource
  // Manager / parseResourceFork only reads:
  //   - byte 22..23: attrs
  //   - byte 24..25: type list offset (relative to map start)
  //   - byte 26..27: name list offset (relative to map start)
  dv.setUint16(MAP_OFFSET + 24, 28, false); // type list at map+28
  dv.setUint16(MAP_OFFSET + 26, 50, false); // name list at map+50 (empty)

  // Type list at MAP_OFFSET + 28.
  const typeListAbs = MAP_OFFSET + 28;
  dv.setUint16(typeListAbs, 0, false); // typeCount - 1 = 0 (one type).
  // 8-byte type entry: 'SIZE', refCount - 1 = 0, refListOff = 10 (rel
  // to type list start; points past the 2-byte count + 8-byte type
  // entry to the first ref entry).
  fork.set([0x53, 0x49, 0x5a, 0x45], typeListAbs + 2); // 'SIZE'
  dv.setUint16(typeListAbs + 6, 0, false); // refCount - 1 = 0.
  dv.setUint16(typeListAbs + 8, 10, false); // refList offset.

  // Ref list at typeListAbs + 10 = MAP_OFFSET + 38.
  const refAbs = typeListAbs + 10;
  dv.setInt16(refAbs, -1, false); // id = -1.
  dv.setUint16(refAbs + 2, 0xffff, false); // name offset = none.
  fork[refAbs + 4] = 0; // attrs = 0.
  // 24-bit data offset (relative to data area) = 0.
  fork[refAbs + 5] = 0;
  fork[refAbs + 6] = 0;
  fork[refAbs + 7] = 0;
  // bytes 8..11: reserved handle, leave zero.

  return fork;
}

/** Fetch the precompiled `<projectId>.code.bin` static asset that the CI
 *  build emits. Returns the raw bytes. Throws on 404 or network failure
 *  with a message the playground UI can display. */
export async function fetchPrecompiled(
  baseUrl: string,
  projectId: string,
): Promise<Uint8Array> {
  const url = `${baseUrl}precompiled/${projectId}.code.bin`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `precompiled .code.bin not available (${res.status}). ` +
        `The CI build emits these into public/precompiled/ — if you're ` +
        `running locally without a CI build, run \`npm run build\` after ` +
        `\`cmake --build build\`.`,
    );
  }
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}
