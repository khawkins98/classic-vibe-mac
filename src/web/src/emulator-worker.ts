/// <reference lib="webworker" />
/**
 * emulator-worker.ts — minimum-viable port of Infinite Mac's BasiliskII
 * Web Worker glue.
 *
 * This worker is spawned by emulator-loader.ts (`new Worker(.., { type: "module" })`)
 * and drives the BasiliskII Emscripten Module shipped at /emulator/BasiliskII.js.
 * It expects a "start" message from the main thread carrying an
 * EmulatorWorkerConfig (see ./emulator-worker-types) and then:
 *
 *   1. Allocates SharedArrayBuffers for video output (32bpp framebuffer +
 *      videoMode metadata) and input (Int32Array ring at fixed offsets).
 *   2. Plumbs them into a `globalThis.workerApi` shaped to match the calls
 *      the Emscripten core makes (see InputBufferAddresses, blit(), didOpen*,
 *      idleWait, sleep, disks.{open,read,write,size,...}).
 *   3. Reads the chunked boot disk over `fetch()` (one chunk per HTTP request,
 *      using the manifest format produced by scripts/write-chunked-manifest.py).
 *   4. Imports BasiliskII.js as an ES module and invokes the factory, handing
 *      it a Module override with `arguments: ["--config", "prefs"]` and a
 *      preRun hook that materializes the rendered prefs file plus the
 *      Quadra-650 ROM into the Emscripten FS.
 *   5. Posts video frames back to the main thread via `emulator_blit` events
 *      (the rect describes which sub-region of the SAB framebuffer changed).
 *
 * What this does NOT include (the upstream worker does, we strip):
 *   - Audio (no SharedMemoryEmulatorWorkerAudio / FallbackEmulatorWorkerAudio).
 *     We provide stub implementations of audioBufferSize/enqueueAudio/didOpenAudio
 *     that drop frames on the floor — quieter than the original Mac,
 *     functionally fine for Minesweeper.
 *   - Clipboard, files, ethernet, CD-ROM. All return empty / no-op.
 *   - Persistent disk savers (IndexedDB-backed). Disks are read-only +
 *     writes-in-RAM only; the boot disk image is reset on every page load.
 *   - Service-worker fallback path (XMLHttpRequest sync to /worker-commands).
 *     We require SharedArrayBuffer + cross-origin isolation. The loader
 *     surfaces a clean error if SAB is unavailable.
 *   - Speed governor, delayed disks, placeholder disks, mouse-deltas mode.
 *
 * Reference upstream files (mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12):
 *   src/emulator/worker/worker.ts          EmulatorWorkerApi, startEmulator()
 *   src/emulator/worker/chunked-disk.ts    EmulatorWorkerChunkedDisk
 *   src/emulator/worker/disks.ts           EmulatorWorkerDisksApi
 *   src/emulator/worker/video.ts           SharedMemoryEmulatorWorkerVideo
 *   src/emulator/worker/input.ts           SharedMemoryEmulatorWorkerInput
 *   src/emulator/common/common.ts          InputBufferAddresses, types
 *   src/emulator/ui/config.ts              configToMacemuPrefs()
 *   src/Data/BasiliskIIPrefs.txt           prefs template
 *
 * License: Apache-2.0 (this port follows the upstream layout). The compiled
 * BasiliskII.wasm is GPL-2.0; see src/web/public/emulator/NOTICE.
 */

import {
  InputBufferAddresses,
  LockStates,
  type EmulatorWorkerStartMessage,
  type EmulatorChunkedFileSpec,
  type EmulatorWorkerVideoBlitRect,
} from "./emulator-worker-types";

declare const self: DedicatedWorkerGlobalScope;

// ── Chunked disk reader ──────────────────────────────────────────────
//
// Synchronous (XHR-based) chunk reader, ported from
// EmulatorWorkerChunkedDisk in upstream chunked-disk.ts. The synchronous
// XHR is intentional: the BasiliskII core calls disk.read() synchronously
// from inside Wasm, so we can't await a fetch() Promise. Sync XHR is
// allowed in workers (just deprecated in main threads).

const CHUNK_SIZE = 256 * 1024;

class ChunkedDisk {
  readonly name: string;
  readonly size: number;
  isCdrom = false;
  #spec: EmulatorChunkedFileSpec;
  #loaded = new Map<number, Uint8Array>();
  #onChunkLoad?: (idx: number) => void;

