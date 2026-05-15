/**
 * Preferences palette — opened from the Edit menu.
 *
 * Mac OS 8-style modeless prefs window. Houses settings previously
 * scattered across the editor toolbar (OPTIMIZE level) and the Mac
 * pane caption (Pause when hidden). New settings should land here
 * rather than getting bolted onto random work surfaces.
 *
 * State lives in settings.ts; this palette just renders the controls
 * + writes through the setters. Consumers (editor.ts, emulator-loader)
 * react via the existing onOptLevelChange / onPauseWhenHiddenChange
 * pub/sub.
 */

import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "./winboxChrome";
import {
  getOptLevel,
  setOptLevel,
  onOptLevelChange,
  isPauseWhenHiddenEnabled,
  setPauseWhenHidden,
  onPauseWhenHiddenChange,
} from "./settings";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

let active: { focus: () => void; close: () => void } | null = null;

export function openPreferences(): void {
  if (active) {
    active.focus();
    return;
  }

  const content = document.createElement("div");
  content.className = "cvm-prefs";
  content.innerHTML = renderHtml();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Preferences",
    width: "440px",
    height: "360px",
    x: "center",
    y: "center",
    mount: content,
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-prefs-winbox", "cvm-mac-winbox"],
    onclose: () => {
      active = null;
      detach?.();
      return false;
    },
  });
  enableShade(wb);

  const detach = wireControls(content);

  active = { focus: () => wb.focus(), close: () => wb.close() };
}

function renderHtml(): string {
  const level = getOptLevel();
  const pause = isPauseWhenHiddenEnabled();
  return /* html */ `
    <section class="cvm-prefs__section">
      <h3 class="cvm-prefs__heading">Build</h3>
      <label class="cvm-prefs__row">
        <span class="cvm-prefs__label">
          Optimization
          <small>cc1 flag for the in-browser C compile.</small>
        </span>
        <select id="cvm-prefs-opt-level" class="cvm-prefs__select">
          <option value="O0" ${level === "O0" ? "selected" : ""}>-O0 (none)</option>
          <option value="Os" ${level === "Os" ? "selected" : ""}>-Os (size)</option>
          <option value="O2" ${level === "O2" ? "selected" : ""}>-O2 (speed)</option>
        </select>
      </label>
    </section>

    <section class="cvm-prefs__section">
      <h3 class="cvm-prefs__heading">Emulator</h3>
      <label class="cvm-prefs__row cvm-prefs__row--check">
        <input type="checkbox" id="cvm-prefs-pause" ${pause ? "checked" : ""} />
        <span class="cvm-prefs__label">
          Pause when tab is hidden
          <small>Stops the emulator clock while this tab is in the background.</small>
        </span>
      </label>
    </section>
  `;
}

function wireControls(root: HTMLElement): () => void {
  const optSelect = root.querySelector<HTMLSelectElement>("#cvm-prefs-opt-level");
  const pauseChk = root.querySelector<HTMLInputElement>("#cvm-prefs-pause");

  if (optSelect) {
    optSelect.addEventListener("change", () => {
      setOptLevel(optSelect.value as "O0" | "Os" | "O2");
    });
  }
  if (pauseChk) {
    pauseChk.addEventListener("change", () => {
      setPauseWhenHidden(pauseChk.checked);
    });
  }

  // Cross-tab / external changes: keep the inputs in sync.
  const offOpt = onOptLevelChange(() => {
    if (optSelect && optSelect.value !== getOptLevel()) {
      optSelect.value = getOptLevel();
    }
  });
  const offPause = onPauseWhenHiddenChange(() => {
    if (pauseChk && pauseChk.checked !== isPauseWhenHiddenEnabled()) {
      pauseChk.checked = isPauseWhenHiddenEnabled();
    }
  });

  return () => {
    offOpt();
    offPause();
  };
}
