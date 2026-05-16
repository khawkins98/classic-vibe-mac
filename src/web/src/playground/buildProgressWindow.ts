/**
 * Build progress window — a Mac OS 8 "File Copy"-style WinBox that
 * surfaces what the Build / Build & Run pipeline is doing while it
 * runs. Without it, the only feedback the user sees is the small
 * status line below the toolbar updating from "Compiling…" to
 * "Mounting disk…" to "Done in Xms"; on a cold-cache first build
 * (60+ seconds) that's invisible while the page sits doing nothing.
 *
 * Listens for `cvm:build-phase` CustomEvents on window:
 *   detail.phase   — "preparing" | "compiling" | "packaging" |
 *                    "mounting" | "booting" | "done" | "error"
 *   detail.label   — optional override for the step label
 *   detail.message — optional sub-message (e.g. error text)
 *   detail.title   — optional override for the window title
 *
 * "done" auto-closes after a short delay; "error" leaves the window
 * open with the last status visible so the user can see what failed.
 *
 * Singleton — re-clicking Build reuses the same WinBox and resets
 * its phase list.
 */

import "winbox/dist/winbox.bundle.min.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

type Phase =
  | "preparing"
  | "compiling"
  | "packaging"
  | "mounting"
  | "booting"
  | "done"
  | "error";

interface BuildPhaseEvent {
  phase: Phase;
  label?: string;
  message?: string;
  title?: string;
}

// Ordered list of phases we display. Phases not yet seen render blank;
// the current phase renders with the ⌛ marker; completed phases get
// a ✓ and a "(Xms)" suffix. "error" replaces the current phase's
// marker with ✕ but keeps the list otherwise intact.
const PHASE_ORDER: Phase[] = [
  "preparing",
  "compiling",
  "packaging",
  "mounting",
  "booting",
];

const DEFAULT_LABELS: Record<Phase, string> = {
  preparing: "Preparing sources",
  compiling: "Compiling C and Rez",
  packaging: "Packaging MacBinary",
  mounting: "Mounting disk",
  booting: "Booting Macintosh",
  done: "Done",
  error: "Build failed",
};

interface PhaseState {
  status: "pending" | "active" | "done" | "error";
  startMs?: number;
  durationMs?: number;
  label: string;
}

interface Active {
  wb: { focus: () => void; close: () => void; setTitle?: (s: string) => void };
  phases: Map<Phase, PhaseState>;
  startMs: number;
  elapsedTimer: number | null;
  closeTimer: number | null;
  errored: boolean;
}

let active: Active | null = null;

function ensureWindow(title: string): Active {
  if (active) {
    // Reuse — reset for a fresh build.
    if (active.closeTimer !== null) {
      clearTimeout(active.closeTimer);
      active.closeTimer = null;
    }
    active.phases = newPhases();
    active.startMs = performance.now();
    active.errored = false;
    active.wb.setTitle?.(title);
    render();
    return active;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title,
    width: "360px",
    height: "240px",
    x: "center",
    y: 60,
    html: shellHtml(),
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-buildprogress-winbox", "cvm-mac-winbox"],
    onclose: () => {
      if (active && active.elapsedTimer !== null) {
        clearInterval(active.elapsedTimer);
      }
      active = null;
      return false;
    },
  });
  active = {
    wb,
    phases: newPhases(),
    startMs: performance.now(),
    elapsedTimer: window.setInterval(renderElapsed, 100),
    closeTimer: null,
    errored: false,
  };
  render();
  return active;
}

function newPhases(): Map<Phase, PhaseState> {
  const m = new Map<Phase, PhaseState>();
  for (const p of PHASE_ORDER) {
    m.set(p, { status: "pending", label: DEFAULT_LABELS[p] });
  }
  return m;
}

function shellHtml(): string {
  // Layout mirrors a Mac OS 8 "Copy" dialog: top zone shows the current
  // step in large type with the barber-pole bar; the phase list sits
  // below as a checklist with timing per phase.
  return /* html */ `
    <div class="cvm-buildprogress">
      <div class="cvm-buildprogress__current">
        <div class="cvm-buildprogress__step" id="cvm-bp-step">Starting build…</div>
        <div class="cvm-buildprogress__bar" id="cvm-bp-bar">
          <div class="cvm-buildprogress__bar-fill"></div>
        </div>
        <div class="cvm-buildprogress__elapsed" id="cvm-bp-elapsed">0.0s elapsed</div>
      </div>
      <ul class="cvm-buildprogress__list" id="cvm-bp-list"></ul>
      <div class="cvm-buildprogress__message" id="cvm-bp-message" hidden></div>
    </div>
  `;
}

function renderElapsed(): void {
  if (!active) return;
  const el = document.getElementById("cvm-bp-elapsed");
  if (!el) return;
  const elapsed = ((performance.now() - active.startMs) / 1000).toFixed(1);
  el.textContent = `${elapsed}s elapsed`;
}

