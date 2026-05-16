/**
 * emulator-loader.ts — owns the BasiliskII boot lifecycle.
 *
 * Renders into the `#emulator-canvas-mount` slot inside the marketer's
 * "Macintosh" window chrome (see main.ts).
 *
 * Boot flow:
 *   1. Render a period-styled progress UI in the mount.
 *   2. Verify cross-origin isolation (SharedArrayBuffer is required by the
 *      BasiliskII WASM init contract; if the browser isn't isolated, fall
 *      back to STUB with a sharper message).
 *   3. HEAD-check the chunked boot disk manifest. If absent, STUB.
 *   4. Spawn `emulator-worker.ts` as a `type:'module'` Web Worker, hand
 *      it the disk spec + URLs, and listen for `emulator_handles` —
 *      that message contains the SharedArrayBuffers we render from and
 *      the input buffer we write into.
 *   5. Mount the canvas, start a requestAnimationFrame loop that copies
 *      the SAB framebuffer into ImageData and putImageData()s it. Hook
 *      input events into the shared input buffer via emulator-input.ts.
 *
 * Reference (for the worker glue this drives):
 *   mihaip/infinite-mac@30112da0db src/emulator/ui/ui.ts (Emulator class)
 *   mihaip/infinite-mac@30112da0db src/emulator/worker/worker.ts
 */

import type { EmulatorConfig } from "./emulator-config";
import {
  PauseFlagState,
  type EmulatorChunkedFileSpec,
  type EmulatorInMemoryDiskSpec,
  type EmulatorWorkerMessage,
  type EmulatorWorkerStartMessage,
  type EmulatorWorkerVideoBlitRect,
} from "./emulator-worker-types";
import { wireInput, setInputBuffer, signalAudioContextRunning } from "./emulator-input";
import { startWeatherPoller } from "./weather-poller";
import { startSharedPoller } from "./shared-poller";
import { startDrawingWatcher } from "./drawing-watcher";
import { startConsoleWatcher } from "./console-watcher";
import {
  isPauseWhenHiddenEnabled,
  onPauseWhenHiddenChange,
} from "./settings";
import { EthernetZoneProvider, makeZoneWsUrl } from "./ethernet-provider";
import { ETHERNET_RX_SAB_SIZE } from "./ethernet";
export { wireInput } from "./emulator-input";

/**
 * Class applied to <body> whenever the emulator is currently paused due to
 * the page being hidden. Drives the visual "💤" indicator and any tinting
 * we want on the canvas. Tests assert on this class.
 */
const PAUSED_BODY_CLASS = "cvm-paused";

type LoaderPhase =
  | { kind: "idle" }
  | { kind: "fetching"; label: string; loadedBytes: number; totalBytes: number }
  | { kind: "starting"; detail: string }
  | { kind: "running" }
  | { kind: "stub"; reason: string }
  | { kind: "error"; message: string };

interface LoaderHandles {
  mount: HTMLElement;
  setPhase(phase: LoaderPhase): void;
}

/** Public surface returned by startEmulator(). Reboot() tears down the
 *  current worker + render loop, spawns a fresh worker, and re-runs boot
 *  with the user-supplied secondary disk inserted. The boot disk URL is
 *  reused unchanged (System 7.5.5 doesn't change between reboots).
 *
 *  reboot() returns a Promise that resolves when the new worker is
 *  fully booted (`emulator_ready` received). Callers can chain UI
 *  updates against that.
 */
export interface EmulatorHandle {
  dispose(): void;
  /** Reboot with a new in-memory secondary disk. Used by the playground's
   *  Build & Run button. Resolves after first frame paints. */
  reboot(spec: EmulatorInMemoryDiskSpec): Promise<void>;
}

interface ActiveSession {
  ac: AbortController;
  worker: Worker | undefined;
  rafId: number;
  unwireInput: (() => void) | undefined;
  teardownVisibility: (() => void) | undefined;
  stopWeather: (() => void) | undefined;
  stopSharedPoller: (() => void) | undefined;
  stopDrawingWatcher: (() => void) | undefined;
  /** AudioContext created when BasiliskII opens its audio subsystem. */
  audioContext: AudioContext | undefined;
  /** AudioWorkletNode that receives PCM chunks forwarded from the worker. */
  audioWorkletNode: AudioWorkletNode | undefined;
  /** Resolves on `emulator_ready`. Tracking this lets reboot() await it. */
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (err: Error) => void;
  /** Zone WebSocket provider for AppleTalk/Ethernet relay. Null if not used. */
  ethernetProvider: EthernetZoneProvider | null;
}

