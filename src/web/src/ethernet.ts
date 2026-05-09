/**
 * ethernet.ts — SPSC ring buffer for Ethernet frame delivery.
 *
 * This module is **pure** (no DOM or Web Worker globals) so it can be safely
 * imported from both the main thread and the emulator worker.
 *
 * Architecture overview:
 *
 *   ┌─ Main thread ──────────────────────────────────────────────────────┐
 *   │  EthernetZoneProvider (ethernet-provider.ts)                       │
 *   │    ↕ WebSocket (JSON)                                              │
 *   │  Cloudflare Durable Object (worker/ethernet-zone.ts)               │
 *   │    ↕ WebSocket (JSON) ← other zone visitors                        │
 *   │                                                                     │
 *   │  rbPush(rxSab, frame)  ←── received frames                         │
 *   └─────────────────────────────────────────────────────────────────────┘
 *                    SharedArrayBuffer (rxSab)
 *   ┌─ Worker thread ─────────────────────────────────────────────────────┐
 *   │  etherRead(ptr, max) → rbPop(rxSab, buf) → copy into WASM heap     │
 *   │  etherWrite(dest, ptr, len) → postMessage({ ethernet_frame })       │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * TX path (Mac → network):
 *   BasiliskII calls etherWrite() in the worker. The worker copies the frame
 *   from the WASM heap, then postMessages an `ethernet_frame` event to the
 *   main thread. The main thread's EthernetZoneProvider forwards it via
 *   WebSocket to the zone relay.
 *
 * RX path (network → Mac):
 *   WebSocket `message` events arrive on the main thread. EthernetZoneProvider
 *   calls rbPush() to enqueue the frame in the SAB ring buffer, then calls
 *   signalEthernetInterrupt() (from emulator-input.ts) to wake BasiliskII.
 *   The worker's etherRead() (called by BasiliskII's ethernet driver) drains
 *   the ring via rbPop() and writes the frame into the WASM heap.
 *
 * SPSC ring buffer design:
 *   - Single producer: main thread only (WebSocket onmessage handler)
 *   - Single consumer: worker thread only (BasiliskII's etherRead)
 *   - Lock-free: producer writes data then Atomics.add(write_count);
 *     consumer reads Atomics.load(write_count) first, then data, then
 *     Atomics.add(read_count). The Atomics operations have sequentially-
 *     consistent ordering, so all data stores preceding the counter
 *     increment are guaranteed visible to the other thread.
 *   - Unsigned sequence arithmetic: counters are Int32 in memory but
 *     coerced with `>>> 0` before comparison so they wrap safely at 2^32.
 *
 * License: Apache-2.0. Adapted from mihaip/infinite-mac.
 */

// ── Ring buffer constants ─────────────────────────────────────────────

/** Number of frame slots. Must be a power of 2 (for the bitmask trick). */
export const NUM_SLOTS = 16;

/** Maximum Ethernet frame size: 14-byte header + 1500-byte payload. */
export const MAX_FRAME = 1514;

/** Bytes per slot: 2-byte length prefix + frame data. */
export const SLOT_BYTES = 2 + MAX_FRAME; // 1516

/** Bytes for the two Int32 header fields (write_count, read_count). */
export const HEADER_BYTES = 8;

/** Total SharedArrayBuffer size for the RX ring. ~24.3 KB. */
export const ETHERNET_RX_SAB_SIZE = HEADER_BYTES + NUM_SLOTS * SLOT_BYTES;

/** Slot index mask — fast modulo for power-of-2 NUM_SLOTS. */
const SLOT_MASK = NUM_SLOTS - 1;

// SAB Int32 header layout:
//   [0]: write_count — number of frames written (producer only)
//   [1]: read_count  — number of frames read    (consumer only)
//
// Slot layout (starting at HEADER_BYTES):
//   [off + 0]: high byte of frame length (uint16, big-endian)
//   [off + 1]: low  byte of frame length
//   [off + 2 .. off + SLOT_BYTES - 1]: frame bytes

/**
 * Push one Ethernet frame into the ring buffer.
 * Called from the **main thread** only.
 *
 * Returns `true` if the frame was enqueued, `false` if the ring is full
 * or the frame exceeds MAX_FRAME (frame is silently dropped).
 */
export function rbPush(sab: SharedArrayBuffer, frame: Uint8Array): boolean {
  if (frame.byteLength > MAX_FRAME) return false; // drop oversized
  const header = new Int32Array(sab);
  const data = new Uint8Array(sab, HEADER_BYTES);
  // Coerce to unsigned so subtraction and comparison wrap correctly at 2^32.
  const write = Atomics.load(header, 0) >>> 0;
  const read = Atomics.load(header, 1) >>> 0;
  if (((write - read) >>> 0) >= NUM_SLOTS) return false; // full
  const slot = write & SLOT_MASK;
  const off = slot * SLOT_BYTES;
  const len = frame.byteLength;
  data[off] = (len >> 8) & 0xff;
  data[off + 1] = len & 0xff;
  data.set(frame, off + 2);
  // Atomics.add provides sequentially-consistent ordering: all data stores
  // above are guaranteed visible to any thread before it observes the
  // incremented write_count.
  Atomics.add(header, 0, 1);
  return true;
}

/**
 * Pop one Ethernet frame from the ring buffer.
 * Called from the **worker thread** only (BasiliskII's etherRead).
 *
 * Returns the number of bytes written into `buf`, or 0 if the ring is
 * empty. `buf` must be at least MAX_FRAME bytes.
 */
export function rbPop(sab: SharedArrayBuffer, buf: Uint8Array): number {
  const header = new Int32Array(sab);
  const data = new Uint8Array(sab, HEADER_BYTES);
  const write = Atomics.load(header, 0) >>> 0;
  const read = Atomics.load(header, 1) >>> 0;
  if (write === read) return 0; // empty
  const slot = read & SLOT_MASK;
  const off = slot * SLOT_BYTES;
  const len = (((data[off] << 8) | data[off + 1]) >>> 0);
  const actual = Math.min(len, buf.byteLength);
  buf.set(data.subarray(off + 2, off + 2 + actual));
  // Release the slot: advance read_count (Atomics fence — slot visible as
  // free to the producer after this point).
  Atomics.add(header, 1, 1);
  return actual;
}
