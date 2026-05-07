/**
 * emulator-loader.ts — owns the BasiliskII boot lifecycle.
 *
 * Renders into the `#emulator-canvas-mount` slot inside the marketer's
 * "Macintosh" window chrome (see main.ts). Owns:
 *   - period-styled progress UI ("Loading BasiliskII… 1.7 MB")
 *   - canvas creation
 *   - WASM core fetch + instantiation (planned)
 *   - boot disk + app.dsk mount (planned)
 *
 * ─── Current status ──────────────────────────────────────────────────────
 *
 * The BasiliskII WASM artifacts ARE wired (fetch-emulator.sh pulls them
 * into /emulator/ and we fetch them here). The boot disk is ALSO now
 * wired — `scripts/build-boot-disk.sh` produces `system755-vibe.dsk`,
 * a blessed System 7.5.5 hard-disk image with our Minesweeper
 * pre-installed in `:System Folder:Startup Items:`, and CI publishes
 * it next to index.html. The loader HEAD-checks it on boot.
 *
 * What's still missing is the *worker glue* that drives the BasiliskII
 * Emscripten Module. Reading worker.ts in the upstream confirmed that
 * the .wasm's compiled init path expects a `globalThis.workerApi`
 * exposing video/input/audio/files/clipboard/disks callbacks plus a
 * fully-formed `EmulatorWorkerConfig` (chunked-disk specs, prefs file,
 * device-image header, MAC address, etc). All disk access — even from
 * a single-file image — flows through `EmulatorWorkerChunkedDisk`,
 * which means we'd either chunk our disk and route through the
 * upstream class, or implement an in-memory `EmulatorWorkerDisk` that
 * wraps an ArrayBuffer of our .dsk and slot it into the same disks
 * array. Either way it's a sizable port. Until that lands, the loader
 * runs through the real fetch phase and then enters STUB mode.
 *
 * See LEARNINGS.md 2026-05-08 ("BasiliskII WASM init contract") for
 * the full rationale.
 *
 * Once that's unblocked, the actual boot path is roughly:
 *
 *   1. Fetch boot disk manifest JSON, pin chunks ahead of cursor.
 *   2. Build an `EmulatorWorkerConfig` (see Infinite Mac
 *      src/emulator/common/common.ts, EmulatorWorkerConfig type).
 *   3. Spawn the BasiliskII Emscripten Module with `arguments` pointing
 *      at the prefs file (rendered from BasiliskIIPrefs.txt + our disks).
 *   4. The .js loader auto-loads /emulator/BasiliskII.wasm sibling.
 *   5. Wire input events (see emulator-input.ts) into the shared input
 *      buffer at the addresses defined in InputBufferAddresses.
 *
 * Reference paths in upstream (mihaip/infinite-mac, pinned in
 * scripts/fetch-emulator.sh):
 *   src/emulator/worker/worker.ts          -- boot orchestration
 *   src/emulator/worker/emulators.ts       -- prefs + disk wiring
 *   src/emulator/common/common.ts          -- shared types + chunk URL
 *   src/emulator/ui/config.ts              -- configToMacemuPrefs()
 */

import type { EmulatorConfig } from "./emulator-config";
// wireInput will be called from within boot() once the BasiliskII worker
// glue is ported (see the file-level comment). Re-exported now so the
// surface is reachable from a future thin shim without re-rooting the
// import graph, and so tsc with noUnusedLocals doesn't complain about
// the imported symbol while we wait for the port to land.
export { wireInput } from "./emulator-input";

type LoaderPhase =
  | { kind: "idle" }
  | { kind: "fetching"; label: string; loadedBytes: number; totalBytes: number }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "stub"; reason: string }
  | { kind: "error"; message: string };

interface LoaderHandles {
  mount: HTMLElement;
  /** Replaces mount contents wholesale and re-binds DOM refs. */
  setPhase(phase: LoaderPhase): void;
}

