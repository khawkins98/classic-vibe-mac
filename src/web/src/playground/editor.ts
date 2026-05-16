/**
 * editor.ts — CodeMirror 6 mount + project dropdown + file tab bar + zip download.
 *
 *   - One CodeMirror instance, swapped in-place when the active tab changes.
 *   - C syntax highlighting via `@codemirror/lang-cpp`. `.r` (Rez) files
 *     get Rez syntax highlighting via the local `lang-rez` module (issue #23).
 *     Everything else gets plain text.
 *   - Edits debounce-save to IDB on every keystroke (1s) AND save
 *     immediately on file/project switch. Unsaved files show a ● dirty
 *     indicator on their tab (issue #22).
 *   - "Download project as zip" button packages the user's CURRENT edits
 *     for the selected project as a `.zip` (no boot disks, no build
 *     outputs, just `.c` / `.r` / `.h`).
 */

import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, indentWithTab, history, historyKeymap } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { rez } from "./lang-rez";
import { m68k } from "./lang-m68k";
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
  makeRetro68DefaultSizeFork,
} from "./build";
import { compileToAsm, compileToBin } from "./cc1";
import { getOptLevel, onOptLevelChange } from "../settings";
import { patchEmptyVolumeWithBinary } from "./hfs-patcher";
import {
  showBuildExplainer,
  showBuildExplainerIfFirstTime,
  type BuildExplainContext,
} from "./build-explainer";
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
 *   1. toolbar (project dropdown + build/download buttons)
 *   2. file tab bar (one tab per project file, ● dirty indicator)
 *   3. CodeMirror mount (role="tabpanel")
 *   4. status row + explanatory paragraph
 */
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
): Promise<void> {
  const { persistent, preservedCount } = await initPersistence(baseUrl);
  const ctx: PlaygroundContext = { rootEl, baseUrl, persistent };

  rootEl.innerHTML = renderShell(persistent, preservedCount);

  const projectSelect = rootEl.querySelector<HTMLSelectElement>(
    "#cvm-pg-project",
  )!;
  const tabBarEl = rootEl.querySelector<HTMLDivElement>("#cvm-pg-tabbar")!;
  const downloadBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-download",
  )!;
  const buildBtn = rootEl.querySelector<HTMLButtonElement>("#cvm-pg-build")!;
  const buildRunBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-buildrun",
  )!;
  const whatBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-whatjusthappened",
  )!;
  const statusEl = rootEl.querySelector<HTMLSpanElement>("#cvm-pg-status")!;
  const editorMount = rootEl.querySelector<HTMLDivElement>(
    "#cvm-pg-editor-mount",
  )!;

  // Last Build & Run context; populated after every successful hot-load.
  let lastBuildCtx: BuildExplainContext | null = null;

  // Restore last-open project + file, falling back to the first sample.
  const savedProject = (await readUiState<string>(UI_PROJECT)) ?? "reader";
  const project =
    SAMPLE_PROJECTS.find((p) => p.id === savedProject) ?? SAMPLE_PROJECTS[0]!;
  const savedFile = (await readUiState<string>(UI_FILE)) ?? project.files[0]!;
  const filename = project.files.includes(savedFile)
    ? savedFile
    : project.files[0]!;

  // Seed project dropdown.
  projectSelect.innerHTML = SAMPLE_PROJECTS.map(
    (p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`,
  ).join("");
  projectSelect.value = project.id;

  // ── Dirty-state tracking (issue #22) ─────────────────────────────────────
  // Maps "${projectId}/${filename}" → edit-version at last user keystroke.
  // Cleared when a save completes at the same version (meaning no new edits
  // happened during the async IDB write).
  const dirtyVersions = new Map<string, number>();

  function fileKey(projectId: string, file: string): string {
    return `${projectId}/${file}`;
  }
  function isDirty(projectId: string, file: string): boolean {
    return dirtyVersions.has(fileKey(projectId, file));
  }
  function markDirty(projectId: string, file: string): void {
    const key = fileKey(projectId, file);
    dirtyVersions.set(key, (dirtyVersions.get(key) ?? 0) + 1);
    updateTabBar();
  }

  // Central save point — wraps writeFile() with version-aware dirty clearing.
  async function saveFile(
    projectId: string,
    file: string,
    content: string,
  ): Promise<void> {
    const key = fileKey(projectId, file);
    const versionAtSave = dirtyVersions.get(key) ?? 0;
    try {
      await writeFile(projectId, file, content);
      // Clear dirty only if no new edits arrived during the async write.
      if ((dirtyVersions.get(key) ?? 0) === versionAtSave) {
        dirtyVersions.delete(key);
      }
    } catch {
      // IDB write failed; keep dirty so the user knows the save didn't land.
    }
    updateTabBar();
  }

  // Flag set while switchTo() does a programmatic view.dispatch(). The
  // docChanged listener checks this to skip marking dirty / scheduling a save.
  let loadingFile = false;
  // Monotone counter for switchTo() race prevention: if a newer call starts
  // while an older one is awaiting, the older one exits early.
  let switchSeq = 0;

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
      void saveFile(current.project, current.filename, view.state.doc.toString());
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

  // Forward-declaration: the live implementation is installed once the
  // Assembly panel mounts (see initAsmPanel below). Until then any call
  // here is a no-op — relevant because the updateListener fires on the
  // very first dispatch.
  let scheduleAsmCompile: (reason: "edit" | "switch" | "open" | "opt-level") => void =
    () => {};

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
            // Cursor: a 2px-wide black caret reads clearly on white. The
            // default CM6 caret is 1px and can disappear at a glance —
            // visitors were missing the affordance entirely.
            caretColor: "#000000",
            cursor: "text",  // I-beam over the editable area.
            padding: "8px 0",
          },
          ".cm-cursor, .cm-dropCursor": {
            borderLeftWidth: "2px",
            borderLeftColor: "#000000",
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
          // When the editor has focus, draw a subtle period-styled inset
          // border so visitors get unambiguous feedback that they're now
          // in editing mode. Default CM6 outline was suppressed; this
          // replaces it with something that fits the System 7 chrome.
          "&.cm-focused": {
            outline: "none",
            boxShadow: "inset 0 0 0 1px #000000, inset 1px 1px 0 1px #aaaaaa",
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
          if (!loadingFile) {
            markDirty(current.project, current.filename);
            scheduleSave();
            scheduleAsmCompile("edit");
          }
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

  // ── Show Assembly panel (wasm-retro-cc #17 / cv-mac #64) ────────────────
  //
  // The panel lives inside a `<details>` so it's collapsed by default —
  // opening it triggers the first cc1.wasm fetch (~3.4 MB brotli). We
  // delay constructing the read-only CodeMirror until first open too, so
  // pages that never open the panel pay zero cost.
  //
  // Recompile triggers (all → scheduleAsmCompile):
  //   • Panel open (`toggle` event with .open=true)
  //   • Main editor doc change AND current file is .c/.h (the
  //     updateListener above)
  //   • File switch into a .c/.h file (the tail of switchTo)
  //
  // Serialization: cc1 has shared MEMFS — concurrent compileToAsm() calls
  // would race on /tmp/in.c. We assign a monotonic asmSeq to each call;
  // older calls drop their result if a newer one started while they were
  // awaiting. The debounce means even fast typing only spawns one in-flight
  // compile, but the seq guard covers the seam between debounce-fire and
  // promise resolution.
  const ASM_DEBOUNCE_MS = 500;
  const asmPanel = rootEl.querySelector<HTMLDetailsElement>("#cvm-pg-asm-panel")!;
  const asmStatusEl = rootEl.querySelector<HTMLDivElement>("#cvm-pg-asm-status")!;
  const asmMountEl = rootEl.querySelector<HTMLDivElement>("#cvm-pg-asm-mount")!;
  const asmMeterEl = rootEl.querySelector<HTMLSpanElement>("#cvm-pg-asm-meter")!;
  const asmStderrWrap = rootEl.querySelector<HTMLDetailsElement>("#cvm-pg-asm-stderr-wrap")!;
  const asmStderrEl = rootEl.querySelector<HTMLPreElement>("#cvm-pg-asm-stderr")!;

  let asmView: EditorView | null = null;
  let asmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let asmSeq = 0;

  function isCSource(filename: string): boolean {
    return /\.(c|h|cpp|hpp|cc|hh)$/i.test(filename);
  }

  function initAsmView(): void {
    if (asmView) return;
    // Read-only, plain-text view. m68k asm syntax highlighting would be
    // nice-to-have but isn't critical for shipping the feature — the
    // text is already monospaced and readable. Adding a CodeMirror lang
    // package for GAS-flavoured 68k is open work (see cv-mac #64 follow-ups).
    asmView = new EditorView({
      parent: asmMountEl,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          m68k(), // brings its own HighlightStyle (see lang-m68k.ts)
          EditorView.theme(
            {
              "&": {
                backgroundColor: "#f8f8f8",
                color: "#000000",
                fontFamily:
                  '"Monaco", "Andale Mono", "Courier New", monospace',
                fontSize: "11px",
              },
              ".cm-content": { padding: "8px 0", caretColor: "transparent" },
              ".cm-gutters": {
                backgroundColor: "#dddddd",
                color: "#666666",
                border: "none",
                borderRight: "1px solid #000000",
              },
              ".cm-scroller": { lineHeight: "1.4" },
              "&.cm-focused": { outline: "none" },
            },
            { dark: false },
          ),
        ],
      }),
    });
  }

  function setAsmStatus(text: string, kind: "info" | "ok" | "err"): void {
    asmStatusEl.textContent = text;
    asmStatusEl.dataset.kind = kind;
  }

  async function runAsmCompile(): Promise<void> {
    if (!asmPanel.open) return;
    if (!isCSource(current.filename)) {
      setAsmStatus(
        `${current.filename} isn't a C source — switch to a .c tab to compile.`,
        "info",
      );
      asmStderrWrap.hidden = true;
      return;
    }
    initAsmView();
    const seq = ++asmSeq;
    setAsmStatus("Compiling…", "info");
    asmMeterEl.textContent = "compiling…";

    const source = view.state.doc.toString();
    const fname = current.filename;

    // Gather project sibling files so quoted `#include "x.h"` in the
    // active buffer resolves. We read from IDB (or seed) — only the
    // active file uses the live editor buffer.
    const proj = SAMPLE_PROJECTS.find((p) => p.id === current.project);
    const siblings: Array<{ name: string; content: string }> = [];
    if (proj) {
      for (const f of proj.files) {
        if (f === fname) continue;
        if (!isCSource(f)) continue;
        try {
          siblings.push({
            name: f,
            content: await readOrSeedFile(baseUrl, proj.id, f),
          });
        } catch {
          // Skip unreadable siblings — cc1 will surface a clear "No such
          // file" if the omission breaks the compile.
        }
      }
    }
    if (seq !== asmSeq) return; // tab switch / edit raced the await

    let result;
    try {
      result = await compileToAsm(baseUrl, source, fname, {
        siblings,
        optLevel: getOptLevel(),
      });
    } catch (e) {
      if (seq !== asmSeq) return;
      setAsmStatus(`cc1 load failed: ${(e as Error).message}`, "err");
      asmMeterEl.textContent = "error";
      return;
    }
    if (seq !== asmSeq) return; // a newer call superseded us

    if (!result.ok) {
      const first = result.diagnostics[0];
      setAsmStatus(
        first
          ? `${first.severity}: ${first.message} (${first.file}:${first.line}:${first.column})`
          : "cc1 failed",
        "err",
      );
      asmMeterEl.textContent = "error";
      if (result.rawStderr.trim()) {
        asmStderrEl.textContent = result.rawStderr;
        asmStderrWrap.hidden = false;
      } else {
        asmStderrWrap.hidden = true;
      }
      return;
    }

    // Success — replace the asm viewer content.
    const asmText = result.asm ?? "";
    asmView!.dispatch({
      changes: { from: 0, to: asmView!.state.doc.length, insert: asmText },
      scrollIntoView: false,
    });
    const lineCount = asmText.split("\n").length;
    setAsmStatus(
      `${fname} → ${lineCount} lines of m68k assembly in ${result.durationMs.toFixed(0)}ms`,
      "ok",
    );
    asmMeterEl.textContent = `${result.durationMs.toFixed(0)}ms · ${lineCount}L`;
    // Warnings are still surfaced — only show stderr block if non-empty.
    if (result.rawStderr.trim()) {
      asmStderrEl.textContent = result.rawStderr;
      asmStderrWrap.hidden = false;
    } else {
      asmStderrWrap.hidden = true;
    }
  }

  // Install the real scheduleAsmCompile (replaces the no-op forward-decl).
  scheduleAsmCompile = (_reason) => {
    if (!asmPanel.open) return;
    if (asmDebounceTimer) clearTimeout(asmDebounceTimer);
    asmDebounceTimer = setTimeout(() => {
      asmDebounceTimer = null;
      void runAsmCompile();
    }, ASM_DEBOUNCE_MS);
  };

  // Panel toggle: on first open, kick off an immediate (no-debounce)
  // compile so the viewer doesn't sit empty for 500ms. Subsequent re-opens
  // already have content; re-running on every open would be wasted work
  // unless the file or source changed since last time, which the seq
  // guards already handle.
  asmPanel.addEventListener("toggle", () => {
    if (!asmPanel.open) return;
    if (!isCSource(current.filename)) {
      setAsmStatus(
        `${current.filename} isn't a C source — switch to a .c tab to compile.`,
        "info",
      );
      return;
    }
    initAsmView();
    void runAsmCompile();
  });

  /** Flush a pending debounced save synchronously. */
  async function flushSave(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    await saveFile(current.project, current.filename, view.state.doc.toString());
  }

  // Switch the editor's contents to a new file. Saves the previous file
  // first so transient edits don't get dropped. Uses a sequence token to
  // discard results from an older switch that finished after a newer one.
  async function switchTo(projectId: string, file: string): Promise<void> {
    const seq = ++switchSeq;
    await flushSave();
    if (seq !== switchSeq) return;
    const nextProject = SAMPLE_PROJECTS.find((p) => p.id === projectId);
    if (!nextProject) return;
    const nextFile = nextProject.files.includes(file)
      ? file
      : nextProject.files[0]!;
    const content = await readOrSeedFile(baseUrl, projectId, nextFile);
    if (seq !== switchSeq) return;
    current.project = projectId;
    current.filename = nextFile;
    loadingFile = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
        effects: langCompartment.reconfigure(extensionsForFile(nextFile)),
        selection: { anchor: 0, head: 0 },
        scrollIntoView: true,
      });
    } finally {
      loadingFile = false;
    }
    renderTabBar(nextProject, nextFile);
    await writeUiState(UI_PROJECT, projectId);
    await writeUiState(UI_FILE, nextFile);
    // Refresh the Assembly panel (if open). On a switch we still debounce —
    // the user might be tab-cycling and we don't want to fire mid-cycle.
    scheduleAsmCompile("switch");
  }

  projectSelect.addEventListener("change", () => {
    const newId = projectSelect.value;
    const newProject = SAMPLE_PROJECTS.find((p) => p.id === newId);
    if (!newProject) return;
    void switchTo(newId, newProject.files[0]!);
  });

  // Optimization level lives in Preferences (Edit menu) now. Subscribe
  // here so any change — from the prefs palette or cross-tab storage —
  // refreshes the Show Assembly panel with the new codegen.
  onOptLevelChange(() => {
    console.info(`[cvm] optimization level: -${getOptLevel()}`);
    scheduleAsmCompile("opt-level");
  });

  // ── Tab bar event delegation ──────────────────────────────────────────────
  tabBarEl.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest(
      "[role='tab']",
    ) as HTMLButtonElement | null;
    if (!btn || btn.getAttribute("aria-selected") === "true") return;
    void switchTo(current.project, btn.dataset.file!);
  });

  // Arrow-key navigation with automatic activation (ARIA APG tab pattern).
  tabBarEl.addEventListener("keydown", (e) => {
    const tabs = Array.from(
      tabBarEl.querySelectorAll<HTMLButtonElement>("[role='tab']"),
    );
    const idx = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (idx === -1) return;
    let next = idx;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (idx + 1) % tabs.length;
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (idx - 1 + tabs.length) % tabs.length;
      e.preventDefault();
    } else if (e.key === "Home") {
      next = 0;
      e.preventDefault();
    } else if (e.key === "End") {
      next = tabs.length - 1;
      e.preventDefault();
    } else {
      return;
    }
    tabs[next]!.focus();
    void switchTo(current.project, tabs[next]!.dataset.file!);
  });

  // Initial tab bar render.
  renderTabBar(project, filename);

  // ── Tab bar rendering ─────────────────────────────────────────────────────
  // Builds the tab bar from scratch using DOM methods (no innerHTML injection)
  // to avoid escaping issues with filenames.
  function renderTabBar(proj: SampleProject, activeFile: string): void {
    tabBarEl.innerHTML = "";
    const activeIdx = proj.files.indexOf(activeFile);
    proj.files.forEach((file, idx) => {
      const isActive = file === activeFile;
      const dirty = isDirty(proj.id, file);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(isActive));
      btn.setAttribute("aria-controls", "cvm-pg-editor-mount");
      btn.id = `cvm-pg-tab-${idx}`;
      btn.className = "cvm-pg-tab" + (isActive ? " cvm-pg-tab--active" : "");
      btn.tabIndex = isActive ? 0 : -1;
      btn.dataset.file = file;
      if (dirty) {
        btn.setAttribute("aria-label", `${file}, unsaved changes`);
        const indicator = document.createElement("span");
        indicator.className = "cvm-pg-tab__dirty";
        indicator.setAttribute("aria-hidden", "true");
        indicator.textContent = "\u25cf\u00a0"; // ● + non-breaking space
        btn.appendChild(indicator);
      } else {
        btn.setAttribute("aria-label", file);
      }
      const label = document.createElement("span");
      label.textContent = file;
      btn.appendChild(label);
      tabBarEl.appendChild(btn);
    });
    // Point the tabpanel at the active tab for screen readers.
    const editorMount = rootEl.querySelector("#cvm-pg-editor-mount");
    if (editorMount && activeIdx >= 0) {
      editorMount.setAttribute("aria-labelledby", `cvm-pg-tab-${activeIdx}`);
    }
  }

  function updateTabBar(): void {
    const proj = SAMPLE_PROJECTS.find((p) => p.id === current.project);
    if (!proj) return;
    renderTabBar(proj, current.filename);
  }

  // Save on tab close so unflushed edits don't go missing.
  window.addEventListener("beforeunload", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void saveFile(
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
        const stampedName = withBuildTimestamp(proj.outputName);
        setStatus(
          statusEl,
          `Built ${stampedName} (${formatBytes(result.bytes!.length)}) in ${result.totalMs.toFixed(0)}ms — downloading.`,
          "ok",
        );
        triggerDownload(result.bytes!, stampedName);
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
      // Surface the binary size alongside the wall time. The Build-only
      // path already does this via formatBytes(); Build & Run was
      // silent on size. Useful for "is my last edit smaller / bigger
      // than before?" diagnostic glances.
      setStatus(
        statusEl,
        `Done in ${totalMs.toFixed(0)}ms (${formatBytes(result.bytes!.length)}) — double-click "Apps" on the desktop.`,
        "ok",
      );

      // Populate the build context for the explainer modal.
      lastBuildCtx = {
        appName: fname,
        rezFile: current.filename,
        totalMs,
        volumeName: "Apps",
      };
      // Unhide the "What just happened?" button — only after a real hot-load.
      whatBtn.hidden = false;

      // Only auto-scroll if the first-time explainer won't show.
      // Both competing for focus at the same time creates a confusing UX.
      const willShowModal = !(() => {
        try { return !!localStorage.getItem("cvm.buildExplainerSeen"); } catch { return false; }
      })();
      if (willShowModal) {
        showBuildExplainerIfFirstTime(lastBuildCtx, buildRunBtn);
      } else {
        // Smooth-scroll the page back up to the emulator window so the
        // user sees the boot. The Mac window has id="emulator"; if the
        // user has scrolled down to the editor, this brings them back.
        const emWin = document.getElementById("emulator");
        if (emWin) {
          emWin.scrollIntoView({ behavior: "smooth", block: "center" });
        }
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

  // "What just happened?" — re-opens the explainer any time after a hot-load.
  whatBtn.addEventListener("click", () => {
    if (lastBuildCtx) showBuildExplainer(lastBuildCtx, whatBtn);
  });
}

/**
 * Pick CodeMirror language extensions for a filename. C/H/CPP get the
 * cpp grammar; `.r` Rez resource files get the Rez grammar (issue #23);
 * everything else gets plain text (no highlighting).
 */
function extensionsForFile(filename: string) {
  if (/\.(c|h|cpp|hpp|cc|hh)$/i.test(filename)) {
    return [cpp()];
  }
  if (/\.r$/i.test(filename)) {
    return [rez()];
  }
  return [];
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
function renderShell(persistent: boolean, preservedCount: number): string {
  const banner = persistent
    ? ""
    : `<p class="cvm-pg-banner" role="status">
         Storage isn't available in this browser session — edits won't survive reload.
       </p>`;
  const migrationBanner = preservedCount > 0
    ? `<p class="cvm-pg-banner cvm-pg-banner--info" role="status">
         <strong>Heads-up:</strong> the sample projects were updated.
         Your edits in ${preservedCount} file${preservedCount === 1 ? "" : "s"} were preserved —
         only unmodified files were refreshed to the latest version.
       </p>`
    : "";
  return `
    <div class="window__body">
      <p class="cvm-pg-intro">
        Click into the source below and start typing &mdash; this is the
        real C and Rez code for the app running in the Mac above. Edits
        save automatically in your browser. Hit <em>Build .bin</em> to
        compile and download a MacBinary, or <em>Build &amp; Run</em>
        to reboot the Mac with your changes. Everything compiles in your
        browser: <code>.c</code> through <code>cc1</code> + <code>as</code>
        + <code>ld</code>, and any <code>.r</code> through WASM-Rez.
      </p>
      ${banner}
      ${migrationBanner}
      <!--
        The project <select> is the canonical project-switching control;
        it lives here because all of editor.ts's internal logic (switchTo,
        readUiState/writeUiState) queries it by id. It is *visually hidden*
        in the IDE layout — main.ts mounts a peer dropdown in the files
        panel that proxies changes here. Tests still find it by id.
      -->
      <label class="cvm-pg-field cvm-pg-field--hidden-in-ide">
        <span class="cvm-pg-field__label">Project</span>
        <select id="cvm-pg-project" class="cvm-pg-select"></select>
      </label>
      <!--
        Iconified build toolbar. Each button has a glyph + label so
        users have visual + textual affordances. The glyphs are
        Unicode (no SVG assets); the underlying IDs are unchanged so
        all the existing JS hooks + Playwright tests continue to find
        them.
      -->
      <div class="cvm-pg-toolbar cvm-pg-toolbar--icons" role="group" aria-label="Build controls">
        <button type="button" id="cvm-pg-build"
                class="cvm-pg-iconbtn cvm-pg-iconbtn--primary"
                title="Compile the current project to a .bin and download it">
          <span class="cvm-pg-iconbtn__icon" aria-hidden="true">🔨</span>
          <span class="cvm-pg-iconbtn__label">Build</span>
        </button>
        <button type="button" id="cvm-pg-buildrun"
                class="cvm-pg-iconbtn cvm-pg-iconbtn--primary"
                title="Compile + hot-load into the running Mac in ~1s">
          <span class="cvm-pg-iconbtn__icon" aria-hidden="true">▶</span>
          <span class="cvm-pg-iconbtn__label">Build &amp; Run</span>
        </button>
        <button type="button" id="cvm-pg-download"
                class="cvm-pg-iconbtn"
                title="Download the current project's source files as a .zip">
          <span class="cvm-pg-iconbtn__icon" aria-hidden="true">💾</span>
          <span class="cvm-pg-iconbtn__label">Download</span>
        </button>
      </div>
      <div class="cvm-pg-status-row">
        <p class="cvm-pg-status" id="cvm-pg-status" role="status" aria-live="polite"></p>
        <button type="button" id="cvm-pg-whatjusthappened" class="cvm-pg-btn-what" hidden>
          What just happened?
        </button>
      </div>
      <div id="cvm-pg-tabbar" class="cvm-pg-tabbar" role="tablist" aria-label="Source files"></div>
      <div id="cvm-pg-editor-mount" class="cvm-pg-editor" role="tabpanel"></div>
      <details id="cvm-pg-asm-panel" class="cvm-pg-asm-panel">
        <summary class="cvm-pg-asm-summary">
          <span class="cvm-pg-asm-summary__title">Show Assembly</span>
          <span class="cvm-pg-asm-summary__hint">— compile this <code>.c</code> to m68k assembly in your browser</span>
          <span id="cvm-pg-asm-meter" class="cvm-pg-asm-meter" aria-live="polite"></span>
        </summary>
        <p class="cvm-pg-asm-intro">
          The <code>.c</code> file open above is compiled through
          <code>cc1.wasm</code> &mdash; the real GCC 12 backend for
          Motorola 68k, ported to WebAssembly. Output below is exactly
          what the cross-compiler would emit running natively. Switch
          to a <code>.c</code> tab to see the assembly update as you
          type (~500&nbsp;ms debounce).
        </p>
        <div id="cvm-pg-asm-status" class="cvm-pg-asm-status" role="status" aria-live="polite"></div>
        <div id="cvm-pg-asm-mount" class="cvm-pg-asm-mount" aria-label="m68k assembly output"></div>
        <details id="cvm-pg-asm-stderr-wrap" class="cvm-pg-asm-stderr-wrap" hidden>
          <summary>cc1 diagnostics</summary>
          <pre id="cvm-pg-asm-stderr" class="cvm-pg-asm-stderr"></pre>
        </details>
      </details>
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

// Insert a YYYYMMDD-HHMM stamp before the extension so successive
// downloads of the same project don't collide in the user's Downloads
// folder. Local time (not UTC) so the stamp matches the user's wall
// clock — they're using it as an "is this the one I just built?" check.
function withBuildTimestamp(name: string): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? `${name}-${stamp}` : `${name.slice(0, dot)}-${stamp}${name.slice(dot)}`;
}

interface BuildOutcome {
  ok: boolean;
  bytes?: Uint8Array;
  totalMs: number;
  diagnostics: { file: string; line: number; column: number; message: string; severity: "error" | "warning" }[];
}

/**
 * The Build pipeline, end-to-end. Owned here in editor.ts because it
 * touches the live view (for diagnostics) and the active project.
 *
 * Two flavours depending on the project shape:
 *
 *   • Splice path (`rezFile` non-null) — the existing `.r`-driven flow
 *     used by reader / macweather / hello-mac. CI builds a `.code.bin`
 *     with the m68k CODE/DATA/RELA from the project's `.c` source;
 *     the playground recompiles the `.r` resource fork in-browser via
 *     wasm-rez and splices it on top.
 *
 *       user buffer (IDB) ── preprocessor.ts ──> flat source
 *       flat source ────── rez.ts ──────────> resource fork bytes
 *       rsrc fork + .code.bin ── build.ts ───> spliced MacBinary
 *
 *   • In-browser C path (`rezFile === null`) — the wasm-hello flow
 *     (cv-mac #64 / wasm-retro-cc #15). The whole pipeline runs
 *     client-side: cc1 → as → ld → Elf2Mac produces a complete
 *     MacBinary II APPL directly from the user's `.c` source. No
 *     CI artefact involved.
 *
 *       user buffer ── compileToBin (cc1 → as → ld → Elf2Mac) ──> MacBinary
 *
 * Returns the resulting bytes on success, or a structured error
 * otherwise. The caller renders whichever applies.
 */
async function runBuild(
  baseUrl: string,
  proj: SampleProject,
  view: EditorView,
  activeFile: string,
): Promise<BuildOutcome> {
  // Two build paths:
  //   rezFile == null → A: in-browser C only (cc1 → as → ld → Elf2Mac)
  //   rezFile != null → B: in-browser C + in-browser Rez, splice forks
  //
  // Path C (CI-precompiled .code.bin + in-browser Rez splice) was the
  // original Phase 2 design; retired in #117 when the splice-path
  // projects (reader / macweather / hello-mac) were removed from the
  // picker. Removed for real in a follow-up to #125.
  if (proj.rezFile === null) {
    return runBuildInBrowserC(baseUrl, proj, view, activeFile);
  }
  return runBuildMixedCAndR(baseUrl, proj, view, activeFile);
}

/**
 * Build path B (cv-mac #100 Phase B): in-browser C *and* in-browser
 * Rez. Used by projects with `rezFile !== null` and `precompiledName ===
 * null` — the user authors both the .c sources AND the .r resources,
 * and everything compiles client-side. Composes two existing pipelines:
 *
 *   1. {@link runBuildInBrowserC} compiles all .c files and splices a
 *      default SIZE resource — this gives us a complete MacBinary with
 *      libretrocrt's runtime resources (RELA, SIZE, CODE 0..N) intact.
 *   2. The Rez stage (same as the C-path) compiles the user's .r
 *      against the bundled RIncludes, producing a resource fork.
 *   3. spliceResourceFork merges the rez fork OVER the C-built fork —
 *      user-authored resources (WIND, MENU, DLOG, STR#, BNDL, ...) win
 *      on (type, id) collision; libretrocrt's RELA/SIZE/CODE survive
 *      unless the user explicitly redeclares them.
 *
 * The user's .r MAY include its own `data 'SIZE' (-1, ...)` to override
 * the default heap allocation; Rez user-wins semantics let it through.
 */
async function runBuildMixedCAndR(
  baseUrl: string,
  proj: SampleProject,
  view: EditorView,
  activeFile: string,
): Promise<BuildOutcome> {
  const t0 = performance.now();

  // Step 1: compile the C side via Phase A's pipeline. This returns a
  // complete MacBinary with default-SIZE-spliced resource fork — what
  // we want as the base for further splicing.
  const cResult = await runBuildInBrowserC(baseUrl, proj, view, activeFile);
  if (!cResult.ok || !cResult.bytes) return cResult;

  // Step 2: compile the user's .r. Same flow as the precompiled-data-
  // fork splice path (createVfs → preprocess → compile → resourceFork).
  if (!proj.rezFile) {
    return cResult; // unreachable: caller guards rezFile !== null
  }
  const topSource = await readOrSeedFile(baseUrl, proj.id, proj.rezFile);
  const vfs = createVfs(baseUrl, proj.id);
  await vfs.prefetch(proj.id, proj.files);
  const pp = preprocess(topSource, proj.rezFile, vfs, {
    Rez: "1", DeRez: "0", true: "1", false: "0", TRUE: "1", FALSE: "0",
  });
  setEditorDiagnostics(view, pp.diagnostics, activeFile);
  if (pp.diagnostics.some((d) => d.severity === "error")) {
    return {
      ok: false,
      totalMs: performance.now() - t0,
      diagnostics: pp.diagnostics,
    };
  }
  const rez = await compile(baseUrl, pp.output, proj.rezFile);
  const allDiags = [...pp.diagnostics, ...rez.diagnostics];
  setEditorDiagnostics(view, allDiags, activeFile);
  if (!rez.ok || !rez.resourceFork) {
    return { ok: false, totalMs: performance.now() - t0, diagnostics: allDiags };
  }

  // Step 3: splice the user's rez fork onto the C-built MacBinary.
  // spliceResourceFork merges (user-wins on collision), so RELA / SIZE /
  // CODE from libretrocrt survive unless the user explicitly overrode
  // them in their .r.
  const finalBin = spliceResourceFork({
    dataForkBin: cResult.bytes,
    resourceFork: rez.resourceFork,
  });

  // Identity stamp for the mixed build, mirroring runBuildInBrowserC.
  const copy = new Uint8Array(finalBin.byteLength);
  copy.set(finalBin);
  const sha = await crypto.subtle.digest("SHA-256", copy);
  const shaHex = Array.from(new Uint8Array(sha))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  console.info(
    `[build-c+r] ${proj.id}: ${finalBin.byteLength}B  sha256=${shaHex.slice(0, 16)}…  ` +
      `(c=${cResult.totalMs.toFixed(0)}ms, total=${(performance.now() - t0).toFixed(0)}ms)`,
  );

  return {
    ok: true,
    bytes: finalBin,
    totalMs: performance.now() - t0,
    diagnostics: allDiags,
  };
}

/**
 * Build via the in-browser C toolchain (cv-mac #64). Used by projects
 * with `rezFile === null`. The active editor buffer wins for the
 * primary `.c` (so users see their edits compile live); other project
 * files are read from IDB to support sibling `#include`s.
 *
 * Diagnostic remap: cc1 reports errors as `<sourceName>:line:col: error: msg`,
 * which we already parse in cc1.ts. The editor's lint markers consume
 * the same `Diagnostic` shape the splice path uses.
 */
async function runBuildInBrowserC(
  baseUrl: string,
  proj: SampleProject,
  view: EditorView,
  activeFile: string,
): Promise<BuildOutcome> {
  const t0 = performance.now();

  // Primary C source — first `.c` in the project's file list. Used as
  // the diagnostics-labelling default; cc1 errors on a different file
  // get tagged with that file's name (per-source parsing in cc1.ts).
  const cFile = proj.files.find((f) => /\.c$/i.test(f));
  if (!cFile) {
    return {
      ok: false,
      totalMs: performance.now() - t0,
      diagnostics: [
        {
          file: proj.files[0] ?? "(none)",
          line: 1,
          column: 1,
          severity: "error",
          message:
            `Project ${proj.id} has no .c file — can't run the in-browser ` +
            `C toolchain. Add a .c to the project, or set rezFile to use ` +
            `the splice path instead.`,
        },
      ],
    };
  }

  // Gather every .c and .h in the project. .c files all get compiled
  // (cv-mac #100 Phase A — multi-file support); .h files are co-mounted
  // into MEMFS for #include resolution. Active editor buffer wins over
  // IDB for whichever file is currently open.
  const sources: Array<{ filename: string; content: string }> = [];
  for (const f of proj.files) {
    if (!/\.(c|h)$/i.test(f)) continue;
    try {
      sources.push({
        filename: f,
        content:
          activeFile === f
            ? view.state.doc.toString()
            : await readOrSeedFile(baseUrl, proj.id, f),
      });
    } catch {
      // Unreadable source — cc1 will surface the resulting "No such file"
      // if the omission breaks the compile.
    }
  }

  const r = await compileToBin(baseUrl, {
    sources,
    primaryName: cFile,
    optLevel: getOptLevel(),
  });
  setEditorDiagnostics(view, r.diagnostics, activeFile);

  if (!r.ok || !r.bin) {
    return {
      ok: false,
      totalMs: r.totalMs,
      diagnostics: r.diagnostics.length
        ? r.diagnostics
        : [
            {
              file: cFile,
              line: 1,
              column: 1,
              severity: "error",
              message: `In-browser build failed at stage ${r.failedStage ?? "?"}`,
            },
          ],
    };
  }

  // Splice a default `SIZE` resource (-1) onto the wasm-built binary's
  // resource fork. Without it, the Process Manager gives the app a tiny
  // default heap and libretrocrt's `Retro68Relocate` faults during
  // startup with a type-3 illegal-instruction dialog — verified on
  // deployed Pages with `int main(){ return 0; }`. The 10-byte default
  // (1 MB preferred + minimum, flags 0x0080) matches the Retro68
  // reference binary `hello-toolbox-retro68.bin`. See cv-mac LEARNINGS
  // "2026-05-15 — Missing SIZE resource crashes libretrocrt startup
  // with type-3".
  const finalBin = spliceResourceFork({
    dataForkBin: r.bin,
    resourceFork: makeRetro68DefaultSizeFork(),
  });

  // Identity stamp for every in-browser build. Mirrors the
  // `[prebuilt-demo] ...` line from the static-bin path. Lets us
  // confirm at a glance "did this Build click actually produce a
  // different binary?" without downloading and shasumming locally —
  // particularly useful when debugging service-worker cache hits or
  // wasm-toolchain regressions.
  // Copy into a fresh ArrayBuffer-backed Uint8Array for SubtleCrypto.
  // The cc1 bridge's bin may be backed by an Emscripten-allocated
  // SharedArrayBuffer / WASM heap; SubtleCrypto.digest is typed to
  // accept only ArrayBuffer-backed BufferSource. Hash the
  // SIZE-spliced final bin (what we hand the emulator), not the raw
  // pipeline output — same as the prebuilt-demo path does.
  const copy = new Uint8Array(finalBin.byteLength);
  copy.set(finalBin);
  const buf = await crypto.subtle.digest("SHA-256", copy);
  const shaHex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  console.info(
    `[build-c] ${proj.id}/${cFile}: ${finalBin.byteLength}B  ` +
      `sha256=${shaHex.slice(0, 16)}…  ` +
      `cc1=${r.stages?.cc1Ms.toFixed(0)}ms ` +
      `as=${r.stages?.asMs.toFixed(0)}ms ` +
      `ld=${r.stages?.ldMs.toFixed(0)}ms ` +
      `elf2mac=${r.stages?.elf2macMs.toFixed(0)}ms`,
  );

  return {
    ok: true,
    bytes: finalBin,
    totalMs: performance.now() - t0,
    diagnostics: r.diagnostics,
  };
}

// Re-export for use elsewhere (e.g. tests).
export { isPersistent };
export { runBuild };
