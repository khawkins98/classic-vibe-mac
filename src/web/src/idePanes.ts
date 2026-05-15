/**
 * idePanes.ts — wrap the four docked IDE panes (Project / Editor /
 * Macintosh / Output) in WinBox windows so they're draggable,
 * resizable, raise/lower-able, and shade-on-double-clickable.
 *
 * Replaces the CSS-grid layout that was Phase 2 of #104. Panes are
 * positioned at startup to match the previous grid (Files 0-20% wide,
 * Editor 20-60% wide, Mac 60-100% top 60%, Output 60-100% bottom 40%)
 * but the user can move/resize freely thereafter.
 *
 * Each pane uses:
 *   - `no-close` — these are work surfaces, not palettes
 *   - `no-full`  — fullscreen toggle is meaningless here
 *   - `enableShade(wb)` — Mac-OS-8 window-shade on titlebar double-click
 *
 * The pane bodies preserve the same IDs/classes as the pre-refactor
 * markup, so downstream wiring (main.ts file-list, mountPlayground,
 * emulator canvas lookup) keeps working without changes.
 */

// WinBox's published npm package has a broken `main` field — side-effect
// import the bundle and reach for the global at runtime. Same pattern as
// projectPicker / helpPalette / build-explainer.
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "./winboxChrome";
import { SAMPLE_PROJECTS } from "./playground/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

export type PaneKey = "files" | "editor" | "mac" | "output";

export interface IdePaneHandles {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  files: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mac: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output: any;
  /** Reset all four panes to their initial tiled positions (e.g. after
   *  the user has dragged them off-screen). */
  reset: () => void;
}

const MENUBAR_HEIGHT = 24;
const GAP = 4;

/** Compute initial tile coordinates from the viewport size. We compute
 *  pixel values once at mount; resizing the browser does not re-tile. */
function initialLayout() {
  const vw = window.innerWidth;
  const vh = window.innerHeight - MENUBAR_HEIGHT;
  // 20/40/40 column split matching the pre-refactor grid.
  const filesW = Math.max(220, Math.floor(vw * 0.2));
  const editorW = Math.max(420, Math.floor(vw * 0.4));
  const rightW = Math.max(360, vw - filesW - editorW - GAP * 3);
  // Right column split 60/40 top/bottom.
  const macH = Math.max(280, Math.floor(vh * 0.6));
  const outputH = Math.max(160, vh - macH - GAP);
  const top = MENUBAR_HEIGHT + GAP;
  return {
    files:  { x: GAP,                                 y: top,                w: filesW,  h: vh - GAP },
    editor: { x: GAP + filesW + GAP,                  y: top,                w: editorW, h: vh - GAP },
    mac:    { x: GAP + filesW + GAP + editorW + GAP,  y: top,                w: rightW,  h: macH },
    output: { x: GAP + filesW + GAP + editorW + GAP,  y: top + macH + GAP,   w: rightW,  h: outputH },
  };
}

