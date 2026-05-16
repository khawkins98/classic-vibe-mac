/**
 * emulator-worker-types.ts — types shared between the main thread and
 * the emulator worker. Lifted (with attribution) from
 * mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12 :
 *   src/emulator/common/common.ts
 *
 * License: Apache-2.0 (Infinite Mac).
 */

/** Slots in the input SharedArrayBuffer (Int32Array). Names + offsets match
 * upstream EmulatorWorkerApi exactly because the BasiliskII WASM was
 * compiled against this layout. */
export const InputBufferAddresses = {
  globalLockAddr: 0,

  mousePositionFlagAddr: 1,
  mousePositionXAddr: 2,
  mousePositionYAddr: 3,
  mouseButtonStateAddr: 4,
  mouseButton2StateAddr: 16,
  mouseDeltaXAddr: 13,
  mouseDeltaYAddr: 14,

  keyEventFlagAddr: 5,
  keyCodeAddr: 6,
  keyStateAddr: 7,
  keyModifiersAddr: 15,

  stopFlagAddr: 8,
  ethernetInterruptFlagAddr: 9,
  audioContextRunningFlagAddr: 10,

  speedFlagAddr: 11,
  speedAddr: 12,

  useMouseDeltasFlagAddr: 17,
  useMouseDeltasAddr: 18,

  pausedAddr: 19,
} as const;

/** Cyclical lock states stored at globalLockAddr. */
export const LockStates = {
  READY_FOR_UI_THREAD: 0,
  UI_THREAD_LOCK: 1,
  READY_FOR_EMUL_THREAD: 2,
  EMUL_THREAD_LOCK: 3,
} as const;

export type EmulatorWorkerVideoBlitRect = {
  top: number;
  left: number;
  bottom: number;
  right: number;
};

/** Subset of upstream EmulatorChunkedFileSpec we actually use. */
export type EmulatorChunkedFileSpec = {
  name: string;
  baseUrl: string;
  totalSize: number;
  chunks: string[];
  chunkSize: number;
  prefetchChunks: number[];
};

/** A disk whose bytes are sent to the worker as a single in-memory blob.
 *  Used by the playground's hot-load path: the patched HFS image is
 *  produced in the browser, never persisted, and handed to a fresh worker
 *  via the `start` message. The worker reads/writes a Uint8Array directly,
 *  no chunked HTTP fetching. */
export type EmulatorInMemoryDiskSpec = {
  /** Discriminator. Lets the worker tell apart the two spec shapes. */
  kind: "inMemory";
  /** Volume name as the Mac will see it on the desktop (HFS volume label).
   *  Note: this is also the open() argument the BasiliskII core passes. */
  name: string;
  /** Raw disk image bytes. Transferable: callers may transfer the buffer
   *  to avoid a copy; the main thread doesn't need it back. */
  bytes: Uint8Array;
};

/** Tagged union the worker accepts in `diskSpecs`. The boot disk is always
 *  a chunked spec (System 7.5.5 image fetched from CDN); secondary disks
 *  may be either chunked or in-memory. */
export type EmulatorDiskSpec =
  | (EmulatorChunkedFileSpec & { kind?: "chunked" })
  | EmulatorInMemoryDiskSpec;

/**
 * Pause flag SharedArrayBuffer layout. A single Int32 at offset 0:
 *   0 = running (worker proceeds normally)
 *   1 = paused  (worker blocks on Atomics.wait(pauseFlag, 0, 1))
 *
 * The main thread sets this on `visibilitychange` (when the setting is on)
 * and notifies the worker thread. The worker checks it at the top of the
 * idle/sleep shims (the only places the BasiliskII core voluntarily yields)
 * and parks itself on Atomics.wait until the flag flips back to 0. This is
 * the cheapest possible way to stall a worker thread — it literally suspends
 * the OS thread, dropping CPU to ~0%.
 */
export const PauseFlagState = {
  RUNNING: 0,
  PAUSED: 1,
} as const;

/** Start message: main → worker. */
export type EmulatorWorkerStartMessage = {
  type: "start";
  /** URL to BasiliskII.js (the Emscripten loader). */
  coreUrl: string;
  /** URL to BasiliskII.wasm. */
  wasmUrl: string;
  /** URL to Quadra-650.rom. */
  romUrl: string;
  /** Disks to mount. The first entry is the boot disk (always chunked).
   *  Subsequent entries may be chunked or in-memory (e.g. a playground
   *  Build & Run output). */
  diskSpecs: EmulatorDiskSpec[];
  screenWidth: number;
  screenHeight: number;
  /** RAM size in megabytes. Quadra 650 supports up to 128M. */
  ramSizeMB: number;
  /**
   * Single-Int32 SharedArrayBuffer used for the visibility pause flag.
   * See {@link PauseFlagState}. Allocated by the main thread (so it owns
   * the lifecycle) and handed to the worker at start so the worker can
   * Atomics.wait on it from inside its idleWait/sleep shims. Optional for
   * back-compat with tests that build start messages by hand.
   */
  pauseFlagBuffer?: SharedArrayBuffer;
  /**
   * Files to seed into the Emscripten FS at `/Shared/<name>` before
   * BasiliskII boots, so the `extfs /Shared/` pref can surface them as a
   * Mac volume named "Shared". The worker fetches each URL once before
   * launching the Emscripten Module and writes the bytes inside `preRun`.
   * See emulator-config.ts `sharedFolder` for the source of this list.
   */
  sharedFolderFiles: Array<{ name: string; url: string }>;
  /**
   * SharedArrayBuffer for the Ethernet RX ring buffer (frames arriving from
   * the network, destined for BasiliskII). Allocated by the main thread so
   * both threads share the same memory. If absent, Ethernet is stubbed out
   * and `etherRead`/`etherWrite` remain no-ops.
   *
   * See src/web/src/ethernet.ts for the ring buffer layout and constants.
   */
  ethernetRxBuffer?: SharedArrayBuffer;
};

