/**
 * toolbox-tooltip.ts — hover-tooltip for Mac Toolbox API symbols in the
 * playground editor (cv-mac #196 Phase 3).
 *
 * Hover over `NewGWorld` (or any of ~80 other Toolbox calls) and a small
 * card appears with the Inside-Macintosh-style signature, a one-paragraph
 * description, and a "see also" list. Reference data lives in
 * `toolbox-reference.json`, sourced from Inside Macintosh: Macintosh
 * Toolbox Essentials / Imaging With QuickDraw / Text / Files.
 *
 * Scope (MVP):
 *   - hover only — no ⌘-click WinBox yet
 *   - lookup is exact-match on the identifier under the cursor
 *   - the data set covers the calls the bundled wasm-* samples
 *     actually use (~80 entries). New samples reach for new APIs;
 *     add entries as they come up.
 */
import { hoverTooltip, type Tooltip } from "@codemirror/view";
import refData from "./toolbox-reference.json";

interface ToolboxEntry {
  header: string;
  signature: string;
  blurb: string;
  seeAlso?: string[];
}

// The JSON has a `_meta` key for provenance; strip it from the lookup.
const reference: Record<string, ToolboxEntry> = Object.fromEntries(
  Object.entries(refData as Record<string, unknown>).filter(
    ([k]) => !k.startsWith("_"),
  ),
) as Record<string, ToolboxEntry>;

/** Word boundary for C identifiers — letter, digit, underscore. */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/** Pull the identifier under (line, col) inside `lineText`. */
function identifierAt(lineText: string, col: number): { word: string; from: number; to: number } | null {
  if (col < 0 || col > lineText.length) return null;
  // Allow the cursor to be just past the last char too.
  const probe = col === lineText.length ? col - 1 : col;
  if (probe < 0 || !isIdentChar(lineText[probe] ?? "")) return null;
  let from = probe;
  while (from > 0 && isIdentChar(lineText[from - 1] ?? "")) from--;
  let to = probe + 1;
  while (to < lineText.length && isIdentChar(lineText[to] ?? "")) to++;
  return { word: lineText.slice(from, to), from, to };
}

/**
 * Build the tooltip DOM. Returns a self-contained element so the
 * caller can append it without thinking about styling — all CSS is
 * inlined via the `cvm-tt-*` classes in style.css (a separate file
 * so the rule lives next to the other playground styling).
 */
function renderTooltip(name: string, entry: ToolboxEntry): HTMLElement {
  const root = document.createElement("div");
  root.className = "cvm-tt";

  const header = document.createElement("div");
  header.className = "cvm-tt__header";
  const nameEl = document.createElement("span");
  nameEl.className = "cvm-tt__name";
  nameEl.textContent = name;
  const headerName = document.createElement("span");
  headerName.className = "cvm-tt__include";
  headerName.textContent = `<${entry.header}>`;
  header.append(nameEl, headerName);

  const sig = document.createElement("pre");
  sig.className = "cvm-tt__sig";
  sig.textContent = entry.signature;

  const blurb = document.createElement("p");
  blurb.className = "cvm-tt__blurb";
  blurb.textContent = entry.blurb;

  root.append(header, sig, blurb);

  if (entry.seeAlso && entry.seeAlso.length) {
    const seeAlso = document.createElement("div");
    seeAlso.className = "cvm-tt__see-also";
    const label = document.createElement("span");
    label.className = "cvm-tt__see-also-label";
    label.textContent = "See also: ";
    seeAlso.append(label, document.createTextNode(entry.seeAlso.join(", ")));
    root.append(seeAlso);
  }

  return root;
}

/**
 * The exported hoverTooltip extension. Plug into the editor's
 * extension list and it Just Works — CodeMirror handles positioning,
 * the appear/disappear delay, the dismiss-on-mousemove logic.
 */
export const toolboxHoverTooltip = hoverTooltip((view, pos, side): Tooltip | null => {
  const line = view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const ident = identifierAt(line.text, col);
  if (!ident) return null;
  // For very common short identifiers (i, j, k, qd, ...) skip the lookup
  // entirely — keeps the tooltip from flickering as the user scans
  // through unrelated variable names.
  if (ident.word.length < 3) return null;
  const entry = reference[ident.word];
  if (!entry) return null;
  // `side` is +1 if the hover landed past the end of the line; ignore
  // those positions so we don't show a tooltip for whitespace clicks.
  if (side > 0 && col >= line.text.length) return null;
  return {
    pos: line.from + ident.from,
    end: line.from + ident.to,
    above: true,
    create: () => ({ dom: renderTooltip(ident.word, entry) }),
  };
});
