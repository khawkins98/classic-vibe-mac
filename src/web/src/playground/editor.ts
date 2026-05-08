/**
 * editor.ts — CodeMirror 6 mount + project/file dropdowns + zip download.
 *
 * Phase 1 scope (per the editor reviewer's "scope down" note on Issue #21):
 *   - One CodeMirror instance, swapped in-place when the file dropdown
 *     changes (no tabs, no file tree).
 *   - C syntax highlighting via `@codemirror/lang-cpp`. `.r` (Rez) gets
 *     no highlighting in Phase 1; that's a Phase 2 item.
 *   - Edits debounce-save to IDB on every keystroke (1s) AND save
 *     immediately on file/project switch.
 *   - "Download project as zip" button packages the user's CURRENT edits
 *     for the selected project as a `.zip` (no boot disks, no build
 *     outputs, just `.c` / `.r` / `.h`).
 *
 * No file-tree, no tabs, no Rez highlighting, no diff UI, no side-by-side
 * layout. Those all live in the deferred "Phase 2+" pile.
 */

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import JSZip from "jszip";

import { SAMPLE_PROJECTS, type SampleProject } from "./types";
import {
  initPersistence,
  isPersistent,
  readOrSeedFile,
  writeFile,
  readUiState,
  writeUiState,
} from "./persistence";

/** UI-state IDB keys. */
const UI_PROJECT = "openProject";
const UI_FILE = "openFile";
const UI_CURSOR = "cursor"; // { project, filename, pos }

/** Save debounce window. 1 second per the spec. */
const SAVE_DEBOUNCE_MS = 1000;

interface PlaygroundContext {
  rootEl: HTMLElement;
  baseUrl: string;
  /** True iff IDB is backing storage. */
  persistent: boolean;
}

/**
 * Build the playground DOM inside `rootEl`. Idempotent on a single mount —
 * call once. Returns a small handle exposing show/hide so the settings
 * checkbox can collapse the section.
 *
 * Layout: a single `<section class="window">` containing
 *   1. caption row (project + file dropdown, download button)
 *   2. CodeMirror mount
 *   3. small caption underneath with the explanatory paragraph + status
 */
export interface PlaygroundHandle {
  setVisible(visible: boolean): void;
}