function render(): void {
  if (!active) return;
  const list = document.getElementById("cvm-bp-list");
  const stepEl = document.getElementById("cvm-bp-step");
  const bar = document.getElementById("cvm-bp-bar");
  if (!list || !stepEl || !bar) return;

  list.innerHTML = "";
  // Current step = the active phase, else the latest completed/errored one.
  let currentLabel = "Starting build…";
  for (const p of PHASE_ORDER) {
    const st = active.phases.get(p)!;
    const li = document.createElement("li");
    li.className = `cvm-buildprogress__item cvm-buildprogress__item--${st.status}`;
    const marker = document.createElement("span");
    marker.className = "cvm-buildprogress__marker";
    marker.textContent =
      st.status === "done"   ? "✓" :
      st.status === "active" ? "⌛" :
      st.status === "error"  ? "✕" : "·";
    const lab = document.createElement("span");
    lab.className = "cvm-buildprogress__label";
    lab.textContent = st.label;
    const timing = document.createElement("span");
    timing.className = "cvm-buildprogress__timing";
    if (st.durationMs !== undefined) {
      timing.textContent = `${st.durationMs.toFixed(0)}ms`;
    }
    li.append(marker, lab, timing);
    list.append(li);
    if (st.status === "active") currentLabel = st.label + "…";
    else if (st.status === "done" || st.status === "error") currentLabel = st.label;
  }
  stepEl.textContent = currentLabel;
  // Stop the barber-pole animation in terminal states so the UI signals
  // "no more work happening" visually.
  bar.classList.toggle(
    "cvm-buildprogress__bar--idle",
    active.errored ||
      [...active.phases.values()].every((s) => s.status !== "active"),
  );
}

function handlePhase(evt: BuildPhaseEvent): void {
  const isStart = evt.phase === "preparing";
  const title = evt.title ?? "Building…";
  const a = isStart ? ensureWindow(title) : active ?? ensureWindow(title);

  if (evt.phase === "done") {
    // Mark the latest active phase done if any.
    for (const p of PHASE_ORDER) {
      const st = a.phases.get(p)!;
      if (st.status === "active" && st.startMs !== undefined) {
        st.status = "done";
        st.durationMs = performance.now() - st.startMs;
      }
    }
    a.wb.setTitle?.("Done");
    if (a.elapsedTimer !== null) {
      clearInterval(a.elapsedTimer);
      a.elapsedTimer = null;
    }
    render();
    // Auto-close after a short pause so the user can see the final state.
    a.closeTimer = window.setTimeout(() => {
      a.wb.close();
    }, 1200);
    return;
  }

  if (evt.phase === "error") {
    a.errored = true;
    // Mark whichever phase was active as errored.
    for (const p of PHASE_ORDER) {
      const st = a.phases.get(p)!;
      if (st.status === "active" && st.startMs !== undefined) {
        st.status = "error";
        st.durationMs = performance.now() - st.startMs;
      }
    }
    a.wb.setTitle?.("Build failed");
    if (a.elapsedTimer !== null) {
      clearInterval(a.elapsedTimer);
      a.elapsedTimer = null;
    }
    const msgEl = document.getElementById("cvm-bp-message");
    if (msgEl) {
      msgEl.textContent = evt.message ?? "An error occurred during the build.";
      msgEl.hidden = false;
    }
    render();
    return;
  }

  // Regular phase transition: complete any earlier active phase, then
  // mark this one active. Phases can be skipped (Build doesn't use
  // "mounting"/"booting"), so completing-by-walk-the-order works.
  const idx = PHASE_ORDER.indexOf(evt.phase);
  if (idx < 0) return;
  for (let i = 0; i <= idx; i++) {
    const st = a.phases.get(PHASE_ORDER[i]!)!;
    if (i < idx) {
      if (st.status === "active" && st.startMs !== undefined) {
        st.durationMs = performance.now() - st.startMs;
      }
      if (st.status !== "done" && st.status !== "error") {
        st.status = "done";
        if (st.durationMs === undefined && st.startMs !== undefined) {
          st.durationMs = performance.now() - st.startMs;
        }
      }
    } else {
      st.status = "active";
      st.startMs = performance.now();
      if (evt.label) st.label = evt.label;
    }
  }
  render();
}

/** Wire the global event listener once. main.ts calls this at startup. */
export function installBuildProgressWindow(): void {
  window.addEventListener("cvm:build-phase", ((e: Event) => {
    const ev = (e as CustomEvent<BuildPhaseEvent>).detail;
    if (!ev) return;
    handlePhase(ev);
  }) as EventListener);
}

/** Helper for editor.ts to fire a phase event with minimal ceremony. */
export function dispatchBuildPhase(detail: BuildPhaseEvent): void {
  window.dispatchEvent(new CustomEvent("cvm:build-phase", { detail }));
}
