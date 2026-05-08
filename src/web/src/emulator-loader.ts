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
  type EmulatorWorkerMessage,
  type EmulatorWorkerStartMessage,
  type EmulatorWorkerVideoBlitRect,
} from "./emulator-worker-types";
import { wireInput, setInputBuffer } from "./emulator-input";
import { startWeatherPoller } from "./weather-poller";
import {
  isPauseWhenHiddenEnabled,
  onPauseWhenHiddenChange,
} from "./settings";
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

export function startEmulator(
  config: EmulatorConfig,
  mount: HTMLElement,
): { dispose(): void } {
  const handles = renderShell(mount);
  const ac = new AbortController();
  let worker: Worker | undefined;
  let rafId = 0;
  let unwireInput: (() => void) | undefined;
  let teardownVisibility: (() => void) | undefined;

  void boot(config, handles, ac.signal, (w) => {
    worker = w;
  }, (raf) => {
    rafId = raf;
  }, (un) => {
    unwireInput = un;
  }, (td) => {
    teardownVisibility = td;
  }).catch((err) => {
    if ((err as Error).name === "AbortError") return;
    console.error("[emulator] boot failed:", err);
    handles.setPhase({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    dispose: () => {
      ac.abort();
      if (rafId) cancelAnimationFrame(rafId);
      unwireInput?.();
      teardownVisibility?.();
      worker?.terminate();
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
  signal: AbortSignal,
  setWorker: (w: Worker) => void,
  setRaf: (id: number) => void,
  setUnwire: (un: () => void) => void,
  setTeardownVisibility: (td: () => void) => void,
): Promise<void> {
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
        break;

      case "emulator_error":
        console.error("[emulator] worker error:", m.error);
        handles.setPhase({ kind: "error", message: m.error });
        break;

      case "emulator_stopped":
        console.log("[emulator] worker stopped");
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

  // Fire off the start message.
  const startMsg: EmulatorWorkerStartMessage = {
    type: "start",
    coreUrl: absoluteUrl(config.coreUrl),
    wasmUrl: absoluteUrl(config.wasmUrl),
    romUrl: absoluteUrl(romUrl),
    diskSpecs: [manifest],
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
    startWeatherPoller({
      worker,
      fallbackLat: config.weather.fallbackLat,
      fallbackLon: config.weather.fallbackLon,
    });
  } catch (err) {
    console.warn("[emulator] weather poller failed to start:", err);
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
