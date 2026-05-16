/**
 * Regression guard for the SIZE-resource splice (cv-mac #64 follow-up).
 *
 * Without a SIZE resource, libretrocrt's Retro68Relocate faults at
 * startup with a type-3 illegal-instruction dialog — verified
 * empirically on the deployed playground (see LEARNINGS
 * "2026-05-15 — Missing SIZE resource crashes libretrocrt startup").
 *
 * This test confirms that the wasm-built binary's resource fork
 * contains a `SIZE` resource with id `-1` and the expected default
 * payload (10 bytes: flags 0x0080, 1 MB preferred + minimum heap).
 * Headless playwright can't observe the type-3 dialog, but it can
 * parse the resource fork structurally — which fails fast if the
 * splice ever regresses.
 */
import { test, expect } from "@playwright/test";

const HELLO_SOURCE = `int main(void) { return 0; }\n`;

test("compileToBin output carries a SIZE resource", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const sizeBytes = await page.evaluate(async (src) => {
    const cc1 = await import(
      /* @vite-ignore */ `${location.origin}/src/playground/cc1.ts`
    );
    const build = await import(
      /* @vite-ignore */ `${location.origin}/src/playground/build.ts`
    );
    const r = await cc1.compileToBin("/", {
      sources: [{ filename: "hello.c", content: src }],
    });
    if (!r.ok || !r.bin) throw new Error("compileToBin failed");
    const final = build.spliceResourceFork({
      dataForkBin: r.bin,
      resourceFork: build.makeRetro68DefaultSizeFork(),
    });

    // Parse the MacBinary's resource fork and find SIZE -1 bytes.
    // Tiny inline parser — mirrors `extract_codes` in
    // wasm-retro-cc/spike-pcc/inspect_macbinary.py.
    const dv = new DataView(final.buffer, final.byteOffset, final.byteLength);
    const dataLen = dv.getUint32(83, false);
    const rsrcLen = dv.getUint32(87, false);
    const rsrcStart = 128 + Math.ceil(dataLen / 128) * 128;
    const fork = final.subarray(rsrcStart, rsrcStart + rsrcLen);
    const fdv = new DataView(fork.buffer, fork.byteOffset, fork.byteLength);
    const dataOff = fdv.getUint32(0, false);
    const mapOff = fdv.getUint32(4, false);
    const typeListOff =
      mapOff + fdv.getUint16(mapOff + 24, false);
    const nTypes = (fdv.getUint16(typeListOff, false) + 1) & 0xffff;
    for (let i = 0; i < nTypes; i++) {
      const te = typeListOff + 2 + i * 8;
      const typeStr = String.fromCharCode(
        fork[te], fork[te + 1], fork[te + 2], fork[te + 3],
      );
      if (typeStr !== "SIZE") continue;
      const nRefs = fdv.getUint16(te + 4, false) + 1;
      const refListOff = typeListOff + fdv.getUint16(te + 6, false);
      for (let j = 0; j < nRefs; j++) {
        const re = refListOff + j * 12;
        const id = fdv.getInt16(re, false);
        const dOff =
          (fork[re + 5] << 16) | (fork[re + 6] << 8) | fork[re + 7];
        const dAbs = dataOff + dOff;
        const dSize = fdv.getUint32(dAbs, false);
        if (id === -1) {
          return {
            id,
            bytes: Array.from(fork.slice(dAbs + 4, dAbs + 4 + dSize)),
            binLen: final.byteLength,
          };
        }
      }
    }
    return { id: null, bytes: null, binLen: final.byteLength };
  }, HELLO_SOURCE);

  // The reference Retro68 default: flags 0x0080, pref 1 MB, min 1 MB.
  expect(sizeBytes.id).toBe(-1);
  expect(sizeBytes.bytes).toEqual([
    0x00, 0x80, 0x00, 0x10, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00,
  ]);
  // MacBinary pads forks to 128-byte boundaries; the ~50 bytes the
  // SIZE entry adds to the map fits in existing padding, so the file
  // length doesn't strictly grow. Just sanity-check shape is sane.
  expect(sizeBytes.binLen).toBeGreaterThanOrEqual(896);
});