/** Worker → main messages. Discriminated union by `type`. */
export type EmulatorWorkerMessage =
  | { type: "emulator_status"; phase: string; name?: string }
  | {
      type: "emulator_handles";
      videoBuffer: SharedArrayBuffer;
      videoModeBuffer: SharedArrayBuffer;
      inputBuffer: SharedArrayBuffer;
      inputBufferSize: number;
      videoBufferSize: number;
      screenWidth: number;
      screenHeight: number;
    }
  | { type: "emulator_video_open"; width: number; height: number }
  | { type: "emulator_blit"; rect?: EmulatorWorkerVideoBlitRect }
  | { type: "emulator_chunk_loaded"; chunkIndex: number }
  | { type: "emulator_ready" }
  | { type: "emulator_error"; error: string }
  | { type: "emulator_stopped" }
  /**
   * Sent by the worker when BasiliskII opens its audio subsystem.
   * The main thread should create an AudioContext at `sampleRate` and
   * load the AudioWorklet so playback is ready before the core starts
   * producing audio frames.
   */
  | {
      type: "emulator_audio_open";
      sampleRate: number;
      sampleSize: number;
      channels: number;
    }
  /**
   * Sent by the worker for each audio frame produced by BasiliskII.
   * `data` is a copy of the PCM bytes (not a view into WASM memory).
   * The buffer is transferred (Transferable), so no copy on the receiver.
   */
  | { type: "emulator_audio_data"; data: Uint8Array }
  /**
   * Response to a `poll_url_request` message. Contains the raw bytes of
   * /Shared/__url-request.txt, or null if the file is not yet present.
   * Format (ASCII): "<requestId>\n<url>\n"
   */
  | { type: "url_request_data"; bytes: Uint8Array | null }
  /**
   * Response to a `poll_drawing` message. Contains the raw 512 bytes of
   * /Shared/__drawing.bin (64×64 1-bit bitmap, MSB-first, 0=white 1=black),
   * or null if the file is absent or not exactly 512 bytes.
   */
  | { type: "drawing_data"; bytes: Uint8Array | null }
  /**
   * Response to a `poll_console` message. Incremental — `bytes` contains
   * only the data appended to /Shared/__cvm_console.log since the previous
   * poll's `totalSize`. The main-thread watcher keeps a running offset so
   * it can decode just the new tail. `totalSize` is the current file size
   * (so the watcher can detect file truncation / reset). MacRoman bytes.
   */
  | { type: "console_data"; bytes: Uint8Array | null; totalSize: number }
  /**
   * Sent by the worker when BasiliskII calls etherInit().
   * The main thread should call EthernetZoneProvider.connect(macAddress).
   */
  | { type: "ethernet_init"; macAddress: string }
  /**
   * Sent by the worker when BasiliskII calls etherWrite() (TX path).
   * `dest` is the destination MAC address string (or "*"/"AT" for broadcast).
   * `data` is the raw Ethernet frame bytes — transferred (Transferable) to
   * avoid a copy.  The main thread forwards this to the zone relay via
   * EthernetZoneProvider.send().
   */
  | { type: "ethernet_frame"; dest: string; data: Uint8Array };

/**
 * Messages from the main thread to the worker that are NOT the start message.
 * The `weather_data` and `url_result_write` messages are the runtime channel
 * for host-to-Mac data (shared-folder writes via the Emscripten FS).
 */
export type EmulatorWorkerRuntimeMessage =
  /**
   * Ask the worker to read /Shared/__url-request.txt and reply with
   * `url_request_data`. Sent on a timer by SharedPoller on the main thread.
   */
  | { type: "poll_url_request" }
  /**
   * Write the URL fetch result to the Emscripten FS so the Mac can read it.
   * `path` must match /Shared/__url-result-<id>.html (validated in worker).
   * `bytes` is the MacRoman-encoded HTML body to write.
   */
  | { type: "url_result_write"; path: string; bytes: Uint8Array }
  /**
   * Ask the worker to read /Shared/__drawing.bin and reply with
   * `drawing_data`. Sent every 2 s by DrawingWatcher on the main thread.
   */
  | { type: "poll_drawing" }
  /**
   * Ask the worker to read /Shared/__cvm_console.log starting at byte
   * `fromOffset` and reply with `console_data`. Sent every 1 s by
   * ConsoleWatcher on the main thread. The incremental contract keeps
   * the message size proportional to new log volume rather than full
   * file size.
   */
  | { type: "poll_console"; fromOffset: number };