function filesHtml(): string {
  return /* html */ `
    <div class="cvm-files">
      <div class="cvm-files__project">
        <label class="cvm-files__project-label" for="cvm-files-project">
          Project
        </label>
        <select id="cvm-files-project"
                class="cvm-files__select"
                aria-label="Switch project">
          ${SAMPLE_PROJECTS.map(
            (p) => `<option value="${p.id}">${p.label}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="cvm-files__section">Files</div>
      <ul class="cvm-files__list"
          id="cvm-files-list"
          role="listbox"
          aria-label="Files in this project"></ul>
      <div class="cvm-files__footer">
        <button type="button"
                id="cvm-files-open"
                class="cvm-files__btn cvm-files__btn--primary">
          Open project…
        </button>
        <p class="cvm-files__hint">
          Multi-file projects + .zip import coming with
          <a href="https://github.com/khawkins98/classic-vibe-mac/issues/100">#100</a>.
        </p>
      </div>
    </div>
  `;
}

function editorHtml(): string {
  // mountPlayground() looks up #cvm-playground by ID and fills it in.
  return /* html */ `
    <section id="cvm-playground"
             class="window--playground"
             aria-labelledby="title-playground"></section>
  `;
}

function macHtml(): string {
  return /* html */ `
    <div class="cvm-ide__mac-body">
      <div class="inset" id="emulator">
        <div id="emulator-canvas-mount" class="emulator-mount"></div>
      </div>
      <div class="emulator-caption" role="group" aria-label="Emulator status">
        <span class="emulator-caption__status" id="cvm-pause-status" aria-live="polite"></span>
      </div>
    </div>
  `;
}

function outputHtml(): string {
  return /* html */ `
    <div class="cvm-output">
      <div class="cvm-output__tabbar" role="tablist" aria-label="Output panel">
        <button type="button"
                class="cvm-output__tab cvm-output__tab--active"
                role="tab"
                data-pane="buildlog"
                aria-selected="true">Build log</button>
        <button type="button"
                class="cvm-output__tab"
                role="tab"
                data-pane="console"
                aria-selected="false">Console</button>
        <span class="cvm-output__tabbar-spacer"></span>
        <button type="button" class="cvm-output__btn" id="cvm-output-clear"
                title="Clear the current tab">Clear</button>
      </div>
      <div class="cvm-output__pane cvm-output__pane--active"
           data-pane="buildlog"
           role="tabpanel"
           aria-label="Build log">
        <pre id="cvm-output-buildlog" class="cvm-output__log"></pre>
      </div>
      <div class="cvm-output__pane"
           data-pane="console"
           role="tabpanel"
           aria-label="Console"
           hidden>
        <p class="cvm-output__hint">
          <strong>Coming soon.</strong> The Console tab will capture
          <code>DebugStr</code> and <code>DrawString</code> output from
          your running Mac app — useful for in-tab debugging without
          looking at the canvas. Tracked in
          <a href="https://github.com/khawkins98/classic-vibe-mac/issues/104">#104</a>.
        </p>
      </div>
    </div>
  `;
}

interface PaneSpec {
  key: PaneKey;
  title: string;
  html: string;
  cssClass: string;
}

/** Build the 4 docked WinBox panes. Returns the handles so callers can
 *  hide/show/focus individual panes or reset the layout. */
export function mountIdePanes(): IdePaneHandles {
  const specs: PaneSpec[] = [
    { key: "files",  title: "Project",    html: filesHtml(),  cssClass: "cvm-pane-files" },
    { key: "editor", title: "Playground", html: editorHtml(), cssClass: "cvm-pane-editor" },
    { key: "mac",    title: "Macintosh",  html: macHtml(),    cssClass: "cvm-pane-mac" },
    { key: "output", title: "Output",     html: outputHtml(), cssClass: "cvm-pane-output" },
  ];

  const layout = initialLayout();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handles: Partial<IdePaneHandles> = {};
  for (const s of specs) {
    const node = document.createElement("div");
    node.innerHTML = s.html.trim();
    const body = node.firstElementChild as HTMLElement;

    const pos = layout[s.key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wb: any = new WinBox({
      title: s.title,
      x: pos.x,
      y: pos.y,
      width: pos.w,
      height: pos.h,
      mount: body,
      background: "#cccccc",
      class: ["no-close", "no-full", "cvm-mac-winbox", s.cssClass],
    });
    enableShade(wb);
    handles[s.key] = wb;
  }

  handles.reset = () => {
    const fresh = initialLayout();
    for (const s of specs) {
      const wb = handles[s.key];
      if (!wb) continue;
      const pos = fresh[s.key];
      try {
        wb.move(pos.x, pos.y, true);
        wb.resize(pos.w, pos.h, true);
        wb.focus();
      } catch {
        /* WinBox shape mismatch — skip */
      }
    }
  };

  return handles as IdePaneHandles;
}
