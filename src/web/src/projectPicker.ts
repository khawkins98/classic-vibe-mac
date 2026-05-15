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
      "In-browser-only demo. C source compiles end-to-end in this tab — no CI involved. Start here to see the full wasm-cc1 pipeline in action.",
  },
  reader: {
    emoji: "📖",
    description:
      "HTML viewer. Multi-file C + .r. Demonstrates the Toolbox-shell + pure-C-engine split and the URL-bar request/response over extfs.",
  },
  macweather: {
    emoji: "☁️",
    description:
      "Live weather forecast. Host page polls open-meteo, drops JSON into the Mac via :Unix:, MacWeather watches + redraws with QuickDraw glyphs.",
  },
  "hello-mac": {
    emoji: "👋",
    description:
      "Smallest possible Toolbox app — one window, one string, a Quit menu. Start here if 68k Mac Toolbox is new to you.",
  },
  "pixel-pad": {
    emoji: "🖌",
    description:
      "QuickDraw drawing app. Live PNG preview of your 64×64 1-bit canvas appears alongside the Mac via the extfs bridge.",
  },
  "markdown-viewer": {
    emoji: "📝",
    description:
      "Renders .md files from :Shared: on the boot disk. Add your own markdown in the shared folder; reload to see it parsed.",
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
    class: ["no-min", "no-max", "cvm-picker-winbox"],
  });

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
