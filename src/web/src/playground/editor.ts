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
import JSZip from "jszip";

import { SAMPLE_PROJECTS, PREBUILT_DEMOS, type SampleProject } from "./types";
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
import { compileToAsm } from "./cc1";
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
  let scheduleAsmCompile: (reason: "edit" | "switch" | "open") => void =
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
      result = await compileToAsm(baseUrl, source, fname, { siblings });
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
    updateNonCompiledBanner(nextFile);
    renderTabBar(nextProject, nextFile);
    await writeUiState(UI_PROJECT, projectId);
    await writeUiState(UI_FILE, nextFile);
    // Refresh the Assembly panel (if open). On a switch we still debounce —
    // the user might be tab-cycling and we don't want to fire mid-cycle.
    scheduleAsmCompile("switch");
  }

  // Show / hide the "this file isn't compiled in your browser" banner
  // based on the active file. See isCompiledInBrowser() for the rule and
  // issue #57 for the in-browser-C-compile feasibility study.
  const nonCompiledBanner = rootEl.querySelector<HTMLDivElement>(
    "#cvm-pg-noncompiled-banner",
  );
  function updateNonCompiledBanner(filename: string): void {
    if (!nonCompiledBanner) return;
    nonCompiledBanner.hidden = isCompiledInBrowser(filename);
  }
  // Initial state matches the file the editor opens with.
  updateNonCompiledBanner(filename);

  projectSelect.addEventListener("change", () => {
    const newId = projectSelect.value;
    const newProject = SAMPLE_PROJECTS.find((p) => p.id === newId);
    if (!newProject) return;
    void switchTo(newId, newProject.files[0]!);
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

  // Prebuilt demo load: event delegation for .cvm-pg-demo-load buttons.
  // Each button carries data-demo-id matching a PREBUILT_DEMOS entry.
  // The path: fetch binary → patch empty HFS volume → hotLoad (reboot emulator).
  // No wasm-rez splice needed — the binary is a complete MacBinary II APPL.
  rootEl.addEventListener("click", async (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLButtonElement>("button.cvm-pg-demo-load");
    if (!btn) return;

    const demo = PREBUILT_DEMOS.find((d) => d.id === btn.dataset.demoId);
    if (!demo) return;

    if (!hotLoad) {
      setStatus(statusEl, "Load demo isn't wired in this build (no emulator).", "err");
      return;
    }

    // Lock all interactive buttons during the reboot sequence.
    const demoButtons = rootEl.querySelectorAll<HTMLButtonElement>(".cvm-pg-demo-load");
    buildBtn.disabled = true;
    buildRunBtn.disabled = true;
    demoButtons.forEach((b) => (b.disabled = true));
    rootEl.setAttribute("data-rebooting", "");
    setStatus(statusEl, `Fetching ${demo.label}…`, "info");

    try {
      const binResp = await fetch(`${baseUrl}${demo.binPath}`);
      if (!binResp.ok) throw new Error(`Fetch failed: HTTP ${binResp.status}`);
      const macBinary = new Uint8Array(await binResp.arrayBuffer());

      // Log fetched binary identity to make cached-vs-fresh debugging trivial
      // (added 2026-05-14 after the wasm-retro-cc PR-#5 re-vendor; the
      // previous binary type-3'd, so we want zero ambiguity about which one
      // the browser actually got).  SHA-256 of the bytes is the canonical
      // ID; Last-Modified is the deploy timestamp (fast cache-hit check).
      const sha = await crypto.subtle.digest("SHA-256", macBinary);
      const shaHex = Array.from(new Uint8Array(sha))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      console.info(
        `[prebuilt-demo] ${demo.id}: ${macBinary.byteLength}B  ` +
          `sha256=${shaHex.slice(0, 16)}…  ` +
          `last-modified=${binResp.headers.get("last-modified") ?? "(none)"}`,
      );

      setStatus(statusEl, "Patching disk…", "info");
      const tmplResp = await fetch(`${baseUrl}playground/empty-secondary.dsk`);
      if (!tmplResp.ok) throw new Error(`empty-secondary.dsk: HTTP ${tmplResp.status}`);
      const templateBytes = new Uint8Array(await tmplResp.arrayBuffer());

      // Drop a small diagnostic README on the mounted disk alongside the
      // demo app.  When (not if) somebody hits a crash here, this is the
      // first thing they can open in TeachText to identify what's actually
      // mounted — no DevTools required.  Classic Mac convention is CR line
      // endings (\r = 0x0D) inside TEXT files; SimpleText/TeachText displays
      // those correctly.  Filename "info.txt" sorts AFTER any demo whose
      // name starts with a letter <= 'h'; if a future demo starts with 'j'
      // or later we'd need a different name.
      const lastMod = binResp.headers.get("last-modified") ?? "(none)";
      const readmeText =
        `${demo.label}\r` +
        `${"=".repeat(demo.label.length)}\r\r` +
        `Mounted from classic-vibe-mac → "Hello Toolbox (wasm-retro-cc)".\r\r` +
        `Binary identity\r` +
        `---------------\r` +
        `File:         ${demo.filename}\r` +
        `Size:         ${macBinary.byteLength} bytes\r` +
        `SHA-256:      ${shaHex}\r` +
        `Last-Modified: ${lastMod}\r\r` +
        `If the app crashed with "type 3" (illegal instruction):\r` +
        ` 1. Open browser DevTools (Cmd+Option+I) → Console.\r` +
        ` 2. Look for the [prebuilt-demo] line — it shows the SHA above.\r` +
        ` 3. Compare against the expected SHA in:\r` +
        `    src/web/public/precompiled/VENDORED.md\r\r` +
        `Cross-repo source of truth\r` +
        `--------------------------\r` +
        ` Tracker:  github.com/khawkins98/classic-vibe-mac/issues/64\r` +
        ` Compiler: github.com/khawkins98/wasm-retro-cc\r` +
        ` LEARNINGS: see LEARNINGS.md "Boot test (2026-05-14)" in wasm-retro-cc.\r\r` +
        `Expected behaviour\r` +
        `------------------\r` +
        ` Double-click "${demo.filename}" → app draws "Hello, World!" at (100, 100)\r` +
        ` on the desktop, waits for a mouse click, then exits.\r`;
      const readmeBytes = new TextEncoder().encode(readmeText);

      const patched = patchEmptyVolumeWithBinary({
        templateBytes,
        macBinary,
        filename: demo.filename,
        extraFiles: [
          {
            filename: "info.txt",
            type: 0x54455854, // 'TEXT'
            creator: 0x74747874, // 'ttxt' (SimpleText / TeachText)
            dataFork: readmeBytes,
          },
        ],
      });
      setStatus(statusEl, "Mounting disk…", "info");
      await hotLoad({ bytes: patched, volumeName: "Apps" });
      setStatus(
        statusEl,
        `${demo.label} loaded — double-click "Apps" on the desktop. ` +
          `If it crashes, open "info.txt" on that disk for diagnostics.`,
        "ok",
      );
    } catch (err) {
      setStatus(statusEl, `Load demo error: ${(err as Error).message}`, "err");
    } finally {
      buildBtn.disabled = false;
      buildRunBtn.disabled = false;
      demoButtons.forEach((b) => (b.disabled = false));
      rootEl.removeAttribute("data-rebooting");
    }
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

/**
 * Whether edits to this file are actually compiled by the in-browser
 * pipeline. Today only Rez resource files (`.r`) recompile here — WASM-Rez
 * produces a fresh resource fork, the Build pipeline splices it onto the
 * precompiled `.code.bin` (data fork) emitted by CI. Everything else (`.c`,
 * `.h`, `CMakeLists.txt`) is read-only as far as the running binary is
 * concerned: edits save to IndexedDB and ride along in Download .zip, but
 * the data fork in the built `.bin` is whatever CI compiled from main.
 *
 * The full in-browser C compile path is tracked in issue #57 (TinyCC
 * spike + alternatives) — until that lands, this helper drives the
 * "this file isn't compiled in your browser" warning banner.
 */
function isCompiledInBrowser(filename: string): boolean {
  return /\.r$/i.test(filename);
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
    <header class="window__titlebar">
      <span class="window__close" aria-hidden="true"></span>
      <h2 class="window__title" id="title-playground">Playground</h2>
    </header>
    <div class="window__body">
      <p class="cvm-pg-intro">
        Click into the source below and start typing &mdash; this is the
        real C and Rez code for the apps running in the Mac above. Edits
        save automatically in your browser. Hit <em>Build .bin</em> to
        compile and download a MacBinary, or <em>Build &amp; Run</em>
        to reboot the Mac with your changes. Only <code>.r</code> resource
        files recompile in-browser today; <code>.c</code> / <code>.h</code>
        edits save locally and ride along in <em>Download .zip</em>.
      </p>
      ${banner}
      ${migrationBanner}
      <div class="cvm-pg-toolbar" role="group" aria-label="Playground controls">
        <label class="cvm-pg-field">
          <span class="cvm-pg-field__label">Project</span>
          <select id="cvm-pg-project" class="cvm-pg-select"></select>
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
      <div class="cvm-pg-toolbar cvm-pg-toolbar--demos" role="group" aria-label="Prebuilt demos">
        <span class="cvm-pg-field__label">Prebuilt demos</span>
        ${PREBUILT_DEMOS.map((d) => `<button type="button"
            class="cvm-pg-button cvm-pg-demo-load"
            data-demo-id="${escapeHtml(d.id)}"
            title="${escapeHtml(d.description)}">${escapeHtml(d.label)}</button>`).join("")}
      </div>
      <div class="cvm-pg-status-row">
        <p class="cvm-pg-status" id="cvm-pg-status" role="status" aria-live="polite"></p>
        <button type="button" id="cvm-pg-whatjusthappened" class="cvm-pg-btn-what" hidden>
          What just happened?
        </button>
      </div>
      <div id="cvm-pg-noncompiled-banner" class="cvm-pg-banner cvm-pg-banner--warn" role="note" hidden>
        <strong>Note:</strong> <code>.c</code> / <code>.h</code> edits save
        locally and ride along in <em>Download .zip</em>, but only
        <code>.r</code> resource files recompile in-browser &mdash; the
        compiled binary in the emulator reflects whatever CI built from
        <code>main</code>. Switch to a <code>.r</code> tab to see live changes.
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