function makeSession(): ActiveSession {
  const ac = new AbortController();
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const readyPromise = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  return {
    ac,
    worker: undefined,
    rafId: 0,
    unwireInput: undefined,
    teardownVisibility: undefined,
    stopWeather: undefined,
    stopSharedPoller: undefined,
    stopDrawingWatcher: undefined,
    audioContext: undefined,
    audioWorkletNode: undefined,
    readyPromise,
    resolveReady,
    rejectReady,
    ethernetProvider: null,
  };
}

function disposeSession(s: ActiveSession): void {
  s.ac.abort();
  if (s.rafId) cancelAnimationFrame(s.rafId);
  s.unwireInput?.();
  s.teardownVisibility?.();
  // Issue #29: stop the weather poller so it doesn't postMessage() into a
  // terminated worker on the next interval/visibilitychange. Previously
  // this leak was silent — the message hit a dead port.
  s.stopWeather?.();
  s.stopSharedPoller?.();
  s.stopDrawingWatcher?.();
  s.worker?.terminate();
  // Tear down the Ethernet zone WebSocket connection.
  s.ethernetProvider?.dispose();
  // Tell the audio worklet to flush its queue before closing the context —
  // prevents stale PCM chunks from the old session bleeding into the next boot.
  s.audioWorkletNode?.port.postMessage({ type: "reset" });
  // Close audio context so the AudioWorklet thread doesn't keep draining
  // a dead queue after the worker has been terminated.
  s.audioContext?.close().catch(() => {});
  // If readyPromise is still pending (dispose during boot), reject it so
  // any outstanding reboot() awaits don't dangle forever.
  s.rejectReady(new Error("emulator session disposed"));
}