export async function mountPlayground(
  rootEl: HTMLElement,
  baseUrl: string,
): Promise<PlaygroundHandle> {
  const persistent = await initPersistence();
  const ctx: PlaygroundContext = { rootEl, baseUrl, persistent };

  rootEl.innerHTML = renderShell(persistent);

  const projectSelect = rootEl.querySelector<HTMLSelectElement>(
    "#cvm-pg-project",
  )!;
  const fileSelect = rootEl.querySelector<HTMLSelectElement>("#cvm-pg-file")!;
  const downloadBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-download",
  )!;
  const editorMount = rootEl.querySelector<HTMLDivElement>(
    "#cvm-pg-editor-mount",
  )!;

  // Restore last-open project + file, falling back to the first sample.
  const savedProject = (await readUiState<string>(UI_PROJECT)) ?? "reader";
  const project =
    SAMPLE_PROJECTS.find((p) => p.id === savedProject) ?? SAMPLE_PROJECTS[0]!;
  const savedFile = (await readUiState<string>(UI_FILE)) ?? project.files[0]!;
  const filename = project.files.includes(savedFile)
    ? savedFile
    : project.files[0]!;

  // Seed both dropdowns.
  projectSelect.innerHTML = SAMPLE_PROJECTS.map(
    (p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`,
  ).join("");
  projectSelect.value = project.id;
  populateFileDropdown(fileSelect, project, filename);

  // Mount CodeMirror.
  const initialContent = await readOrSeedFile(baseUrl, project.id, filename);
  const langCompartment = new Compartment();

  // Track the (project, filename) the editor currently shows so save
  // closures don't capture a stale pair after a switch. Declared up here
  // so the updateListener (which fires on the very first render) can
  // safely reference it without hitting a TDZ.
  const current: { project: string; filename: string } = {
    project: project.id,
    filename,
  };

  // Debounced save — fires content into IDB 1s after the user stops typing.
  // Forward-declare the timers and use a getter for `view` since it doesn't
  // exist yet when scheduleSave is defined.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let view!: EditorView;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void writeFile(
        current.project,
        current.filename,
        view.state.doc.toString(),
      );
    }, SAVE_DEBOUNCE_MS);
  }
  function scheduleCursorSave() {
    if (cursorTimer) clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      void writeUiState(UI_CURSOR, {
        project: current.project,
        filename: current.filename,
        pos: view.state.selection.main.head,
      });
    }, SAVE_DEBOUNCE_MS);
  }

  const editorState = EditorState.create({
    doc: initialContent,
    extensions: [
      lineNumbers(),
      history(),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      langCompartment.of(extensionsForFile(filename)),
      EditorView.theme(
        {
          "&": {
            backgroundColor: "#ffffff",
            color: "#000000",
            fontFamily: '"Monaco", "Andale Mono", "Courier New", monospace',
            fontSize: "12px",
          },
          ".cm-content": {
            caretColor: "#000000",
            padding: "8px 0",
          },
          ".cm-gutters": {
            backgroundColor: "#dddddd",
            color: "#666666",
            border: "none",
            borderRight: "1px solid #000000",
          },
          ".cm-activeLine": {
            backgroundColor: "rgba(0,0,0,0.04)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "rgba(0,0,0,0.08)",
          },
          ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection":
            {
              backgroundColor: "#0000aa !important",
              color: "#ffffff",
            },
          "&.cm-focused": {
            outline: "none",
          },
          ".cm-scroller": {
            fontFamily: '"Monaco", "Andale Mono", "Courier New", monospace',
            lineHeight: "1.4",
          },
        },
        { dark: false },
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          scheduleSave();
        }
        if (update.selectionSet) {
          scheduleCursorSave();
        }
      }),
    ],
  });

  view = new EditorView({
    state: editorState,
    parent: editorMount,
  });

  // Test hook: expose the current doc + active file via a window global so
  // Playwright (or other automation) can verify state without depending on
  // CodeMirror's virtualized DOM. Inert in normal use; nothing reads this
  // from page code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__cvm_playground = {
    getDoc: () => view.state.doc.toString(),
    getCurrent: () => ({ ...current }),
    /** Test hook: insert text at the start of the doc, fires the same path
     *  as a user keystroke (debounced save runs). */
    insertAtStart: (text: string) => {
      view.dispatch({
        changes: { from: 0, to: 0, insert: text },
        selection: { anchor: text.length, head: text.length },
      });
    },
  };

  // Restore cursor if it matches the open file.
  const savedCursor = await readUiState<{
    project: string;
    filename: string;
    pos: number;
  }>(UI_CURSOR);
  if (
    savedCursor &&
    savedCursor.project === current.project &&
    savedCursor.filename === current.filename &&
    savedCursor.pos <= view.state.doc.length
  ) {
    view.dispatch({
      selection: { anchor: savedCursor.pos, head: savedCursor.pos },
      scrollIntoView: true,
    });
  }

  /** Flush a pending debounced save synchronously. */
  async function flushSave(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await writeFile(
      current.project,
      current.filename,
      view.state.doc.toString(),
    );
  }

  // Switch the editor's contents to a new file. Saves the previous file
  // first so transient edits don't get dropped.
  async function switchTo(projectId: string, file: string): Promise<void> {
    await flushSave();
    const nextProject = SAMPLE_PROJECTS.find((p) => p.id === projectId);
    if (!nextProject) return;
    const nextFile = nextProject.files.includes(file)
      ? file
      : nextProject.files[0]!;
    const content = await readOrSeedFile(baseUrl, projectId, nextFile);
    current.project = projectId;
    current.filename = nextFile;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      effects: langCompartment.reconfigure(extensionsForFile(nextFile)),
      selection: { anchor: 0, head: 0 },
      scrollIntoView: true,
    });
    await writeUiState(UI_PROJECT, projectId);
    await writeUiState(UI_FILE, nextFile);
  }

  projectSelect.addEventListener("change", () => {
    const newId = projectSelect.value;
    const newProject = SAMPLE_PROJECTS.find((p) => p.id === newId);
    if (!newProject) return;
    populateFileDropdown(fileSelect, newProject, newProject.files[0]!);
    void switchTo(newId, newProject.files[0]!);
  });
  fileSelect.addEventListener("change", () => {
    void switchTo(projectSelect.value, fileSelect.value);
  });

  // Save on tab close so unflushed edits don't go missing.
  window.addEventListener("beforeunload", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      // Synchronous fire-and-forget — IDB write may not complete but the
      // in-memory map is already updated, so a same-session reopen still
      // sees the latest content.
      void writeFile(
        current.project,
        current.filename,
        view.state.doc.toString(),
      );
    }
  });

  downloadBtn.addEventListener("click", async () => {
    await flushSave();
    const projectId = current.project;
    const proj = SAMPLE_PROJECTS.find((p) => p.id === projectId);
    if (!proj) return;
    downloadBtn.disabled = true;
    try {
      await downloadProjectAsZip(baseUrl, proj);
    } finally {
      downloadBtn.disabled = false;
    }
  });

  // Visibility toggle. We hide the entire section, not just the editor,
  // so the caption + dropdowns disappear too.
  return {
    setVisible(visible: boolean) {
      ctx.rootEl.style.display = visible ? "" : "none";
    },
  };
}

/**
 * Pick CodeMirror language extensions for a filename. C/H/CPP get the
 * cpp grammar; everything else (notably `.r` Rez) gets no highlighting
 * in Phase 1 — plain text is fine and Rez highlighting is a Phase 2 item.
 */
function extensionsForFile(filename: string) {
  if (/\.(c|h|cpp|hpp|cc|hh)$/i.test(filename)) {
    return [cpp()];
  }
  return [];
}

function populateFileDropdown(
  el: HTMLSelectElement,
  project: SampleProject,
  selected: string,
) {
  el.innerHTML = project.files
    .map((f) => `<option value="${f}">${escapeHtml(f)}</option>`)
    .join("");
  el.value = selected;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * Build the static shell. We intentionally use textContent / template
 * placeholders for everything visible; nothing here injects user-controlled
 * HTML. Strict CSP (`script-src 'self'`) is therefore safe — there is no
 * inline script and no `innerHTML` of dynamic content.
 */
function renderShell(persistent: boolean): string {
  const banner = persistent
    ? ""
    : `<p class="cvm-pg-banner" role="status">
         Storage isn't available in this browser session — edits won't survive reload.
       </p>`;
  return `
    <header class="window__titlebar">
      <span class="window__close" aria-hidden="true"></span>
      <h2 class="window__title" id="title-playground">Playground</h2>
    </header>
    <div class="window__body">
      <p class="cvm-pg-intro">
        This is the actual source for the bundled apps. Edits save locally in
        your browser. Compiling and running your edits is the next milestone —
        for now, hit <em>Download</em> to take your changes with you.
      </p>
      ${banner}
      <div class="cvm-pg-toolbar" role="group" aria-label="Playground controls">
        <label class="cvm-pg-field">
          <span class="cvm-pg-field__label">Project</span>
          <select id="cvm-pg-project" class="cvm-pg-select"></select>
        </label>
        <label class="cvm-pg-field">
          <span class="cvm-pg-field__label">File</span>
          <select id="cvm-pg-file" class="cvm-pg-select"></select>
        </label>
        <button type="button" id="cvm-pg-download" class="cvm-pg-button">
          Download project as .zip
        </button>
      </div>
      <div id="cvm-pg-editor-mount" class="cvm-pg-editor"></div>
      <p class="cvm-pg-mobile-note">
        The editor is hidden on small screens. Open this page on a desktop
        browser to read or edit the source.
      </p>
    </div>
  `;
}

/**
 * Bundle the user's current per-file copies for one project into a single
 * .zip and trigger a download. Files come from IDB (or, on first read,
 * from the bundled `/sample-projects/` copy via `readOrSeedFile`).
 */
async function downloadProjectAsZip(
  baseUrl: string,
  project: SampleProject,
): Promise<void> {
  const zip = new JSZip();
  for (const filename of project.files) {
    const content = await readOrSeedFile(baseUrl, project.id, filename);
    zip.file(`${project.id}/${filename}`, content);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${project.id}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay so the download actually starts. Browsers
  // cancel the download if the URL is revoked too eagerly.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Re-export for use elsewhere (e.g. tests).
export { isPersistent };
