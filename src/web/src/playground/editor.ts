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
  showBuildExplainer,
  showBuildExplainerIfFirstTime,
  type BuildExplainContext,
} from "./build-explainer";
import {
  lintExtensions,
  setEditorDiagnostics,
  clearEditorDiagnostics,
} from "./error-markers";
import {
  compileProject,
  isCompileServerAvailable,
  type CompileFile,
} from "./compile-client";

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
  const compileRunBtn = rootEl.querySelector<HTMLButtonElement>(
    "#cvm-pg-compilerun",
  );
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

  // ── Compile & Run (C → Retro68 server → emulator) ────────────────────────
  // Only wired when VITE_COMPILE_SERVER_URL is configured.
  if (compileRunBtn) {
    compileRunBtn.addEventListener("click", async () => {
      if (!hotLoad) {
        setStatus(statusEl, "Compile & Run isn't wired (no emulator).", "err");
        return;
      }
      await flushSave();
      const proj = SAMPLE_PROJECTS.find((p) => p.id === current.project);
      if (!proj) return;

      compileRunBtn.disabled = true;
      buildBtn.disabled = true;
      buildRunBtn.disabled = true;
      rootEl.setAttribute("data-rebooting", "");
      const tStart = performance.now();
      setStatus(statusEl, "Compiling C…", "info");
      clearEditorDiagnostics(view);

      try {
        // Gather all source files from IDB (user edits) for this project.
        const files: CompileFile[] = [];
        for (const filename of proj.files) {
          const content = await readOrSeedFile(baseUrl, proj.id, filename);
          files.push({ name: filename, content });
        }

        const appName = proj.outputName.replace(/\.bin$/i, "");
        const result = await compileProject(files, appName);

        if (!result.ok) {
          if (result.diagnostics.length > 0) {
            setEditorDiagnostics(view, result.diagnostics, current.filename);
            const first = result.diagnostics.find((d) => d.severity === "error") ?? result.diagnostics[0]!;
            setStatus(
              statusEl,
              `Compile error: ${first.message} (${first.file}:${first.line})`,
              "err",
            );
          } else {
            setStatus(
              statusEl,
              result.rawStderr
                ? `Compile failed: ${result.rawStderr.slice(0, 200)}`
                : "Compile failed (no diagnostics).",
              "err",
            );
          }
          return;
        }

        const buildMs = performance.now() - tStart;
        setStatus(
          statusEl,
          `Compiled in ${buildMs.toFixed(0)}ms — patching disk…`,
          "info",
        );

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
        await hotLoad({ bytes: patched, volumeName: "Apps" });

        const totalMs = performance.now() - tStart;
        setStatus(
          statusEl,
          `Done in ${totalMs.toFixed(0)}ms — double-click "Apps" on the desktop.`,
          "ok",
        );

        lastBuildCtx = {
          appName: fname,
          rezFile: current.filename,
          totalMs,
          volumeName: "Apps",
        };
        whatBtn.hidden = false;

        const willShowModal = !(() => {
          try {
            return !!localStorage.getItem("cvm.buildExplainerSeen");
          } catch {
            return false;
          }
        })();
        if (willShowModal) {
          showBuildExplainerIfFirstTime(lastBuildCtx, compileRunBtn);
        } else {
          const emWin = document.getElementById("emulator");
          if (emWin) emWin.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      } catch (e) {
        setStatus(
          statusEl,
          `Compile & Run error: ${(e as Error).message}`,
          "err",
        );
      } finally {
        compileRunBtn.disabled = false;
        buildBtn.disabled = false;
        buildRunBtn.disabled = false;
        rootEl.removeAttribute("data-rebooting");
      }
    });
  }
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
  if (/\.r$/i.test(filename)) return true;
  if (/\.(c|h)$/i.test(filename) && isCompileServerAvailable()) return true;
  return false;
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
  const compileServerNote = isCompileServerAvailable()
    ? `Hit <em>Compile &amp; Run</em> to compile your C sources on the server and
       boot straight into your app, or `
    : `<strong>Today the in-browser compile only handles
       <code>.r</code> resource files</strong> &mdash; <code>.c</code> /
       <code>.h</code> edits ride along in <em>Download .zip</em> but
       don't change the running binary (in-browser C compilation requires
       a native toolchain; see the playground README for details). `;
  const sdkNote = isCompileServerAvailable()
    ? `<p class="cvm-pg-banner cvm-pg-banner--info" role="note">
         <strong>SDK tip:</strong> use System&nbsp;7 header names &mdash;
         <code>#include &lt;Windows.h&gt;</code>, <code>&lt;Memory.h&gt;</code>,
         <code>&lt;Types.h&gt;</code>.
         The Carbon variants (<code>MacWindows.h</code>, etc.) don't exist
         in the Retro68 toolchain.
       </p>`
    : "";
  const compileRunButton = isCompileServerAvailable()
    ? `<button type="button" id="cvm-pg-compilerun" class="cvm-pg-button cvm-pg-button--primary">
           Compile &amp; Run
         </button>`
    : "";
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
        real C and Rez code for the apps running in the Mac above, and your
        edits save automatically in your browser. ${compileServerNote}hit
        <em>Build .bin</em> to compile and download a MacBinary, or
        <em>Build &amp; Run</em> to reboot the Mac with your changes mounted
        as a secondary disk.
      </p>
      ${banner}
      ${migrationBanner}
      ${sdkNote}
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
        ${compileRunButton}
        <button type="button" id="cvm-pg-download" class="cvm-pg-button">
          Download .zip
        </button>
      </div>
      <div class="cvm-pg-status-row">
        <p class="cvm-pg-status" id="cvm-pg-status" role="status" aria-live="polite"></p>
        <button type="button" id="cvm-pg-whatjusthappened" class="cvm-pg-btn-what" hidden>
          What just happened?
        </button>
      </div>
      <div id="cvm-pg-noncompiled-banner" class="cvm-pg-banner cvm-pg-banner--warn" role="note" hidden>
        <strong>Heads-up:</strong> this file isn't compiled in your browser.
        Only Rez resource files (<code>.r</code>) recompile in-browser today
        &mdash; edits to <code>.c</code> / <code>.h</code> sources save
        locally and ride along in <em>Download .zip</em>, but the data fork
        in your built <code>.bin</code> is whatever CI compiled from
        <code>main</code>. Try editing a <code>.r</code> file to see live
        changes.
      </div>
      <div id="cvm-pg-tabbar" class="cvm-pg-tabbar" role="tablist" aria-label="Source files"></div>
      <div id="cvm-pg-editor-mount" class="cvm-pg-editor" role="tabpanel"></div>
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
