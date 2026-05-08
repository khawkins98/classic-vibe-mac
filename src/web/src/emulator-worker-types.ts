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

/** Start message: main → worker. */
export type EmulatorWorkerStartMessage = {
  type: "start";
  /** URL to BasiliskII.js (the Emscripten loader). */
  coreUrl: string;
  /** URL to BasiliskII.wasm. */
  wasmUrl: string;
  /** URL to Quadra-650.rom. */
  romUrl: string;
  /** Disks to mount. The first entry is the boot disk. */
  diskSpecs: EmulatorChunkedFileSpec[];
  screenWidth: number;
  screenHeight: number;
  /** RAM size in megabytes. Quadra 650 supports up to 128M. */
  ramSizeMB: number;
  /**
   * Files to seed into the Emscripten FS at `/Shared/<name>` before
   * BasiliskII boots, so the `extfs /Shared/` pref can surface them as a
   * Mac volume named "Shared". The worker fetches each URL once before
   * launching the Emscripten Module and writes the bytes inside `preRun`.
   * See emulator-config.ts `sharedFolder` for the source of this list.
   */
  sharedFolderFiles: Array<{ name: string; url: string }>;
  /**
   * Live weather poll. The worker fetches from open-meteo and writes the
   * JSON to /Shared/weather.json (which appears as :Unix:weather.json
   * inside the Mac, where MacWeather reads it). Coordinates are
   * fallbacks; main-thread code can override them by passing through.
   */
  weather?: {
    fallbackLat: number;
    fallbackLon: number;
    lat?: number;
    lon?: number;
  };
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
  | { type: "emulator_stopped" };
