/**
 * WinBox-based startup project picker (cv-mac #104 Phase 3).
 *
 * Renders a modal-style chooser listing every `SAMPLE_PROJECTS` entry
 * as a card with icon + label + description. The user clicks a card;
 * `onPick(projectId)` fires; the modal closes. Includes stubbed
 * "Open .zip…" and "New empty…" rows for Phase 5.
 *
 * No coupling to the playground's internal state — the caller is
 * responsible for actually switching projects (we delegate via
 * dispatching a `change` event on the existing `#cvm-pg-project`
 * dropdown in main.ts).
 *
 * WinBox docs: https://nextapps-de.github.io/winbox/
 */

// WinBox's published npm package has a broken `main` field (points at a
// `src/js/winbox.js` that isn't in the tarball). The dist/ tree IS shipped,
// so we side-effect-import the prebuilt bundle (attaches `WinBox` to
// `window`) and reach for it through the global at runtime.
import "winbox/dist/winbox.bundle.min.js";

import { SAMPLE_PROJECTS, type SampleProject } from "./playground/types";
import { enableShade } from "./winboxChrome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

/** Per-project icon + one-line description shown in the picker. */
interface PickerEntry {
  emoji: string;
  description: string;
}
const PICKER_ENTRIES: Record<string, PickerEntry> = {
  "wasm-hello": {
    emoji: "✨",
    description:
      "Smallest in-browser-built demo. Single hello.c, no resources, no window — just InitGraf + DrawString on the desktop port. Start here to see the full wasm-cc1 pipeline in action.",
  },
  "wasm-hello-multi": {
    emoji: "📚",
    description:
      "Multi-file C. main.c + greet.c + greet.h linked together by ld. Demonstrates the multi-translation-unit build path landed in cv-mac #113.",
  },
  "wasm-hello-window": {
    emoji: "🪟",
    description:
      "Mixed C + .r build. Compiles a real WIND resource alongside the C code and splices the two forks. Same path used by Wasm Snake.",
  },
  "wasm-snake": {
    emoji: "🐍",
    description:
      "Playable Snake clone. Arrow keys steer, eat apples to grow, click to restart on game over. Demonstrates a real event loop, TickCount-driven movement, QuickDraw rendering — all built in your browser.",
  },
  "wasm-textedit": {
    emoji: "✏️",
    description:
      "Editable TextEdit field in a draggable window. Type to insert, click to position the caret, click the close box to quit. Built on the Toolbox's native TEHandle — the foundation a real word processor would extend.",
  },
  "wasm-notepad": {
    emoji: "📝",
    description:
      "TextEdit + a real Mac menu bar. Apple / File / Edit menus, Cmd-key shortcuts (⌘N, ⌘Q, ⌘X, ⌘C, ⌘V), and a working About dialog. The ladder rung between an edit field and a mini word processor.",
  },
  "wasm-stickynote": {
    emoji: "🟨",
    description:
      "Small floating sticky-note window with a pale-yellow paper background and a single TextEdit field. Draggable, close-to-quit. Exercises QuickDraw colour (RGBForeColor / RGBBackColor) — the other TextEdit samples are monochrome.",
  },
  "wasm-wordpad": {
    emoji: "📄",
    description:
      "Mini word processor — Font (Geneva/Chicago/Monaco/Courier), Size (9/10/12/14/18/24), and Style (Plain/Bold/Italic/Underline) menus live-restyle a monostyle TextEdit. Apple/File/Edit shape mirrors Notepad. The next ladder rung after Notepad on the way to per-run TEStyleNew formatting.",
  },
  "wasm-clock": {
    emoji: "🕰️",
    description:
      "Analog desk clock with a digital readout below. GetDateTime + SecondsToDate for the time; a 60-tick WaitNextEvent timeout ticks the second hand once a second; QuickDraw FrameOval / MoveTo / LineTo / FillOval for the hands and pivot. Hand-rolled sin/cos table — no libm pulled in.",
  },
  "wasm-multiwin": {
    emoji: "🪟",
    description:
      "Three windows open at launch, one event loop. Click any back window to raise it (SelectWindow), drag any titlebar to move, close any to dismiss. Each window stores its own pattern index in its refCon and fills itself with a different system pattern. Last close exits.",
  },
  "wasm-cursor": {
    emoji: "🖱️",
    description:
      "Cursor Manager demo. Four labelled quadrants — moving the mouse between them swaps the cursor via GetCursor + SetCursor (arrow / I-beam / watch / cross-hair). Classic Mac \"poll the mouse on idle, change cursor by region\" pattern since the OS has no enter/leave events.",
  },
  "wasm-calculator": {
    emoji: "🔢",
    description:
      "4-function calculator. 16 buttons drawn directly to the window port, hit-tested via PtInRect, display formatted with NumToString. Demonstrates the playground can ship classic Mac apps without any TextEdit / scrap entanglement.",
  },
  "wasm-scribble": {
    emoji: "🖌",
    description:
      "Mouse-tracking draw demo. Click + drag in the window to draw; the inner StillDown / GetMouse / LineTo loop is the classic Mac drag-to-draw pattern from Inside Mac: Macintosh Toolbox Essentials ch. 1. Click Clear to wipe; click outside the window to quit.",
  },
  "wasm-scrollwin": {
    emoji: "📜",
    description:
      "Scrolling list with a real Mac scroll bar. NewControl(scrollBarProc) + TrackControl with a live actionProc for the arrows and page regions. Arrow keys also scroll. 50 items, fits about 13 at a time — drag the thumb to jump.",
  },
  "wasm-patterns": {
    emoji: "🧵",
    description:
      "QuickDraw pattern gallery. Four system patterns (white/ltGray/gray/dkGray) plus eight hand-rolled 8x8 bitmaps — stripes, checkers, dots, bricks, weave. Demonstrates the canonical 8-byte Pattern shape and FillRect.",
  },
  "wasm-bounce": {
    emoji: "🏐",
    description:
      "Bouncing ball with no-flicker double-buffer rendering. Hand-constructs an offscreen 1-bit BitMap, draws into it each tick, then CopyBits the whole frame onto the window in one shot — the canonical animated-Mac-app pattern.",
  },
  "wasm-dialog": {
    emoji: "💬",
    description:
      "ModalDialog with an editable text field. Click the button → modal opens with a prompt, EditText field, OK + Cancel. OK reads the typed answer with GetIText and draws \"Hello, <name>!\" back to the main window.",
  },
  "wasm-sound": {
    emoji: "🔔",
    description:
      "Sound Manager SysBeep demo — \"Beep\" plays one alert tone, \"Triple Beep\" plays three back-to-back. BasiliskII collapses SysBeep's duration parameter to a fixed-length alert, so making the difference audible means firing multiple beeps rather than asking for a longer one.",
  },
  "wasm-color": {
    emoji: "🌈",
    description:
      "Color QuickDraw demo: the canonical 1990 Macintosh II 6-colour palette painted as labelled stripes (red, yellow, green, cyan, blue, magenta). RGBColor + RGBForeColor + PaintRect. On a 1-bit display the colours quantise to black/white — Color QuickDraw's documented degradation path.",
  },
};

