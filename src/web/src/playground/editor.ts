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
import { preprocess } from "./preprocessor";
import { createVfs } from "./vfs";
import { compile } from "./rez";
import {
  spliceResourceFork,
  triggerDownload,
  fetchPrecompiled,
} from "./build";
import { patchEmptyVolumeWithBinary } from "./hfs-patcher";
import {
  lintExtensions,
  setEditorDiagnostics,
  clearEditorDiagnostics,
} from "./error-markers";

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

/** Callback the playground invokes after a successful Build & Run to swap
 *  the secondary disk and reboot the Mac. main.ts wires this to the
 *  EmulatorHandle's `reboot` method. Returning a Promise lets the
 *  playground show a spinner until the new boot is fully ready. */
export type HotLoadCallback = (opts: {
  bytes: Uint8Array;
  /** Volume name as the Mac will see it on the desktop. */
  volumeName: string;
}) => Promise<void>;

export async function mountPlayground(
  rootEl: HTMLElement,
  baseUrl: string,
  hotLoad?: HotLoadCallback,
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
  const buildBtn = rootEl.querySelector<HTMLButtonElement>("#cvm-pg-build")!;
  const buildRunBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-buildrun",
  )!;
  const statusEl = rootEl.querySelector<HTMLSpanElement>("#cvm-pg-status")!;
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
      ...lintExtensions(),
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
          // Clear stale diagnostics on any edit. Squiggles on a now-edited
          // line are misleading — better to vanish until the next Build
          // run replays them on the freshly-compiled output.
          clearEditorDiagnostics(update.view);
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

  buildBtn.addEventListener("click", async () => {
    await flushSave();
    const projectId = current.project;
    const proj = SAMPLE_PROJECTS.find((p) => p.id === projectId);
    if (!proj) return;

    buildBtn.disabled = true;
    setStatus(statusEl, "Compiling…", "info");

    try {
      const result = await runBuild(baseUrl, proj, view, current.filename);
      if (result.ok) {
        setStatus(
          statusEl,
          `Built ${proj.outputName} (${formatBytes(result.bytes!.length)}) in ${result.totalMs.toFixed(0)}ms — downloading.`,
          "ok",
        );
        triggerDownload(result.bytes!, proj.outputName);
      } else {
        const first = result.diagnostics[0];
        const msg = first
          ? `${first.severity}: ${first.message} (${first.file}:${first.line})`
          : "Build failed (no diagnostics)";
        setStatus(statusEl, msg, "err");
      }
    } catch (e) {
      setStatus(
        statusEl,
        `Build error: ${(e as Error).message}`,
        "err",
      );
    } finally {
      buildBtn.disabled = false;
    }
  });

  // Build & Run: same Phase 2 build pipeline, but instead of a download,
  // we patch the empty HFS template with the freshly-compiled MacBinary
  // and hand it to the emulator's reboot() path.
  buildRunBtn.addEventListener("click", async () => {
    if (!hotLoad) {
      setStatus(
        statusEl,
        "Build & Run isn't wired in this build (no emulator).",
        "err",
      );
      return;
    }
    await flushSave();
    const proj = SAMPLE_PROJECTS.find((p) => p.id === current.project);
    if (!proj) return;

    // Disable BOTH build buttons while a reboot is in progress; re-enable
    // in the finally. Quick double-clicks otherwise queue resets that
    // race with worker spawning.
    buildBtn.disabled = true;
    buildRunBtn.disabled = true;
    rootEl.setAttribute("data-rebooting", "");
    const tStart = performance.now();
    setStatus(statusEl, "Compiling…", "info");

    try {
      const result = await runBuild(baseUrl, proj, view, current.filename);
      if (!result.ok) {
        const first = result.diagnostics[0];
        const msg = first
          ? `${first.severity}: ${first.message} (${first.file}:${first.line})`
          : "Build failed (no diagnostics)";
        setStatus(statusEl, msg, "err");
        return;
      }
      const buildMs = performance.now() - tStart;
      setStatus(
        statusEl,
        `Built in ${buildMs.toFixed(0)}ms — patching disk…`,
        "info",
      );
      // Fetch the empty HFS template and patch it with the new binary.
      // The volume label is "Apps" (baked into the template). We name
      // the file inside it after the project's outputName minus the .bin
      // extension so the Finder sees, e.g., "Reader" / "MacWeather".
      const fname = proj.outputName.replace(/\.bin$/i, "");
      const tmplResp = await fetch(`${baseUrl}playground/empty-secondary.dsk`);
      if (!tmplResp.ok) {
        throw new Error(
          `empty-secondary.dsk fetch failed: HTTP ${tmplResp.status}`,
        );
      }
      const tmplBytes = new Uint8Array(await tmplResp.arrayBuffer());
      const patched = patchEmptyVolumeWithBinary({
        templateBytes: tmplBytes,
        macBinary: result.bytes!,
        filename: fname,
      });
      setStatus(statusEl, "Mounting disk…", "info");
      // Hand to emulator reboot — main.ts wired this up.
      await hotLoad({ bytes: patched, volumeName: "Apps" });
      const totalMs = performance.now() - tStart;
      setStatus(
        statusEl,
        `Done in ${totalMs.toFixed(0)}ms — double-click "Apps" on the desktop.`,
        "ok",
      );
      // Smooth-scroll the page back up to the emulator window so the
      // user sees the boot. The Mac window has id="emulator"; if the
      // user has scrolled down to the editor, this brings them back.
      const emWin = document.getElementById("emulator");
      if (emWin) {
        emWin.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch (e) {
      setStatus(
        statusEl,
        `Build & Run error: ${(e as Error).message}`,
        "err",
      );
    } finally {
      buildBtn.disabled = false;
      buildRunBtn.disabled = false;
      rootEl.removeAttribute("data-rebooting");
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
        your browser. Hit <em>Build .bin</em> to compile and download a
        MacBinary, or <em>Build &amp; Run</em> to reboot the Mac with your
        changes mounted as a secondary disk.
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
        <button type="button" id="cvm-pg-build" class="cvm-pg-button cvm-pg-button--primary">
          Build .bin
        </button>
        <button type="button" id="cvm-pg-buildrun" class="cvm-pg-button cvm-pg-button--primary">
          Build &amp; Run
        </button>
        <button type="button" id="cvm-pg-download" class="cvm-pg-button">
          Download .zip
        </button>
      </div>
      <p class="cvm-pg-status" id="cvm-pg-status" role="status" aria-live="polite"></p>
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

function setStatus(
  el: HTMLElement,
  text: string,
  kind: "info" | "ok" | "err",
): void {
  el.textContent = text;
  el.dataset.kind = kind;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

interface BuildOutcome {
  ok: boolean;
  bytes?: Uint8Array;
  totalMs: number;
  diagnostics: { file: string; line: number; column: number; message: string; severity: "error" | "warning" }[];
}

/**
 * The Build pipeline, end-to-end. Owned here in editor.ts because it
 * touches the live view (for diagnostics) and the active project. The
 * individual stages live in their own modules:
 *
 *    user buffer (IDB) ── preprocessor.ts ──> flat source
 *    flat source ────── rez.ts ──────────> resource fork bytes
 *    rsrc fork + .code.bin ── build.ts ───> spliced MacBinary
 *
 * Returns the spliced bytes on success, or a structured error otherwise.
 * The caller renders whichever appropriate.
 */
async function runBuild(
  baseUrl: string,
  proj: SampleProject,
  view: EditorView,
  activeFile: string,
): Promise<BuildOutcome> {
  const t0 = performance.now();

  // Read the latest .r source from IDB (the user's edits, possibly NOT
  // the buffer currently shown in the editor — we Build on the project's
  // canonical .r file which may be a different file in the dropdown).
  // readOrSeedFile falls back to the bundled copy on first read.
  const topSource = await readOrSeedFile(baseUrl, proj.id, proj.rezFile);

  // Issue #31: lock Type/Creator. The Finder's Desktop DB binds icons by
  // creator code; changing the creator on a single launch invalidates
  // every existing document's binding (the old icon resource is orphaned
  // until the DB rebuilds, which doesn't always happen automatically).
  // Cheapest guard: refuse the build if the user has touched the
  // signature resource declaration. We don't allow editing this *yet*;
  // when we do, it'll be a deliberate UX with a "rebuild Desktop"
  // affordance.
  const expectedSig = `data '${proj.appCreator}' (0`;
  if (!topSource.includes(expectedSig)) {
    return {
      ok: false,
      totalMs: performance.now() - t0,
      diagnostics: [
        {
          file: proj.rezFile,
          line: 1,
          column: 1,
          message:
            `Type/Creator is locked in this build. The signature resource ` +
            `'${proj.appCreator}' must remain unchanged — restore the ` +
            `\`data '${proj.appCreator}' (0, "Owner signature")\` declaration ` +
            `to compile.`,
          severity: "error",
        },
      ],
    };
  }

  // Build the VFS and warm it. We pre-fetch every project file plus the
  // bundled RIncludes so the synchronous preprocessor pass can resolve
  // every #include without going async mid-walk.
  const vfs = createVfs(baseUrl, proj.id);
  await vfs.prefetch(proj.id, proj.files);

  // Run the preprocessor. We seed the same handful of macros the spike's
  // MiniLexer addDefine sets at startup so existing .r files compile
  // identically.
  const pp = preprocess(topSource, proj.rezFile, vfs, {
    Rez: "1",
    DeRez: "0",
    true: "1",
    false: "0",
    TRUE: "1",
    FALSE: "0",
  });

  // Show preprocessor diagnostics on the editor (cross-file ones get
  // remapped to the include line of the active buffer per the
  // error-markers contract).
  setEditorDiagnostics(view, pp.diagnostics, activeFile);

  if (pp.diagnostics.some((d) => d.severity === "error")) {
    return {
      ok: false,
      totalMs: performance.now() - t0,
      diagnostics: pp.diagnostics,
    };
  }

  // Compile through WASM-Rez.
  const rez = await compile(baseUrl, pp.output, proj.rezFile);
  // Combine pp + rez diagnostics so the user sees everything.
  const allDiags = [...pp.diagnostics, ...rez.diagnostics];
  setEditorDiagnostics(view, allDiags, activeFile);

  if (!rez.ok || !rez.resourceFork) {
    return {
      ok: false,
      totalMs: performance.now() - t0,
      diagnostics: allDiags,
    };
  }

  // Splice onto the precompiled .code.bin.
  const dataForkBin = await fetchPrecompiled(baseUrl, proj.id);
  const bytes = spliceResourceFork({
    dataForkBin,
    resourceFork: rez.resourceFork,
  });

  return {
    ok: true,
    bytes,
    totalMs: performance.now() - t0,
    diagnostics: allDiags,
  };
}

// Re-export for use elsewhere (e.g. tests).
export { isPersistent };
export { runBuild };
