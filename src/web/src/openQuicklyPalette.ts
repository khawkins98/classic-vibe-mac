/**
 * Open Quickly palette — ⌘P fuzzy file-jump.
 *
 * Classic CodeWarrior had this as "Open Quickly…" (⌘D in CW); modern
 * editors map it to ⌘P (or Ctrl-P on non-Mac). Type a few letters,
 * Enter to jump. Within the current project — same scope as
 * CodeWarrior's per-project list.
 *
 * Implementation note: not a singleton WinBox like the other palettes
 * (about / help / preferences / welcome). This is a transient overlay
 * that closes on selection / Esc / outside-click. The classic-Mac
 * affordance for a fast picker is a centered floating dialog with
 * inset paper background, which is what we render.
 *
 * Shortcut wiring: intercepts (Meta|Ctrl)+P at document keydown level.
 * This collides with the browser's "Print" — VS Code, Sublime, and
 * essentially every other IDE that wants this binding does the same;
 * the trade is accepted. Users who actually want browser-print can
 * use the menubar's File → Print (which we don't currently have but
 * the browser exposes via right-click).
 *
 * The file list comes from the live project DOM — same source as the
 * tab bar — so it picks up user-added files from #319 + new-project
 * duplicates from #320 automatically without any new wiring.
 */

import { isMacActive } from "./activePane";

let active: { close: () => void } | null = null;

interface FileEntry {
  filename: string;
  /** Score from the fuzzy matcher; higher = better. */
  score: number;
}

/** Open the palette unconditionally. */
export function openOpenQuickly(): void {
  if (active) {
    active.close();
    return;
  }

  const files = collectProjectFiles();
  if (files.length === 0) return;

  const overlay = document.createElement("div");
  overlay.className = "cvm-openquickly-overlay";
  overlay.innerHTML = /* html */ `
    <div class="cvm-openquickly" role="dialog" aria-modal="true" aria-label="Open Quickly">
      <input
        type="text"
        class="cvm-openquickly__input"
        placeholder="Open Quickly: type a filename…"
        autocomplete="off"
        spellcheck="false"
      />
      <ul class="cvm-openquickly__list" role="listbox"></ul>
      <div class="cvm-openquickly__hint">
        <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> open · <kbd>esc</kbd> dismiss
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector<HTMLInputElement>(".cvm-openquickly__input")!;
  const list = overlay.querySelector<HTMLUListElement>(".cvm-openquickly__list")!;
  let entries: FileEntry[] = files.map((f) => ({ filename: f, score: 0 }));
  let cursor = 0;

  function renderList(): void {
    cursor = Math.max(0, Math.min(cursor, entries.length - 1));
    list.innerHTML = entries
      .map(
        (e, i) =>
          `<li class="cvm-openquickly__row${i === cursor ? " cvm-openquickly__row--active" : ""}" data-i="${i}" role="option">${escapeHtml(e.filename)}</li>`,
      )
      .join("");
    // Scroll active row into view if list is taller than the visible
    // area (e.g. user pressed ↓ past the bottom).
    list.querySelector<HTMLLIElement>(".cvm-openquickly__row--active")
      ?.scrollIntoView({ block: "nearest" });
  }

  function refilter(): void {
    const q = input.value.trim();
    if (q === "") {
      entries = files.map((f) => ({ filename: f, score: 0 }));
    } else {
      entries = files
        .map((f) => ({ filename: f, score: fuzzyScore(f, q) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score);
    }
    cursor = 0;
    renderList();
  }

  function close(): void {
    overlay.remove();
    document.removeEventListener("keydown", onDocKey, true);
    active = null;
  }

  function commit(): void {
    const chosen = entries[cursor];
    close();
    if (!chosen) return;
    // Drive the existing tab-bar click handler — re-uses the editor's
    // switchTo() without us reaching into its closure.
    const tab = document.querySelector<HTMLButtonElement>(
      `#cvm-pg-tabbar [role="tab"][data-file="${cssEscape(chosen.filename)}"]`,
    );
    tab?.click();
  }

  // Outside click closes (clicks INSIDE the dialog don't bubble past
  // the dialog because we stop them from reaching the overlay).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay
    .querySelector(".cvm-openquickly")!
    .addEventListener("click", (e) => e.stopPropagation());

  list.addEventListener("click", (e) => {
    const row = (e.target as Element).closest(".cvm-openquickly__row");
    if (!row) return;
    cursor = Number((row as HTMLElement).dataset.i ?? "0");
    commit();
  });

  input.addEventListener("input", refilter);

  function onDocKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(entries.length - 1, cursor + 1);
      renderList();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(0, cursor - 1);
      renderList();
      return;
    }
  }
  document.addEventListener("keydown", onDocKey, true);

  active = { close };
  renderList();
  // Focus the input on the next tick so the autofocus-via-attribute
  // path can't be undone by anything else snatching focus during
  // mount.
  setTimeout(() => input.focus(), 0);
}