function entryFor(p: SampleProject): PickerEntry {
  return PICKER_ENTRIES[p.id] ?? { emoji: "📄", description: p.label };
}

export interface OpenPickerOptions {
  /** Which project is currently selected, so we can highlight it. */
  currentProjectId: string;
  /** Called with the chosen project id when the user picks one. */
  onPick: (projectId: string) => void;
  /** Called when the user clicks "Open .zip…". Phase 5 — wire to the
   *  zipImport module. The picker closes after this fires. */
  onOpenZip?: () => void;
}

/**
 * Open the startup picker. The returned `close()` lets the caller
 * dismiss it programmatically (e.g. if a project switch happens via
 * another control while the picker is open).
 */
export function openProjectPicker(opts: OpenPickerOptions): { close: () => void } {
  const content = document.createElement("div");
  content.className = "cvm-picker";
  content.innerHTML = renderPickerHtml(opts.currentProjectId);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Open project — classic-vibe-mac",
    width: "640px",
    height: "560px",
    x: "center",
    y: "center",
    mount: content,
    modal: true,
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-picker-winbox", "cvm-mac-winbox"],
  });
  enableShade(wb);

  // Card click → dispatch picked project.
  content.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const openZipBtn = target.closest<HTMLButtonElement>(
      "[data-action='open-zip']",
    );
    if (openZipBtn && !openZipBtn.disabled) {
      opts.onOpenZip?.();
      wb.close();
      return;
    }
    const card = target.closest<HTMLElement>(".cvm-picker__card");
    if (!card) return;
    const pid = card.dataset.projectId;
    if (!pid) return;
    opts.onPick(pid);
    wb.close();
  });

  return {
    close: () => wb.close(),
  };
}

function renderPickerHtml(currentProjectId: string): string {
  const cards = SAMPLE_PROJECTS.map((p) => {
    const entry = entryFor(p);
    const active = p.id === currentProjectId ? "cvm-picker__card--active" : "";
    return `
      <button class="cvm-picker__card ${active}"
              type="button"
              data-project-id="${p.id}">
        <span class="cvm-picker__icon">${entry.emoji}</span>
        <strong class="cvm-picker__name">${escapeHtml(p.label)}</strong>
        <small class="cvm-picker__desc">${escapeHtml(entry.description)}</small>
      </button>
    `;
  }).join("");
  return `
    <h3 class="cvm-picker__heading">Open a project</h3>
    <p class="cvm-picker__lede">
      Click a card to load it. Your edits in the current project are
      saved automatically (IndexedDB) so switching is non-destructive.
    </p>
    <div class="cvm-picker__grid">${cards}</div>
    <hr class="cvm-picker__rule" />
    <div class="cvm-picker__footer">
      <button type="button"
              class="cvm-picker__action"
              data-action="open-zip"
              title="Restore a project from a .zip exported by this playground">
        Open .zip…
      </button>
      <button type="button"
              class="cvm-picker__action"
              disabled
              title="Coming with cv-mac #100 (multi-file projects)">
        New empty project…
      </button>
      <small class="cvm-picker__note">
        Future: multi-file scaffold, recent projects. Tracked in
        <a href="https://github.com/khawkins98/classic-vibe-mac/issues/100" target="_blank">#100</a>.
      </small>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