  constructor(spec: EmulatorChunkedFileSpec, onChunkLoad?: (idx: number) => void) {
    this.#spec = spec;
    this.name = spec.name;
    this.size = spec.totalSize;
    this.#onChunkLoad = onChunkLoad;
  }

  read(buf: Uint8Array, offset: number, length: number): number {
    let read = 0;
    this.#forEach(offset, length, (chunk, chunkStart, chunkEnd) => {
      const co = offset - chunkStart;
      const cl = Math.min(chunkEnd - offset, length);
      buf.set(chunk.subarray(co, co + cl), read);
      offset += cl;
      length -= cl;
      read += cl;
    });
    return read;
  }

  write(buf: Uint8Array, offset: number, length: number): number {
    let wrote = 0;
    this.#forEach(offset, length, (chunk, chunkStart, chunkEnd) => {
      const co = offset - chunkStart;
      const cl = Math.min(chunkEnd - offset, length);
      chunk.set(buf.subarray(wrote, wrote + cl), co);
      offset += cl;
      length -= cl;
      wrote += cl;
    });
    return wrote;
  }

  #forEach(
    offset: number,
    length: number,
    cb: (chunk: Uint8Array, chunkStart: number, chunkEnd: number) => void,
  ) {
    const start = Math.floor(offset / CHUNK_SIZE);
    const end = Math.floor((offset + length - 1) / CHUNK_SIZE);
    for (let i = start; i <= end; i++) {
      let chunk = this.#loaded.get(i);
      if (!chunk) {
        chunk = this.#loadChunk(i);
        this.#loaded.set(i, chunk);
      }
      cb(chunk, i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    }
  }

  #loadChunk(idx: number): Uint8Array {
    if (idx * CHUNK_SIZE >= this.size) return new Uint8Array(CHUNK_SIZE);
    const sig = this.#spec.chunks[idx];
    if (!sig) return new Uint8Array(CHUNK_SIZE);
    const url = `${this.#spec.baseUrl}/${sig}.chunk#${idx}`;
    const xhr = new XMLHttpRequest();
    xhr.responseType = "arraybuffer";
    xhr.open("GET", url, false);
    try {
      xhr.send();
    } catch (e) {
      console.warn(`[worker] chunk fetch failed: ${url}`, e);
      return new Uint8Array(CHUNK_SIZE);
    }
    if (xhr.status !== 200) {
      console.warn(`[worker] chunk HTTP ${xhr.status}: ${url}`);
      return new Uint8Array(CHUNK_SIZE);
    }
    this.#onChunkLoad?.(idx);
    let chunk = new Uint8Array(xhr.response as ArrayBuffer);
    if (chunk.length < CHUNK_SIZE) {
      const padded = new Uint8Array(CHUNK_SIZE);
      padded.set(chunk);
      chunk = padded;
    }
    return chunk;
  }

  prefetch(): void {
    for (const i of this.#spec.prefetchChunks) {
      if (!this.#loaded.has(i)) {
        const c = this.#loadChunk(i);
        this.#loaded.set(i, c);
      }
    }
  }
}

// ── DisksApi: the surface the Emscripten core calls into ─────────────
//
// Port of EmulatorWorkerDisksApi (upstream disks.ts). The BasiliskII core
// calls open(name) → diskId, then read/write/size with that id.
// `usePlaceholderDisks` (true for BasiliskII) means we expose 7
// hot-pluggable removable slots in addition to the real fixed disks.

const REMOVABLE_DISK_COUNT = 7;