export function startEmulator(
  config: EmulatorConfig,
  mount: HTMLElement,
): EmulatorHandle {
  let handles = renderShell(mount);
  let session = makeSession();
  // List of in-memory disks added via reboot(). Survives across reboots
  // so multiple build cycles keep stacking new disks (though v1 only
  // ever passes ONE — v2 may permit reader + macweather coexisting).
  let extraDisks: EmulatorInMemoryDiskSpec[] = [];

  const startSession = (extras: EmulatorInMemoryDiskSpec[]) => {
    void boot(config, handles, session, extras).catch((err) => {
      if ((err as Error).name === "AbortError") return;
      console.error("[emulator] boot failed:", err);
      handles.setPhase({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      session.rejectReady(err as Error);
    });
  };

  startSession(extraDisks);

  return {
    dispose: () => {
      disposeSession(session);
    },
    async reboot(spec: EmulatorInMemoryDiskSpec): Promise<void> {
      // Tear down the live session first. We DO NOT wait for the worker
      // to gracefully exit — terminate() is immediate, the SAB views
      // get released, and the next session allocates fresh ones. There
      // is a subtle race where the rAF loop might fire one more time
      // during teardown; the AbortController guards that path.
      disposeSession(session);
      // Reset the mount so renderShell can paint a fresh progress block.
      // (The previous session's canvas is still in there.)
      mount.innerHTML = "";
      handles = renderShell(mount);
      session = makeSession();
      // Replace the extras list — v1 is one app per disk. If we want to
      // support multiple coexisting hot-loaded disks later, change this
      // to `extraDisks.push(spec)`.
      extraDisks = [spec];
      startSession(extraDisks);
      await session.readyPromise;
    },
  };
}

// ── Visibility / pause-flag controller ───────────────────────────────
//
// Owns the SharedArrayBuffer-backed pause flag plus the visibilitychange
// listener that flips it. The contract:
//   - `enable()` is called only AFTER `emulator_ready` so we don't pause
//     in the middle of boot (which would deadlock the loader).
//   - The setting (`cvm.pauseWhenHidden`) is checked AT EVERY visibility
//     change, so toggling the checkbox takes effect on the next switch.
//   - Pausing/resuming flips the body class so the chrome can show the
//     "💤" hint and CSS can tint the canvas without touching the canvas
//     element itself (which the loader has handed off to the worker).
//
// The pause flag lives in its own SAB rather than piggybacking on the
// existing input SAB so the cyclical input lock semantics stay clean
// (we just fixed those — see emulator-input.ts header).
type VisibilityController = {
  /** SAB to hand to the worker at start. */
  buffer: SharedArrayBuffer;
  /** Wire up the visibilitychange listener (called after emulator_ready). */
  enable(): void;
  /** Stop listening; also un-pauses to be safe. */
  teardown(): void;
};

function makeVisibilityController(opts: {
  onPausedChange?: (paused: boolean) => void;
}): VisibilityController {
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.store(view, 0, PauseFlagState.RUNNING);

  let enabled = false;
  let lastApplied: 0 | 1 = 0;

  const apply = () => {
    if (!enabled) return;
    // Setting OFF means the visibility handler still fires but never pauses.
    // Toggling the setting back ON while already hidden will pause on the
    // very next visibilitychange event — that's acceptable; the alternative
    // (re-evaluating immediately on toggle) risks pausing while the user is
    // mid-interaction with the settings UI.
    const wantPaused =
      isPauseWhenHiddenEnabled() && document.visibilityState === "hidden";
    const next: 0 | 1 = wantPaused ? PauseFlagState.PAUSED : PauseFlagState.RUNNING;
    if (next === lastApplied) return;
    lastApplied = next;
    Atomics.store(view, 0, next);
    if (next === PauseFlagState.RUNNING) {
      // Wake the worker thread (Atomics.wait inside idleWait/sleep).
      Atomics.notify(view, 0, /*count=*/ Infinity);
    }
    opts.onPausedChange?.(next === PauseFlagState.PAUSED);
  };

  const onVisibility = () => apply();
  const offSetting = onPauseWhenHiddenChange(() => apply());

  return {
    buffer,
    enable() {
      if (enabled) return;
      enabled = true;
      document.addEventListener("visibilitychange", onVisibility);
      // Apply current state immediately in case the user loaded the page
      // already in a hidden tab (rare but possible: open in background).
      apply();
    },
    teardown() {
      enabled = false;
      document.removeEventListener("visibilitychange", onVisibility);
      offSetting();
      // Be safe: if we're tearing down while paused, wake the worker so
      // it can observe whatever shutdown signal we send next.
      if (lastApplied === PauseFlagState.PAUSED) {
        Atomics.store(view, 0, PauseFlagState.RUNNING);
        Atomics.notify(view, 0, Infinity);
      }
      opts.onPausedChange?.(false);
    },
  };
}

// ── Boot ─────────────────────────────────────────────────────────────

async function boot(
  config: EmulatorConfig,
  handles: LoaderHandles,
  session: ActiveSession,
  extraDisks: EmulatorInMemoryDiskSpec[],
): Promise<void> {
  const signal = session.ac.signal;
  const setWorker = (w: Worker) => { session.worker = w; };
  const setRaf = (id: number) => { session.rafId = id; };
  const setUnwire = (un: () => void) => { session.unwireInput = un; };
  const setTeardownVisibility = (td: () => void) => {
    session.teardownVisibility = td;
  };
  const setStopWeather = (s: () => void) => { session.stopWeather = s; };
  const setStopSharedPoller = (s: () => void) => { session.stopSharedPoller = s; };
  const setStopDrawingWatcher = (s: () => void) => { session.stopDrawingWatcher = s; };
  // ── Phase 0: cross-origin isolation gate. ──
  // SharedArrayBuffer is gated on `crossOriginIsolated` in modern browsers.
  // Vite dev sets COOP/COEP, and on GH Pages we install coi-serviceworker
  // (see index.html). If isolation isn't established (first-load before SW
  // takes over, or unsupported browser), drop into STUB cleanly.
  if (typeof SharedArrayBuffer === "undefined" || !crossOriginIsolated) {
    handles.setPhase({
      kind: "stub",
      reason:
        "This browser is not cross-origin isolated, so SharedArrayBuffer " +
        "is unavailable. The BasiliskII core requires it. On GitHub Pages, " +
        "reload once after the page has fully loaded — the coi-serviceworker " +
        "shim takes effect on the second navigation.",
    });
    return;
  }

  // ── Phase 1: HEAD-check the chunked boot disk manifest. ──
  // The manifest is the entry point for chunked-disk reads. If it's missing
  // we have no way to boot; surface that as STUB rather than crashing in
  // the worker.
  if (!config.bootDiskUrl) {
    handles.setPhase({
      kind: "stub",
      reason:
        "Boot disk URL is not configured. Run scripts/build-boot-disk.sh " +
        "to produce system755-vibe.dsk + chunks, then rebuild.",
    });
    return;
  }
  const manifestUrl = `${config.bootDiskUrl}.json`;
  let manifest: EmulatorChunkedFileSpec;
  try {
    handles.setPhase({
      kind: "fetching",
      label: "Loading disk manifest…",
      loadedBytes: 0,
      totalBytes: 0,
    });
    const r = await fetch(manifestUrl, { signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const raw = await r.json();
    // `baseUrl` is the chunks directory, sibling of the manifest.
    const baseUrl = `${config.bootDiskUrl.replace(/\.dsk$/, "")}-chunks`;
    manifest = {
      name: typeof raw.name === "string" ? raw.name + ".dsk" : "system755-vibe.dsk",
      baseUrl,
      totalSize: raw.totalSize,
      chunks: raw.chunks,
      chunkSize: raw.chunkSize,
      prefetchChunks: raw.prefetchChunks ?? [0],
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    handles.setPhase({
      kind: "stub",
      reason:
        `Boot disk manifest not found (${manifestUrl}). Run the CI ` +
        `pipeline (scripts/build-boot-disk.sh emits the chunks + manifest) ` +
        `or check the deployed asset path. Underlying: ${(err as Error).message}`,
    });
    return;
  }

  // ── Phase 2: HEAD-check the BasiliskII core itself. ──
  // The worker fetches it with `fetch()` too, but a HEAD here gives us a
  // crisper error message (and surfaces 404s in the network panel).
  try {
    const r = await fetch(config.coreUrl, { method: "HEAD", signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (err) {
    if ((err as Error).name === "AbortError") return;
    handles.setPhase({
      kind: "stub",
      reason:
        `BasiliskII core not found at ${config.coreUrl}. Run ` +
        `npm run fetch:emulator. Underlying: ${(err as Error).message}`,
    });
    return;
  }

  // ── Phase 3: spin up the worker and wait for handles. ──
  handles.setPhase({ kind: "starting", detail: "Booting emulator worker…" });

  // Resolve the ROM URL alongside the core. `fetch-emulator.sh` drops
  // Quadra-650.rom into /emulator/ next to the .wasm.
  const romUrl = config.coreUrl.replace(/BasiliskII\.js$/, "Quadra-650.rom");

  // The worker file is bundled by Vite (`new URL(...)` pattern, supported
  // since Vite 2). `type: "module"` because BasiliskII.js is an ES module.
  const worker = new Worker(
    new URL("./emulator-worker.ts", import.meta.url),
    { type: "module", name: "basilisk-worker" },
  );
  setWorker(worker);

  let canvas: HTMLCanvasElement | undefined;
  let ctx: CanvasRenderingContext2D | undefined;
  let imageData: ImageData | undefined;
  let videoView: Uint8Array | undefined;
  let videoModeView: Int32Array | undefined;
  let frames = 0;
  let firstFrameLogged = false;
  let lastBlitRect: EmulatorWorkerVideoBlitRect | undefined;

  let isPaused = false;
  const visibility = makeVisibilityController({
    onPausedChange(paused) {
      isPaused = paused;
      document.body.classList.toggle(PAUSED_BODY_CLASS, paused);
      // Surface as a custom event so the chrome (or tests) can react
      // without importing this module's internals.
      window.dispatchEvent(
        new CustomEvent("cvm:paused-change", { detail: { paused } }),
      );
    },
  });
  setTeardownVisibility(() => visibility.teardown());

  let canvasMounted = false;
  worker.addEventListener("message", (ev: MessageEvent<EmulatorWorkerMessage>) => {
    const m = ev.data;
    switch (m.type) {
      case "emulator_status":
        // Don't touch the mount once the canvas is in place — status updates
        // after we've handed off rendering would wipe out the canvas.
        if (canvasMounted) {
          console.log("[emulator] status:", m.phase, m.name ?? "");
        } else {
          handles.setPhase({
            kind: "starting",
            detail: m.phase + (m.name ? ` (${m.name})` : ""),
          });
        }
        break;

      case "emulator_handles": {
        videoView = new Uint8Array(m.videoBuffer);
        videoModeView = new Int32Array(m.videoModeBuffer);
        // Mount the canvas and wire input now that we have shared memory.
        canvas = mountCanvas(handles.mount, {
          width: m.screenWidth,
          height: m.screenHeight,
        });
        ctx = canvas.getContext("2d", { desynchronized: true })!;
        imageData = ctx.createImageData(m.screenWidth, m.screenHeight);
        // Hand the SharedArrayBuffer to the input layer; emulator-input.ts
        // now owns the cyclical-lock dance with the worker (compareExchange
        // READY_FOR_UI_THREAD → UI_THREAD_LOCK, write events, store
        // READY_FOR_EMUL_THREAD + Atomics.notify). Previously we wrote
        // event slots directly without participating in the lock, so the
        // worker's acquireInputLock never saw READY_FOR_EMUL_THREAD and no
        // input was ever delivered to the emulator. See LEARNINGS.md
        // 2026-05-08 (input lock entry).
        setInputBuffer(m.inputBuffer);
        setUnwire(wireInput(canvas));
        canvasMounted = true;
        break;
      }

      case "emulator_video_open":
        // Resize the canvas + ImageData if the emulator opens at a different
        // size than we initially mounted (e.g. a 800×600 pre-baked prefs).
        if (canvas && ctx && (canvas.width !== m.width || canvas.height !== m.height)) {
          canvas.width = m.width;
          canvas.height = m.height;
          imageData = ctx.createImageData(m.width, m.height);
        }
        break;

      case "emulator_blit":
        if (m.rect) {
          if (!lastBlitRect) lastBlitRect = { ...m.rect };
          else {
            lastBlitRect.top = Math.min(lastBlitRect.top, m.rect.top);
            lastBlitRect.left = Math.min(lastBlitRect.left, m.rect.left);
            lastBlitRect.bottom = Math.max(lastBlitRect.bottom, m.rect.bottom);
            lastBlitRect.right = Math.max(lastBlitRect.right, m.rect.right);
          }
        }
        break;

      case "emulator_chunk_loaded":
        // Could surface this as progress; for now, just log.
        if (m.chunkIndex < 4) console.log(`[emulator] chunk ${m.chunkIndex} loaded`);
        break;

      case "emulator_ready":
        handles.setPhase({ kind: "running" });
        // Only NOW arm the visibility-pause path. Pausing during boot
        // (chunk fetch, runtime init, FS materialization) would leave
        // the worker stuck on Atomics.wait inside a code path that
        // hasn't yet finished bringing the emulator up.
        visibility.enable();
        // Notify reboot() awaiters.
        session.resolveReady();
        break;

      case "emulator_error":
        console.error("[emulator] worker error:", m.error);
        handles.setPhase({ kind: "error", message: m.error });
        break;

      case "emulator_stopped":
        console.log("[emulator] worker stopped");
        break;

      case "emulator_audio_open":
        // BasiliskII has opened its audio subsystem — spin up Web Audio.
        if (!signal.aborted) {
          void initAudio(m.sampleRate, m.sampleSize, m.channels);
        }
        break;

      case "emulator_audio_data":
        // Forward raw PCM chunk to the AudioWorklet (Transferable to avoid copy).
        session.audioWorkletNode?.port.postMessage(
          { type: "data", data: m.data },
          [m.data.buffer],
        );
        break;

      case "ethernet_init":
        // BasiliskII has initialised its ethernet driver — connect to the zone.
        session.ethernetProvider?.connect(m.macAddress);
        break;

      case "ethernet_frame":
        // BasiliskII is sending an Ethernet frame — forward to the zone relay.
        session.ethernetProvider?.send(m.dest, m.data);
        break;
    }
  });

  worker.addEventListener("error", (ev) => {
    console.error("[emulator] worker error event:", ev);
    handles.setPhase({
      kind: "error",
      message: `Worker error: ${ev.message ?? "unknown"}`,
    });
  });

  /**
   * Set up the Web Audio pipeline once BasiliskII signals it has opened its
   * audio subsystem. Creates an AudioContext at the Mac's native sample rate,
   * loads the CvmAudioProcessor AudioWorklet, and wires it to the destination.
   *
   * Browsers require a user gesture before an AudioContext can play. We
   * subscribe to `pointerdown` and attempt `ctx.resume()` immediately — on
   * desktop the first click (which also starts the emulator interaction) will
   * ungate audio automatically. Once the context is running we signal BasiliskII
   * (via `audioContextRunningFlagAddr`) to start emitting PCM frames.
   */
  async function initAudio(
    sampleRate: number,
    sampleSize: number,
    channels: number,
  ): Promise<void> {
    if (typeof AudioContext === "undefined") {
      console.warn("[audio] AudioContext not supported — no audio");
      return;
    }
    try {
      const ctx = new AudioContext({ latencyHint: "interactive", sampleRate });
      session.audioContext = ctx;

      if (!ctx.audioWorklet) {
        console.warn("[audio] AudioWorklet not supported — no audio");
        return;
      }

      // The AudioWorklet script lives in public/ and is served as a static
      // asset alongside index.html — no bundling required.
      const workletUrl = absoluteUrl("./emulator-audio-worklet.js");
      await ctx.audioWorklet.addModule(workletUrl);

      if (signal.aborted) return; // session disposed while we were awaiting

      const node = new AudioWorkletNode(ctx, "cvm-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        channelCount: channels,
        processorOptions: { sampleSize },
      });
      session.audioWorkletNode = node;
      node.connect(ctx.destination);

      const onRunning = () => {
        if (signal.aborted) return;
        console.log("[audio] AudioContext running — signalling BasiliskII");
        signalAudioContextRunning();
      };

      const tryResume = () => ctx.resume().catch(() => {});
      window.addEventListener("pointerdown", tryResume);

      ctx.addEventListener("statechange", () => {
        if (ctx.state === "running") {
          window.removeEventListener("pointerdown", tryResume);
          onRunning();
        }
      });

      // Try immediately — may succeed if a gesture has already happened.
      await tryResume();
      if (ctx.state === "running") {
        window.removeEventListener("pointerdown", tryResume);
        onRunning();
      }
    } catch (err) {
      console.warn("[audio] Audio initialisation failed:", err);
    }
  }

  // ── Ethernet zone setup (optional — opt-in via ?zone= URL param). ──
  // If both VITE_ETHERNET_WS_BASE env var and a `?zone=` query param are
  // present, allocate the RX ring SAB, create the provider, and include
  // the SAB in the start message. Otherwise, ethernet stays stubbed out
  // and the emulator boots normally without networking.
  const zoneParam = new URLSearchParams(location.search).get("zone") ?? "";
  const zoneWsUrl = zoneParam ? makeZoneWsUrl(zoneParam) : null;
  let ethernetRxBuffer: SharedArrayBuffer | undefined;
  if (zoneWsUrl) {
    ethernetRxBuffer = new SharedArrayBuffer(ETHERNET_RX_SAB_SIZE);
    session.ethernetProvider = new EthernetZoneProvider(ethernetRxBuffer, zoneWsUrl);
    console.log(`[ethernet] zone "${zoneParam}" → ${zoneWsUrl}`);
  }

  // Fire off the start message. Boot disk first (always chunked), then
  // any in-memory secondary disks added via reboot() — passed verbatim,
  // the worker discriminates by `spec.kind`.
  const startMsg: EmulatorWorkerStartMessage = {
    type: "start",
    coreUrl: absoluteUrl(config.coreUrl),
    wasmUrl: absoluteUrl(config.wasmUrl),
    romUrl: absoluteUrl(romUrl),
    diskSpecs: [manifest, ...extraDisks],
    screenWidth: config.screen.width,
    screenHeight: config.screen.height,
    ramSizeMB: 16, // 16MB is plenty for System 7.5.5 + Minesweeper.
    // Forward shared-folder URLs as absolute strings so the worker (which
    // runs from a blob: or different base) can fetch them without needing
    // to know about Vite's `base` setting. Empty list is fine — the worker
    // will just create an empty `/Shared/` directory.
    sharedFolderFiles: config.sharedFolder.files.map((f) => ({
      name: f.name,
      url: absoluteUrl(f.url),
    })),
    pauseFlagBuffer: visibility.buffer,
    ethernetRxBuffer,
  };
  worker.postMessage(startMsg);

  // Start the live weather poll on the main thread. We can't run it inside
  // the worker because BasiliskII's WASM event loop blocks the worker's
  // microtask queue (its idleWait sits in `Atomics.wait` between blits) —
  // a fetch's then() callback never gets scheduled. The poller posts the
  // JSON bytes back to the worker via `{ type: "weather_data", bytes }`,
  // which writes them into the Emscripten FS at /Shared/weather.json.
  // BasiliskII's extfs surfaces /Shared/ as the Mac volume "Unix:" — so
  // MacWeather sees the JSON at :Unix:weather.json.
  try {
    const stopWeather = startWeatherPoller({
      worker,
      fallbackLat: config.weather.fallbackLat,
      fallbackLon: config.weather.fallbackLon,
    });
    setStopWeather(stopWeather);
  } catch (err) {
    console.warn("[emulator] weather poller failed to start:", err);
  }

  try {
    const stopSharedPoller = startSharedPoller({ worker });
    setStopSharedPoller(stopSharedPoller);
  } catch (err) {
    console.warn("[emulator] shared-poller failed to start:", err);
  }

  try {
    const stopDrawingWatcher = startDrawingWatcher({ worker });
    setStopDrawingWatcher(stopDrawingWatcher);
  } catch (err) {
    console.warn("[emulator] drawing-watcher failed to start:", err);
  }

  try {
    // ConsoleWatcher polls /Shared/__cvm_console.log every 1s and
    // surfaces new lines in the Output panel's Console tab. The
    // emulator-side Mac app writes via cvm_log() from <cvm_log.h>.
    // setInterval-based, no stop handle — it's safe to leave running
    // across reboots since the worker queue absorbs duplicate polls.
    startConsoleWatcher({ worker });
  } catch (err) {
    console.warn("[emulator] console-watcher failed to start:", err);
  }

  // ── Phase 4: render loop. ──
  // We skip the actual blit work when paused — the worker has stopped
  // posting `emulator_blit` messages anyway (it's parked on Atomics.wait),
  // so there's nothing new to draw, but rAF still fires on hidden tabs in
  // some cases and it would be silly to keep walking the framebuffer.
  // We DO keep scheduling rAF so resume picks up immediately. (Browsers
  // throttle rAF to ~0Hz when the document is hidden anyway, so the
  // scheduling cost is negligible.)
  const draw = () => {
    if (signal.aborted) return;
    if (isPaused) {
      setRaf(requestAnimationFrame(draw));
      return;
    }
    if (videoView && videoModeView && imageData && ctx && canvas) {
      const size = videoModeView[0];
      if (size > 0) {
        // Pixels are 32bpp BGRA in the SAB; ImageData wants RGBA. Walk the
        // dirty rect (or full frame) and swap channels.
        const rect = lastBlitRect ?? {
          top: 0,
          left: 0,
          bottom: canvas.height,
          right: canvas.width,
        };
        copyAndSwapBgraToRgba(
          videoView,
          imageData.data,
          canvas.width,
          rect,
        );
        ctx.putImageData(
          imageData,
          0,
          0,
          rect.left,
          rect.top,
          rect.right - rect.left,
          rect.bottom - rect.top,
        );
        lastBlitRect = undefined;
        frames++;
        if (!firstFrameLogged && frames > 0) {
          firstFrameLogged = true;
          console.log("[emulator] first frame painted");
        }
      }
    }
    setRaf(requestAnimationFrame(draw));
  };
  setRaf(requestAnimationFrame(draw));
}

// ── Helpers ──────────────────────────────────────────────────────────

function absoluteUrl(path: string): string {
  return new URL(path, self.location.href).toString();
}

/**
 * BasiliskII writes BGRA into the SAB; canvas ImageData is RGBA. We could
 * walk the whole framebuffer every frame, but using the dirty rect saves
 * bandwidth when only a corner of the screen changed (which is most of
 * the time for a quiescent System 7 desktop).
 */
function copyAndSwapBgraToRgba(
  src: Uint8Array,
  dst: Uint8ClampedArray,
  width: number,
  rect: EmulatorWorkerVideoBlitRect,
) {
  for (let y = rect.top; y < rect.bottom; y++) {
    let i = (y * width + rect.left) * 4;
    const end = (y * width + rect.right) * 4;
    for (; i < end; i += 4) {
      dst[i + 0] = src[i + 2];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 0];
      dst[i + 3] = 0xff;
    }
  }
}

// ── Networking with progress (used for non-streaming fetches) ────────
// Kept around so the loader can show progress on the manifest fetch if it
// ever grows large enough to warrant it. For now the manifest is < 50KB
// and one shot is fine.

// ── DOM ──────────────────────────────────────────────────────────────

function renderShell(mount: HTMLElement): LoaderHandles {
  const setPhase = (phase: LoaderPhase) => {
    // CAREFUL: once we transition to `running` the canvas is mounted in
    // place — we MUST NOT touch innerHTML or we'll wipe it. Only re-render
    // for phases that own the mount as their own DOM tree.
    if (phase.kind === "running") return;
    mount.innerHTML = renderPhase(phase);
  };
  setPhase({ kind: "idle" });
  return { mount, setPhase };
}

export function mountCanvas(
  mount: HTMLElement,
  screen: { width: number; height: number },
): HTMLCanvasElement {
  mount.innerHTML = "";
  const canvas = document.createElement("canvas");
  canvas.id = "emulator-canvas";
  canvas.width = screen.width;
  canvas.height = screen.height;
  canvas.className = "emulator-canvas";
  canvas.tabIndex = 0;
  mount.appendChild(canvas);
  return canvas;
}

function renderPhase(phase: LoaderPhase): string {
  switch (phase.kind) {
    case "idle":
      return progressBlock("Initializing…", 0, 0);
    case "fetching":
      return progressBlock(phase.label, phase.loadedBytes, phase.totalBytes);
    case "starting":
      return progressBlock(phase.detail, 1, 1);
    case "running":
      return ""; // canvas takes over
    case "stub":
      return stubBlock(phase.reason);
    case "error":
      return errorBlock(phase.message);
  }
}

function progressBlock(label: string, loaded: number, total: number): string {
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  const counter =
    total > 0
      ? `${formatBytes(loaded)} / ${formatBytes(total)}`
      : loaded > 0
        ? formatBytes(loaded)
        : "";
  return /* html */ `
    <div class="loader" role="status" aria-live="polite">
      <div class="loader__label">${escapeHtml(label)}</div>
      <div class="loader__bar" aria-hidden="true">
        <div class="loader__bar-fill" style="width:${pct}%"></div>
      </div>
      <div class="loader__counter">${escapeHtml(counter)}</div>
    </div>
  `;
}

function stubBlock(reason: string): string {
  return /* html */ `
    <div class="loader loader--stub" role="status">
      <div class="loader__label">Welcome to Macintosh.</div>
      <p class="loader__note">
        Stub: emulator integration in progress.
      </p>
      <p class="loader__note loader__note--small">
        ${escapeHtml(reason)}
      </p>
    </div>
  `;
}

function errorBlock(message: string): string {
  return /* html */ `
    <div class="loader loader--error" role="alert">
      <div class="loader__label">Sorry, a system error occurred.</div>
      <p class="loader__note loader__note--small">${escapeHtml(message)}</p>
    </div>
  `;
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
