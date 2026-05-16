/**
 * asm-palette.ts — Show Assembly as a draggable WinBox palette
 * (cv-mac #218 item 4 follow-up to the inline `<details>` panel).
 *
 * Previously the m68k assembly view lived as an inline `<details>` at
 * the bottom of the Playground pane. When expanded it stole a large
 * chunk of vertical space from the source editor above; when collapsed
 * its summary row still occupied the panel's bottom edge. The honest
 * fit: assembly is a *secondary view of the active source file*, not
 * a co-equal pane with the editor — so it belongs in its own palette,
 * closed by default, openable from a toolbar button (and auto-listed
 * in the menubar Windows menu since `listOpenWindows` reads from
 * `WinBox.stack()`).
 *
 * This module owns:
 *   - the singleton WinBox instance
 *   - the palette DOM (status, meter, mount, stderr-details)
 *   - the read-only m68k CodeMirror view inside that mount
 *
 * editor.ts owns the *compile pipeline* — `runAsmCompile`, the
 * sequence guard, the debounced `scheduleAsmCompile`, sibling-file
 * fetching for `#include "x.h"` resolution. It pushes results into
 * this palette via the setter functions exported below; the setters
 * no-op when the palette is closed, which is how the closed-by-default
 * gating works (no work happens until the palette is open).
 *
 * The palette emits an open notification (`onAsmPaletteOpen`) so
 * editor.ts can fire an immediate (no-debounce) compile on first
 * open — same UX the old `<details>` toggle handler had.
 */

// Side-effect import the WinBox bundle (broken main field) — same
// pattern as the other palettes.
import "winbox/dist/winbox.bundle.min.js";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { m68k } from "./lang-m68k";
import { enableShade } from "../winboxChrome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

interface Active {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any;
  asmView: EditorView;
  statusEl: HTMLDivElement;
  meterEl: HTMLSpanElement;
  stderrWrapEl: HTMLDetailsElement;
  stderrEl: HTMLPreElement;
}

let active: Active | null = null;
const openListeners = new Set<() => void>();

export function isAsmPaletteOpen(): boolean {
  return active !== null;
}

/**
 * Subscribe to "the palette just opened" events. Used by editor.ts to
 * kick off an immediate compile on first open (subsequent opens reuse
 * the still-current content from the last compile, no work needed
 * unless source has since changed — which `scheduleAsmCompile`'s
 * own seq guard handles).
 *
 * Returns an unsubscribe function.
 */
export function onAsmPaletteOpen(cb: () => void): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}

/**
 * Open the palette. Singleton — re-calls just focus the existing
 * window. The first call constructs the WinBox, mounts the DOM,
 * lazy-loads the read-only m68k CodeMirror, and fires
 * `onAsmPaletteOpen` listeners so the compile pipeline can run.
 */
export function openAsmPalette(): void {
  if (active) {
    try { active.wb.focus(); } catch { /* defunct */ }
    return;
  }

  const body = document.createElement("div");
  body.className = "cvm-asm-palette";

  // Intro prose — same one the old `<details>` had, condensed slightly
  // for the palette form factor (palette body is narrower than the
  // full playground pane was).
  const intro = document.createElement("p");
  intro.className = "cvm-pg-asm-intro";
  intro.innerHTML =
    'The active <code>.c</code> file is compiled through <code>cc1.wasm</code> &mdash; ' +
    'the real GCC 12 backend for Motorola 68k, ported to WebAssembly. Output is exactly ' +
    'what the cross-compiler would emit running natively. Switch to a <code>.c</code> tab to ' +
    'see the assembly update as you type (~500&nbsp;ms debounce).';

  const statusEl = document.createElement("div");
  statusEl.className = "cvm-pg-asm-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");

  const mountEl = document.createElement("div");
  mountEl.className = "cvm-pg-asm-mount";
  mountEl.setAttribute("aria-label", "m68k assembly output");

  const stderrWrapEl = document.createElement("details");
  stderrWrapEl.className = "cvm-pg-asm-stderr-wrap";
  stderrWrapEl.hidden = true;
  const stderrSummary = document.createElement("summary");
  stderrSummary.textContent = "cc1 diagnostics";
  const stderrEl = document.createElement("pre");
  stderrEl.className = "cvm-pg-asm-stderr";
  stderrWrapEl.append(stderrSummary, stderrEl);

  body.append(intro, statusEl, mountEl, stderrWrapEl);

  // Read-only m68k assembly view. Mounting here (rather than in
  // editor.ts) keeps the editor module free of the asm-specific
  // CodeMirror config, and lets the view's lifecycle match the
  // palette's — closing the palette tears down the EditorView, which
  // releases the cm-content DOM and any handlers it owns.
  const asmView = new EditorView({
    parent: mountEl,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        m68k(),
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

  // Meter (the "123ms · 47L" suffix) lives in the title bar via
  // setTitle — there's no chrome on a WinBox to host a permanent
  // <span> outside the body. We carry an off-DOM <span> so the
  // existing editor.ts code (`setAsmMeter(text)`) can keep writing
  // to a stable element; we mirror its content into the WinBox
  // title on each update.
  const meterEl = document.createElement("span");
  meterEl.className = "cvm-pg-asm-meter";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Show Assembly",
    width: "560px",
    height: "440px",
    x: "center",
    y: "center",
    mount: body,
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-asm-winbox", "cvm-mac-winbox"],
    onclose: () => {
      // Destroy the CM view so closing actually releases its DOM —
      // re-opening builds a fresh view, which avoids the stale-state
      // edge cases that come from keeping a detached EditorView around.
      try { asmView.destroy(); } catch { /* defunct */ }
      active = null;
      return false;
    },
  });
  enableShade(wb);

  active = { wb, asmView, statusEl, meterEl, stderrWrapEl, stderrEl };

  // Notify subscribers. RequestAnimationFrame so the WinBox is in the
  // DOM by the time the listener (typically a compile kickoff) runs.
  requestAnimationFrame(() => {
    for (const cb of openListeners) cb();
  });
}

export function closeAsmPalette(): void {
  active?.wb.close();
}

/**
 * Update the status line ("Compiling…", "47 lines in 123ms",
 * "error: …"). No-ops when palette is closed.
 */
export function setAsmStatus(
  text: string,
  kind: "info" | "ok" | "err",
): void {
  if (!active) return;
  active.statusEl.textContent = text;
  active.statusEl.dataset.kind = kind;
}

/**
 * Update the title-bar meter ("123ms · 47L" or "compiling…" or
 * "error"). Reflected into the WinBox title since that's the visible
 * surface; the off-DOM `<span>` is kept so editor.ts can read back
 * what was last set if it needs to.
 */
export function setAsmMeter(text: string): void {
  if (!active) return;
  active.meterEl.textContent = text;
  const t = text ? `Show Assembly — ${text}` : "Show Assembly";
  try { active.wb.setTitle(t); } catch { /* defunct */ }
}

/** Replace the assembly view's content. No-ops when palette closed. */
export function setAsmContent(asmText: string): void {
  if (!active) return;
  const view = active.asmView;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: asmText },
    scrollIntoView: false,
  });
}

/**
 * Show or hide the cc1-diagnostics block. Pass empty/whitespace text
 * to hide it; non-empty text both fills and reveals it.
 */
export function setAsmStderr(text: string): void {
  if (!active) return;
  if (text.trim()) {
    active.stderrEl.textContent = text;
    active.stderrWrapEl.hidden = false;
  } else {
    active.stderrWrapEl.hidden = true;
  }
}