class RemovableDisk {
  #disk: ChunkedDisk | null = null;
  get name() { return this.#disk?.name ?? ""; }
  get size() { return this.#disk?.size ?? 0; }
  insert(d: ChunkedDisk) { this.#disk = d; }
  eject() { this.#disk = null; }
  hasDisk() { return this.#disk !== null; }
  read(buf: Uint8Array, off: number, len: number) {
    return this.#disk ? this.#disk.read(buf, off, len) : 0;
  }
  write(buf: Uint8Array, off: number, len: number) {
    return this.#disk ? this.#disk.write(buf, off, len) : 0;
  }
}

class DisksApi {
  #disks: ChunkedDisk[];
  #removable: RemovableDisk[] = [];
  #opened = new Map<number, ChunkedDisk | RemovableDisk>();
  #idCounter = 0;
  #pendingNames: string[] = [];
  #emscriptenModule: any;
  #bytesRead = 0;
  #bytesWritten = 0;

  constructor(disks: ChunkedDisk[], usePlaceholders: boolean, mod: any) {
    this.#disks = disks;
    this.#emscriptenModule = mod;
    if (usePlaceholders) {
      for (let i = 0; i < REMOVABLE_DISK_COUNT; i++) {
        this.#removable.push(new RemovableDisk());
      }
    }
  }

  isMediaPresent(id: number): boolean {
    const d = this.#opened.get(id);
    if (!d) throw new Error(`Disk not found: ${id}`);
    if (!(d instanceof RemovableDisk)) return true;
    return d.hasDisk();
  }
  isFixedDisk(id: number): boolean {
    const d = this.#opened.get(id);
    if (!d) throw new Error(`Disk not found: ${id}`);
    return !(d instanceof RemovableDisk);
  }
  eject(id: number) {
    const d = this.#opened.get(id);
    if (d instanceof RemovableDisk) d.eject();
  }
  open(name: string): number {
    const id = this.#idCounter++;
    let disk: ChunkedDisk | RemovableDisk | undefined;
    if (name.startsWith("/placeholder/")) {
      const i = parseInt(name.slice("/placeholder/".length), 10);
      disk = this.#removable[i];
    } else {
      disk = this.#disks.find(d => d.name === name);
    }
    if (!disk) {
      console.warn(`[worker] disk not found: ${name}`);
      return -1;
    }
    this.#opened.set(id, disk);
    return id;
  }
  close(id: number) {
    const d = this.#opened.get(id);
    if (!d) return;
    this.#opened.delete(id);
    if (d instanceof RemovableDisk) d.eject();
  }
  read(id: number, bufPtr: number, offset: number, length: number): number {
    const d = this.#opened.get(id);
    if (!d) return -1;
    const buf = this.#emscriptenModule.HEAPU8.subarray(bufPtr, bufPtr + length);
    const r = d.read(buf, offset, length);
    if (r > 0) this.#bytesRead += r;
    return r;
  }
  write(id: number, bufPtr: number, offset: number, length: number): number {
    const d = this.#opened.get(id);
    if (!d) return -1;
    const buf = this.#emscriptenModule.HEAPU8.subarray(bufPtr, bufPtr + length);
    const w = d.write(buf, offset, length);
    if (w > 0) this.#bytesWritten += w;
    return w;
  }
  size(idOrName: number | string): number {
    const d = typeof idOrName === "string"
      ? this.#disks.find(x => x.name === idOrName)
      : this.#opened.get(idOrName);
    return d ? d.size : 0;
  }
  validate(): void { /* no-op: prefetch validation is for upstream tooling */ }
  consumeDiskName(): string | undefined { return this.#pendingNames.shift(); }
  consumeCdromName(): string | undefined { return undefined; }
  stats() { return { diskBytesRead: this.#bytesRead, diskBytesWritten: this.#bytesWritten }; }
}

// ── BasiliskII prefs template (from upstream src/Data/BasiliskIIPrefs.txt) ──

const BASE_PREFS = `extfs /Shared/
seriala
serialb
ether js
bootdrive 0
bootdriver 0
frameskip 0
fpu true
nocdrom false
nosound false
noclipconversion false
nogui true
jit false
jitfpu false
jitdebug false
jitcachesize 8192
jitlazyflush true
jitinline true
keyboardtype 5
keycodes false
mousewheelmode 1
mousewheellines 3
idlewait true
`;

function buildPrefs(opts: {
  romFileName: string;
  diskNames: string[];
  screenWidth: number;
  screenHeight: number;
  ramSizeMB: number;
}): string {
  let s = BASE_PREFS;
  s += `rom ${opts.romFileName}\n`;
  // Quadra 650 = 68040 (cpu 4), gestaltID 36. Mirrors upstream macemu config.
  s += `cpu 4\n`;
  s += `modelid 36\n`;
  s += `ramsize ${opts.ramSizeMB * 1024 * 1024}\n`;
  s += `screen win/${opts.screenWidth}/${opts.screenHeight}\n`;
  for (const name of opts.diskNames) s += `disk ${name}\n`;
  // Seven removable placeholder slots (`*` prefix = removable).
  for (let i = 0; i < REMOVABLE_DISK_COUNT; i++) s += `disk */placeholder/${i}\n`;
  // jsfrequentreadinput true means we use SAB; matches our SAB-required build.
  s += `jsfrequentreadinput true\n`;
  return s;
}

// ── Worker message handler ───────────────────────────────────────────

let started = false;
self.addEventListener("message", (ev: MessageEvent) => {
  const data = ev.data;
  if (data?.type === "start" && !started) {
    started = true;
    void start(data as EmulatorWorkerStartMessage).catch((err) => {
      console.error("[worker] fatal:", err);
      self.postMessage({
        type: "emulator_error",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
});

// ── Lock helpers (cyclical lock on inputBuffer[0]) ───────────────────

function tryAcquireLock(view: Int32Array, idx: number): number {
  const res = Atomics.compareExchange(
    view,
    idx,
    LockStates.READY_FOR_EMUL_THREAD,
    LockStates.EMUL_THREAD_LOCK,
  );
  return res === LockStates.READY_FOR_EMUL_THREAD ? 1 : 0;
}
function releaseLock(view: Int32Array, idx: number) {
  Atomics.store(view, idx, LockStates.READY_FOR_UI_THREAD);
}
function resetInput(view: Int32Array) {
  view[InputBufferAddresses.mousePositionFlagAddr] = 0;
  view[InputBufferAddresses.mousePositionXAddr] = 0;
  view[InputBufferAddresses.mousePositionYAddr] = 0;
  view[InputBufferAddresses.mouseButtonStateAddr] = 0;
  view[InputBufferAddresses.keyEventFlagAddr] = 0;
  view[InputBufferAddresses.keyCodeAddr] = 0;
  view[InputBufferAddresses.keyStateAddr] = 0;
}

// ── start() — set up shared memory, prefetch, fire up the Module ─────

async function start(msg: EmulatorWorkerStartMessage): Promise<void> {
  const {
    coreUrl,
    wasmUrl,
    romUrl,
    diskSpecs,
    screenWidth,
    screenHeight,
    ramSizeMB,
  } = msg;

  // ── Allocate the shared memory regions ──
  // Video framebuffer: 32bpp pixels, sized for the largest plausible mode.
  // Upstream uses max(width,1600) * max(height,1200) * 4. We match that so
  // a screen-mode change doesn't blow past the buffer.
  const videoBufferSize = Math.max(screenWidth, 1600) * Math.max(screenHeight, 1200) * 4;
  const videoBuffer = new SharedArrayBuffer(videoBufferSize);
  const videoModeBuffer = new SharedArrayBuffer(10 * 4); // small Int32Array
  const videoModeView = new Int32Array(videoModeBuffer);

  // Input buffer: Int32Array used as the cyclical lock + event slots
  // referenced by InputBufferAddresses. Upstream uses 100 slots; we match.
  const INPUT_BUFFER_SIZE = 100;
  const inputBuffer = new SharedArrayBuffer(INPUT_BUFFER_SIZE * 4);
  const inputView = new Int32Array(inputBuffer);

  // ── Notify main: hand back the SABs so it can render frames ──
  self.postMessage({
    type: "emulator_handles",
    videoBuffer,
    videoModeBuffer,
    inputBuffer,
    inputBufferSize: INPUT_BUFFER_SIZE,
    videoBufferSize,
    screenWidth,
    screenHeight,
  });

  // ── Fetch the WASM binary ahead of time so we can pass it as ArrayBuffer
  // (Emscripten supports either URL or instantiate-via-callback). We use
  // the instantiate-via-callback route to skip the duplicate fetch the
  // emscripten preamble would do.
  const wasmRes = await fetch(wasmUrl);
  if (!wasmRes.ok) throw new Error(`WASM fetch failed: ${wasmRes.status}`);
  const wasmArrayBuffer = await wasmRes.arrayBuffer();

  const romRes = await fetch(romUrl);
  if (!romRes.ok) throw new Error(`ROM fetch failed: ${romUrl} → ${romRes.status}`);
  const romArrayBuffer = await romRes.arrayBuffer();

  // ── Build the disks. Synchronous XHR happens inside read(); we still
  // pre-fetch the prefetch list so first-boot reads don't stall on each
  // chunk individually. ──
  const disks = diskSpecs.map((spec) =>
    new ChunkedDisk(spec, (idx) => {
      self.postMessage({ type: "emulator_chunk_loaded", chunkIndex: idx });
    }),
  );

  for (const d of disks) {
    self.postMessage({ type: "emulator_status", phase: "prefetching", name: d.name });
    d.prefetch();
  }

  // ── Build the prefs file from the disk specs ──
  const romFileName = "Quadra-650.rom";
  const prefs = buildPrefs({
    romFileName,
    diskNames: diskSpecs.map((s) => s.name),
    screenWidth,
    screenHeight,
    ramSizeMB,
  });
  console.log("[worker] BasiliskIIPrefs:\n" + prefs);

  // ── The Module overrides. Tracks what upstream `worker.ts startEmulator`
  // does, with audio/clipboard/files/ethernet stripped.
  type ModuleOverride = {
    arguments: string[];
    instantiateWasm: (
      imports: WebAssembly.Imports,
      successCallback: (instance: WebAssembly.Instance) => void,
    ) => Record<string, unknown>;
    preRun: Array<() => void>;
    onRuntimeInitialized: () => void;
    print: (...args: unknown[]) => void;
    printErr: (...args: unknown[]) => void;
    quit: (status: number, toThrow?: Error) => void;
    locateFile?: (path: string) => string;
    FS?: any;
    HEAPU8?: Uint8Array;
    workerApi?: WorkerApi;
  };

  const moduleOverrides: ModuleOverride = {
    arguments: ["--config", "prefs"],

    instantiateWasm(imports, successCallback) {
      // Build the WebAssembly.Module synchronously from our pre-fetched bytes.
      // Mirrors upstream worker.ts (no dateOffset patch — we don't use it).
      WebAssembly.instantiate(wasmArrayBuffer, imports)
        .then((output) => successCallback(output.instance))
        .catch((err) => {
          console.error("[worker] WASM instantiate failed:", err);
          self.postMessage({
            type: "emulator_error",
            error: `WebAssembly instantiate: ${err}`,
          });
        });
      return {};
    },

    preRun: [
      function () {
        // Expose FS globally; emscripten's TS types want it on globalThis.
        (self as any).FS = moduleOverrides.FS;
        const FS = moduleOverrides.FS;
        if (!FS.analyzePath("/Shared").exists) FS.mkdir("/Shared");
        if (!FS.analyzePath("/Shared/Downloads").exists) FS.mkdir("/Shared/Downloads");
        // Materialize the prefs file + ROM into the Emscripten FS so the
        // BasiliskII binary can find them at startup. Args are `--config prefs`.
        FS.createDataFile("/", "prefs", new TextEncoder().encode(prefs), true, true, true);
        FS.createDataFile("/", romFileName, new Uint8Array(romArrayBuffer), true, true, true);
      },
    ],

    onRuntimeInitialized() {
      self.postMessage({ type: "emulator_ready" });
    },

    print: (...args: unknown[]) => console.log("[basilisk]", ...args),
    printErr: (...args: unknown[]) => console.warn("[basilisk]", ...args),
    quit(status: number, toThrow?: Error) {
      console.log("[worker] emulator quit:", status, toThrow);
      self.postMessage({
        type: "emulator_error",
        error: toThrow?.message ?? `Exit ${status}`,
      });
    },

    // Tell emscripten where the .wasm sibling lives. Our instantiateWasm
    // bypasses fetch, but emscripten's preamble may still call locateFile
    // for sourcemaps or workers; route everything to /emulator/.
    locateFile(path: string): string {
      if (path.endsWith(".wasm")) return wasmUrl;
      return new URL(path, coreUrl).toString();
    },
  };

  // ── Build the workerApi shim. Methods here are called from within
  // Wasm-land via the emscripten JS bindings. Names match upstream
  // worker.ts EmulatorWorkerApi exactly because BasiliskII is compiled
  // against that contract.
  class WorkerApi {
    InputBufferAddresses = InputBufferAddresses;
    disks: DisksApi;
    #videoBufferView: Uint8Array;
    #videoModeView: Int32Array;
    #inputView: Int32Array;
    #lastBlitFrameId = 0;
    #lastIdleFrameId = 0;
    #nextExpectedBlitTime = 0;

    constructor() {
      this.#videoBufferView = new Uint8Array(videoBuffer);
      this.#videoModeView = videoModeView;
      this.#inputView = inputView;
      // Disks are bound after the Module is alive (we need module.HEAPU8).
      this.disks = new DisksApi(disks, /*usePlaceholders=*/ true, moduleOverrides as any);
    }

    setAbortError(_err: string) { /* unused */ }
    emulatorDidHaveError(status: number, toThrow?: Error) {
      const error = toThrow?.message ?? toThrow?.toString() ?? `Exit ${status}`;
      self.postMessage({ type: "emulator_error", error });
    }
    exit() {
      self.postMessage({ type: "emulator_stopped" });
      // Spin forever — emscripten can't actually exit a worker.
      // eslint-disable-next-line no-constant-condition
      for (; ;) { /* noop */ }
    }

    didOpenVideo(width: number, height: number) {
      self.postMessage({ type: "emulator_video_open", width, height });
    }

    blit(bufPtr: number, bufSize: number, rect?: EmulatorWorkerVideoBlitRect) {
      this.#lastBlitFrameId++;
      if (bufPtr) {
        const HEAPU8: Uint8Array = (moduleOverrides as any).HEAPU8;
        const data = HEAPU8.subarray(bufPtr, bufPtr + bufSize);
        this.#videoModeView[0] = data.length;
        this.#videoBufferView.set(data);
        self.postMessage({ type: "emulator_blit", rect });
      }
      this.#nextExpectedBlitTime = performance.now() + 16;
    }

    // ── Audio: stubbed. The .wasm calls these but we drop the data. ──
    didOpenAudio(_sampleRate: number, _sampleSize: number, _channels: number) {
      // Posting "audio open" makes the upstream UI side decide to start an
      // AudioWorklet; we don't have one wired, so just acknowledge silently.
    }
    audioBufferSize(): number { return 0; }
    enqueueAudio(_bufPtr: number, _nbytes: number) { /* drop */ }

    // ── Idle / sleep: block the worker until a UI event arrives or the
    // timeout expires. SharedMemoryEmulatorWorkerInput pattern. ──
    idleWait(): boolean {
      if (this.#lastIdleFrameId === this.#lastBlitFrameId) return false;
      this.#lastIdleFrameId = this.#lastBlitFrameId;
      const t = this.#nextExpectedBlitTime - performance.now() - 2;
      if (t <= 0) return false;
      const r = Atomics.wait(
        this.#inputView,
        InputBufferAddresses.globalLockAddr,
        LockStates.READY_FOR_UI_THREAD,
        t,
      );
      return r === "ok";
    }
    sleep(timeSeconds: number) {
      if (timeSeconds > 0) {
        Atomics.wait(
          this.#inputView,
          InputBufferAddresses.globalLockAddr,
          LockStates.READY_FOR_UI_THREAD,
          timeSeconds * 1000,
        );
      }
    }

    acquireInputLock(): number {
      return tryAcquireLock(this.#inputView, InputBufferAddresses.globalLockAddr);
    }
    releaseInputLock() {
      resetInput(this.#inputView);
      releaseLock(this.#inputView, InputBufferAddresses.globalLockAddr);
    }
    getInputValue(addr: number): number { return this.#inputView[addr]; }

    // ── Ethernet: stubbed (ether js → no-op in the prefs). ──
    etherSeed(): number {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0];
    }
    etherInit(_macAddress: string) { /* no-op */ }
    etherWrite(_dest: string, _ptr: number, _len: number) { /* no-op */ }
    etherRead(_ptr: number, _max: number): number { return 0; }

    // ── Clipboard / files: stubbed. ──
    setClipboardText(_text: string) { /* no-op */ }
    getClipboardText(): string | undefined { return undefined; }
    updateEmulatorStats(_stats: unknown) { /* no-op */ }

    // ── Chunked-disk delegate hooks (unused after our fetch model). ──
    willLoadChunk(_i: number) { /* posted from ChunkedDisk on actual fetch */ }
    didLoadChunk(_i: number) { /* posted from ChunkedDisk */ }
    didFailToLoadChunk(_i: number, url: string, error: string) {
      self.postMessage({ type: "emulator_error", error: `chunk fail ${url}: ${error}` });
    }
    async initDiskSavers() { /* unused — no persistent disks */ }
    checkForPeriodicTasks() { /* no-op */ }
  }

  const workerApi = new WorkerApi();
  moduleOverrides.workerApi = workerApi;
  (self as any).workerApi = workerApi;

  // ── Dynamically import the BasiliskII Emscripten module. The .js file
  // is `export default emulator(moduleArg)` so we call it with our overrides.
  // Vite must NOT process this URL — it's at /emulator/ in the deployed site
  // and we want the runtime fetch.
  self.postMessage({ type: "emulator_status", phase: "instantiating" });
  const mod = await import(/* @vite-ignore */ coreUrl);
  // emscripten MODULARIZE: module's default export is `(opts) => Promise<Module>`.
  // The Module's preRun runs synchronously after our overrides are merged in.
  await mod.default(moduleOverrides);
}
