/**
 * error-markers.ts — wire WASM-Rez / preprocessor diagnostics into
 * CodeMirror as red-squiggle lint markers.
 *
 * Track 6 of Issue #30. Uses @codemirror/lint's lintGutter + setDiagnostics
 * so we get the standard CodeMirror error/warning rendering (line gutter
 * dot, inline underline, hover tooltip) without rolling our own
 * decorations.
 *
 * The preprocessor and rez.ts already emit a uniform Diagnostic shape
 * (file, line, column, message, severity). This module is the thin
 * adapter that maps Diagnostic.line (1-indexed within a *file*) to a
 * CodeMirror document position, and surfaces only the diagnostics whose
 * file matches the buffer currently shown in the editor.
 *
 * Cross-file diagnostics (a syntax error in an `#include`d header) are
 * deliberately attached to the `#include` line of the active buffer
 * with a "in <file>:<line>:" prefix — that way the user sees ONE error
 * marker on the import line and clicking it shows them where the real
 * problem is. Without this remap they'd just see "no errors" in the
 * top-level file even though the compile failed.
 */

import { setDiagnostics, lintGutter, type Diagnostic as CmDiag } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { Diagnostic } from "./preprocessor";

/** Default lint extensions: gutter dots + tooltip styling. Add to the
 *  initial editor config (NOT a Compartment-reconfigure target — it
 *  doesn't change at runtime; only the diagnostic SET changes via
 *  `setDiagnostics`). */
export function lintExtensions(): Extension[] {
  return [lintGutter()];
}

/**
 * Push a diagnostics list onto the CodeMirror editor.
 *
 * `view` is the CodeMirror instance.
 * `diagnostics` is the raw list (potentially from multiple files).
 * `activeFile` is the filename currently showing in the editor — only
 * diagnostics from this file get inline markers; the rest are remapped
 * to the `#include` line that brought them in (best-effort: we just
 * pick the first `#include "<file>"` we find for now).
 */
export function setEditorDiagnostics(
  view: EditorView,
  diagnostics: Diagnostic[],
  activeFile: string,
): void {
  const doc = view.state.doc;
  const out: CmDiag[] = [];

  // Build a quick line→pos lookup for the active file. CodeMirror's
  // doc.line is 1-indexed; .from is the absolute character offset of
  // the first byte on that line (good enough — for column accuracy
  // we'd need to walk the line, but Rez emits column 1 for most of
  // its diagnostics anyway).
  const lineToPos = (line: number): { from: number; to: number } => {
    const safe = Math.max(1, Math.min(line, doc.lines));
    const docLine = doc.line(safe);
    return { from: docLine.from, to: docLine.to };
  };

  for (const d of diagnostics) {
    if (d.file === activeFile) {
      const { from, to } = lineToPos(d.line);
      out.push({
        from,
        to,
        severity: d.severity,
        message: d.message,
      });
    } else {
      // Cross-file: attach to the first `#include "<d.file>"` we can
      // find. Failing that, attach to line 1 as a fallback.
      const docText = doc.toString();
      const re = new RegExp(
        `^[ \\t]*#\\s*include\\s+["<]${escapeRegex(d.file)}[">]`,
        "m",
      );
      const m = re.exec(docText);
      let pos: { from: number; to: number };
      if (m) {
        const start = m.index;
        const end = start + m[0].length;
        pos = { from: start, to: end };
      } else {
        pos = lineToPos(1);
      }
      out.push({
        from: pos.from,
        to: pos.to,
        severity: d.severity,
        message: `in ${d.file}:${d.line}: ${d.message}`,
      });
    }
  }

  view.dispatch(setDiagnostics(view.state, out));
}

/** Clear all diagnostics. Useful when the user starts editing again. */
export function clearEditorDiagnostics(view: EditorView): void {
  view.dispatch(setDiagnostics(view.state, []));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