/** Public entry point. Returns an abort-able handle. */
export function startEmulator(
  config: EmulatorConfig,
  mount: HTMLElement,
): { dispose(): void } {
  const handles = renderShell(mount);
  const ac = new AbortController();

  void boot(config, handles, ac.signal).catch((err) => {
    console.error("[emulator] boot failed:", err);
    handles.setPhase({
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    dispose: () => ac.abort(),
  };
}

// ── Boot sequence ─────────────────────────────────────────────────────

async function boot(
  config: EmulatorConfig,
  handles: LoaderHandles,
  signal: AbortSignal,
): Promise<void> {
  // Phase 1: pull the BasiliskII core. Real bytes; we surface progress.
  await fetchWithProgress(config.coreUrl, "Loading BasiliskII…", handles, signal);
  await fetchWithProgress(config.wasmUrl, "Loading WebAssembly core…", handles, signal);

  // Phase 2: HEAD-check the disk images so missing artifacts surface
  // immediately in the network panel and the console. We tolerate 404 on
  // either disk: a fresh fork that hasn't run CI yet won't have them, and
  // we still want the emulator UI to render through to the stub state
  // rather than crash with a fetch error.
  let bootDiskOk = false;
  if (config.bootDiskUrl) {
    try {
      const r = await fetch(config.bootDiskUrl, { method: "HEAD", signal });
      bootDiskOk = r.ok;
      if (!r.ok && r.status !== 404) {
        console.warn("[emulator] boot disk HEAD returned", r.status);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        console.warn("[emulator] boot disk HEAD failed:", err);
      }
    }
  }
  try {
    const r = await fetch(config.appDiskUrl, { method: "HEAD", signal });
    if (!r.ok && r.status !== 404) {
      console.warn("[emulator] app.dsk HEAD returned", r.status);
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") {
      console.warn("[emulator] app.dsk HEAD failed:", err);
    }
  }

  // Phase 3: boot. Always falls into STUB until the BasiliskII WASM worker
  // glue is ported (see the file-level comment and LEARNINGS.md). The
  // boot disk URL itself is wired and CI publishes it; the blocker is
  // now the Module init contract, not the disk.
  //
  // Once the worker glue lands, the real init path goes roughly:
  //   1. Chunk the boot disk (or wrap it as an in-memory
  //      EmulatorWorkerDisk that satisfies the read/write/size/name
  //      contract from Infinite Mac's `worker/disks.ts`).
  //   2. Build EmulatorWorkerConfig (see Infinite Mac common.ts).
  //   3. Spawn the BasiliskII Emscripten Module with `arguments`
  //      pointing at the rendered prefs file (BasiliskIIPrefs.txt
  //      template) and a `globalThis.workerApi` exposing the
  //      EmulatorWorkerApi surface.
  //   4. Wire input via wireInput(canvas) — see emulator-input.ts —
  //      and create the canvas with mountCanvas(handles.mount, ...).
  //
  // Reference paths in upstream (mihaip/infinite-mac@30112da0db):
  //   src/emulator/worker/worker.ts          startEmulator(), EmulatorWorkerApi
  //   src/emulator/worker/chunked-disk.ts    EmulatorWorkerChunkedDisk
  //   src/emulator/worker/disks.ts           EmulatorWorkerDisk interface
  //   src/emulator/common/common.ts          EmulatorWorkerConfig
  //   src/emulator/ui/config.ts              configToMacemuPrefs()
  handles.setPhase({
    kind: "stub",
    reason: bootDiskOk
      ? "System 7.5.5 boot disk fetched successfully. The BasiliskII WASM " +
        "core still needs worker-side glue (EmulatorWorkerApi: video, " +
        "input, audio, disks, clipboard, files, BasiliskIIPrefs.txt, " +
        "device-image header) that hasn't been ported from Infinite Mac " +
        "yet — see emulator-loader.ts header and LEARNINGS.md."
      : "BasiliskII core downloaded but the boot disk did not respond OK. " +
        "If this is a fresh fork, run the build pipeline to produce " +
        "system755-vibe.dsk. See PRD.md Component 3.",
  });
}

// ── Networking with progress ──────────────────────────────────────────

async function fetchWithProgress(
  url: string,
  label: string,
  handles: LoaderHandles,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  handles.setPhase({ kind: "fetching", label, loadedBytes: 0, totalBytes: 0 });

  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`${label} HTTP ${res.status}`);
  }

  const totalHeader = res.headers.get("content-length");
  const totalBytes = totalHeader ? parseInt(totalHeader, 10) : 0;

  if (!res.body) {
    // Old browser fallback — no streaming progress.
    const buf = await res.arrayBuffer();
    handles.setPhase({
      kind: "fetching",
      label,
      loadedBytes: buf.byteLength,
      totalBytes: buf.byteLength,
    });
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      handles.setPhase({
        kind: "fetching",
        label,
        loadedBytes: loaded,
        totalBytes,
      });
    }
  }

  // Concatenate.
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

// ── DOM ──────────────────────────────────────────────────────────────

function renderShell(mount: HTMLElement): LoaderHandles {
  const setPhase = (phase: LoaderPhase) => {
    mount.innerHTML = renderPhase(phase);
  };
  setPhase({ kind: "idle" });
  return { mount, setPhase };
}

// Exported so a future thin shim that drives the BasiliskII Emscripten
// Module can swap the loader UI for the real canvas without re-rooting
// the import graph. See the boot()-phase 3 comment for the full path.
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
  // Tabindex so the canvas can receive keyboard focus.
  canvas.tabIndex = 0;
  mount.appendChild(canvas);
  return canvas;
}

function renderPhase(phase: LoaderPhase): string {
  switch (phase.kind) {
    case "idle":
      return progressBlock("Initializing…", 0, 0);
    case "fetching": {
      return progressBlock(phase.label, phase.loadedBytes, phase.totalBytes);
    }
    case "starting":
      return progressBlock("Starting Macintosh…", 1, 1);
    case "running":
      // Canvas takes over; this branch isn't normally rendered (mountCanvas
      // wipes the mount), but we keep it for completeness.
      return "";
    case "stub":
      return stubBlock(phase.reason);
    case "error":
      return errorBlock(phase.message);
  }
}

function progressBlock(label: string, loaded: number, total: number): string {
  const pct =
    total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
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

// ── Helpers ──────────────────────────────────────────────────────────

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