/** Install the ⌘D (Meta-D / Ctrl-D) keyboard shortcut as an alias for
 *  Open Quickly. ⌘P is bound via the menubar's File menu shortcut
 *  field — the menubar's global keydown dispatcher fires it regardless
 *  of focus. ⌘D is here because CodeWarrior's original Open Quickly
 *  binding was ⌘D; period-Mac muscle memory reaches for that, modern
 *  muscle memory reaches for ⌘P. Both work.
 *
 *  Defers to the emulated Mac when the Macintosh pane is the active
 *  focus owner — ⌘D inside Mac Finder means "Duplicate," and that
 *  takes precedence over our Open Quickly alias.
 *
 *  Returns the unbinder if a caller ever needs to detach. */
export function installOpenQuicklyShortcut(): () => void {
  function handler(e: KeyboardEvent): void {
    if (isMacActive()) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== "d") return;
    e.preventDefault();
    openOpenQuickly();
  }
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Live project file list, scraped from the tab bar. Same source as
 *  the user sees, so user-added files (#319) and duplicate-project
 *  files (#320) all show up without extra plumbing. */
function collectProjectFiles(): string[] {
  const tabs = document.querySelectorAll<HTMLButtonElement>(
    '#cvm-pg-tabbar [role="tab"][data-file]',
  );
  return Array.from(tabs)
    .map((t) => t.dataset.file ?? "")
    .filter((f) => f !== "");
}

/** Tiny subsequence-match fuzzy scorer. Returns 0 if `query` chars
 *  don't appear in order in `s`; otherwise scores higher when matched
 *  chars are adjacent + lower when they're spread out. Case-insensitive.
 *  Plenty good for a typical project's ≤ 20 files. */
function fuzzyScore(s: string, query: string): number {
  const t = s.toLowerCase();
  const q = query.toLowerCase();
  let si = 0;
  let lastMatch = -1;
  let score = 0;
  for (const c of q) {
    const found = t.indexOf(c, si);
    if (found === -1) return 0;
    // Adjacent matches score higher (length of contiguous run); large
    // gaps are penalised.
    if (lastMatch === found - 1) score += 5;
    else score += 1;
    // Bonus for matching at the start of the filename — usual case
    // when the user types "ma" wanting "main.c".
    if (found === 0) score += 10;
    lastMatch = found;
    si = found + 1;
  }
  // Tie-break: shorter matches sort first when scores are otherwise
  // equal — "main.c" beats "Main_routines.c" for query "ma".
  return score * 100 - s.length;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** CSS.escape with a graceful fallback for ancient browsers. */
function cssEscape(s: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ce = (globalThis as any).CSS?.escape as
    | ((s: string) => string)
    | undefined;
  if (ce) return ce(s);
  return s.replace(/[^\w-]/g, (c) => `\\${c}`);
}
