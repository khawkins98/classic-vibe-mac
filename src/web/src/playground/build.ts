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
 *   4. The base MacBinary comes from the in-browser C toolchain: cc1 →
 *      as → ld → Elf2Mac produce an in-memory MacBinary whose resource
 *      fork carries the m68k CODE / RELA / SIZE resources (the data fork
 *      is tiny or empty). What's MISSING from it is the user-defined
 *      resources from `.r` — upstream, Retro68's Rez adds those via the
 *      `--copy <code.bin>` flag in the CMake recipe. We do that on the JS
 *      side here.
 *   5. We do a real Mac resource fork MERGE: decode both forks (the
 *      Elf2Mac output's and the freshly compiled user fork), let the
 *      user's resources win on (type, id), and re-encode a fresh fork
 *      (resourceForkMerger.mjs — the single decoder/encoder/merger;
 *      the fork format is documented there). Reuse the Elf2Mac output's
 *      MacBinary header (Type/Creator/filename + window/folder bytes),
 *      patch the rsrc length, recompute CRC.
 *
 * The merged fork keeps the base fork's map attributes and puts the base's
 * types first in the type list; see resourceForkMerger.mjs for the exact
 * byte layout.
 */

import { mergeResourceForks } from "./resourceForkMerger.mjs";

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
  /** Base MacBinary with code resources in its resource fork (the
   *  in-memory Elf2Mac output from the C toolchain). */
  dataForkBin: Uint8Array;
  /** The freshly-compiled user resource fork (MacBinary-stripped, just
   *  the rfork bytes from rez.ts/extractResourceFork). */
  resourceFork: Uint8Array;
}

/**
 * Splice the user's freshly-compiled resource fork on top of the
 * base MacBinary (in-memory Elf2Mac output). Returns a complete new
 * MacBinary with merged resource fork + the base's data fork preserved.
 */
export function spliceResourceFork(opts: SpliceOptions): Uint8Array {
  const { dataForkBin, resourceFork } = opts;
  if (dataForkBin.length < HEADER_SIZE) {
    throw new Error(
      `base MacBinary is too small (${dataForkBin.length} B)`,
    );
  }

  const inDv = new DataView(
    dataForkBin.buffer,
    dataForkBin.byteOffset,
    dataForkBin.byteLength,
  );

  const inDataLen = inDv.getUint32(83, false);
  const inRsrcLen = inDv.getUint32(87, false);

  // Locate the base MacBinary's resource fork bytes. MacBinary lays out:
  //   header (128) + dataPad(dataLen) + rsrcPad(rsrcLen) + ...
  const dataStart = HEADER_SIZE;
  const rsrcStart = dataStart + padBytes(inDataLen);
  const codeRsrc = dataForkBin.subarray(rsrcStart, rsrcStart + inRsrcLen);

  // Merge. If the base has zero resource fork (unusual but possible
  // for stripped builds), the merged fork is just the user's.
  //
  // Base first so its types (CODE, RELA, SIZE, ...) keep their slot at
  // the front of the type list; `onConflict: "last"` makes the user's
  // fork win every (type, id) collision (Rez --copy semantics).
  const mergedRsrc =
    inRsrcLen === 0
      ? resourceFork
      : mergeResourceForks([codeRsrc, resourceFork], { onConflict: "last" });

  // Build output MacBinary: header (clone) + data fork (from base) +
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

