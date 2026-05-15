/**
 * menubarMenus.ts — classic Mac OS 8 pull-down menus for the menubar.
 *
 * Each menubar item (Apple / File / Edit / View / Special / Help) is a
 * button with a `data-menu` identifier. Clicking it pops a dropdown
 * positioned directly below the item, listing the menu's commands;
 * clicking a command fires its action and closes the dropdown; clicking
 * outside or pressing Escape also closes.
 *
 * The dropdown HTML is rendered into a single overlay element appended
 * to <body> so it z-index-floats above the WinBox panes. CSS in
 * style.css under `.cvm-menu-dropdown` shapes it Mac-OS-8-style (white
 * paper background, 1-pixel ink border, hover-highlight rows).
 *
 * Disabled items render greyed and don't fire. Separators render as a
 * 1-pixel-tall divider with no padding.
 */

export interface MenuItem {
  /** Visible label. May contain "…" suffix per Mac convention when the
   *  command opens a dialog. */
  label: string;
  /** Fired when the item is clicked or when its keyboard shortcut
   *  fires. Omit for disabled stubs that read as "coming soon". */
  action?: () => void;
  /**
   * Greyed/non-interactive. Boolean for static placeholders ("Coming
   * soon"), or a thunk for live state (e.g. Reboot Mac is disabled
   * until the first Build & Run produces a cached spec). The thunk is
   * called every time the dropdown is opened and on each shortcut
   * keystroke, so it should be cheap.
   */
  disabled?: boolean | (() => boolean);
  /**
   * Single-letter Cmd-key shortcut (uppercase). Rendered right-aligned
   * in the dropdown (⌘L on Mac, Ctrl-L elsewhere) and dispatched
   * globally by a single keydown handler, so the user can fire the
   * action without opening the menu. Skipped when disabled.
   */
  shortcut?: string;
}

/** Resolve the `disabled` field to a boolean for the current frame. */
function isDisabled(item: MenuItem): boolean {
  return typeof item.disabled === "function" ? item.disabled() : !!item.disabled;
}

export type MenuEntry = MenuItem | { separator: true };

export interface MenubarActions {
  openAbout: () => void;
  openPreferences: () => void;
  openHelp: () => void;
  openProjectPicker: () => void;
  openZipPicker: () => void;
  downloadCurrentZip: () => void;
  resetLayout: () => void;
  rebootEmulator: () => void;
  /** Live predicate for whether Reboot Mac should be enabled. False
   *  until the first Build & Run produces a cached spec. */
  canRebootEmulator: () => boolean;
  /** Provide a list of currently open WinBox windows (docked + palettes)
   *  so the Windows menu can list them dynamically. Caller raises a
   *  window by clicking the corresponding item. */
  listOpenWindows: () => Array<{ title: string; focus: () => void }>;
  /** Provide the most recently switched-to projects (most recent first,
   *  current project excluded). The Apple menu lists them under About
   *  as the classic System 7 Apple-menu pattern. Caller switches via
   *  the item's action. */
  listRecentProjects: () => Array<{ label: string; switchTo: () => void }>;
}

// "⌘" on macOS, "Ctrl-" elsewhere. Mac-only `navigator.platform` is
// deprecated but `userAgent` still gives us the platform reliably for
// this UI hint. Falls back to "Ctrl-" if detection fails.
const IS_MAC = (() => {
  try {
    return /Mac|iPhone|iPad/.test(navigator.userAgent);
  } catch {
    return false;
  }
})();
const SHORTCUT_PREFIX = IS_MAC ? "⌘" : "Ctrl-"; // ⌘ or Ctrl-

/** Wire dropdown menus to existing menubar buttons (created in
 *  main.ts's root.innerHTML). Returns a cleanup function. */
export function mountMenubar(actions: MenubarActions): () => void {
  // Static menus built once; the Apple + Windows menus are rebuilt
  // each open because they depend on live state (recent project list
  // and current WinBox stack respectively).
  const staticMenus = buildMenuSchema(actions);
  function menuFor(key: string): MenuEntry[] {
    if (key === "windows") {
      const wins = actions.listOpenWindows();
      if (wins.length === 0) {
        return [{ label: "(no open windows)", disabled: true }];
      }
      return wins.map((w) => ({ label: w.title, action: w.focus }));
    }
    if (key === "apple") {
      const recent = actions.listRecentProjects();
      const base: MenuEntry[] = [
        { label: "About classic-vibe-mac…", action: actions.openAbout },
      ];
      if (recent.length === 0) return base;
      // Classic System 7 Apple-menu shape: About at top, then a divider,
      // then a list of recents (truncated by the caller). The caller
      // can cap at e.g. 5 entries in localStorage; we render whatever
      // they hand us.
      return [
        ...base,
        { separator: true },
        ...recent.map((r) => ({ label: r.label, action: r.switchTo })),
      ];
    }
    return staticMenus[key] ?? [];
  }
  const overlay = document.createElement("div");
  overlay.className = "cvm-menu-dropdown";
  overlay.setAttribute("role", "menu");
  overlay.hidden = true;
  document.body.appendChild(overlay);

  // Default every menubar trigger to aria-expanded="false". openDropdown
  // / closeDropdown flip the currently-active one. The aria-haspopup
  // attribute is set in main.ts's static markup.
  for (const t of document.querySelectorAll<HTMLElement>("[data-menu]")) {
    t.setAttribute("aria-expanded", "false");
  }

  let openMenuKey: string | null = null;
  let openTrigger: HTMLElement | null = null;
  // Snapshot of the items list at openDropdown time. The Windows menu's
  // items come from a live action (listOpenWindows), and re-querying at
  // click time could shift indexes if a WinBox opened/closed in between —
  // making a click fire the wrong action. We snapshot once on open and
  // bind both render and click to the same list.
  let openItems: MenuEntry[] = [];
  // For Escape-to-close: remember what had focus before the menu opened,
  // so Escape returns focus there instead of leaving it on a stale
  // menubar trigger.
  let preOpenFocus: HTMLElement | null = null;

  function closeDropdown(opts?: { restoreFocus?: boolean }): void {
    overlay.hidden = true;
    overlay.innerHTML = "";
    if (openTrigger) {
      openTrigger.classList.remove("menubar__item--open");
      openTrigger.setAttribute("aria-expanded", "false");
    }
    openMenuKey = null;
    openTrigger = null;
    openItems = [];
    if (opts?.restoreFocus && preOpenFocus && document.contains(preOpenFocus)) {
      try { preOpenFocus.focus(); } catch { /* element became unfocusable */ }
    }
    preOpenFocus = null;
  }

  function openDropdown(key: string, trigger: HTMLElement): void {
    const items = menuFor(key);
    if (!items) return;
    openItems = items;
    preOpenFocus = (document.activeElement as HTMLElement | null) ?? null;
    overlay.innerHTML = items
      .map((it, idx) => {
        if ("separator" in it) {
          return `<div class="cvm-menu-dropdown__sep" role="separator"></div>`;
        }
        const dis = isDisabled(it);
        const cls =
          "cvm-menu-dropdown__item" +
          (dis ? " cvm-menu-dropdown__item--disabled" : "");
        const attrs = dis ? "aria-disabled='true'" : `data-menu-action='${idx}'`;
        const shortcut = it.shortcut && !dis
          ? `<span class="cvm-menu-dropdown__shortcut">${SHORTCUT_PREFIX}${escapeHtml(it.shortcut)}</span>`
          : "";
        return `<button type="button"
                  class="${cls}"
                  role="menuitem"
                  ${attrs}><span class="cvm-menu-dropdown__label">${escapeHtml(it.label)}</span>${shortcut}</button>`;
      })
      .join("");
    const rect = trigger.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.bottom}px`;
    overlay.hidden = false;
    trigger.classList.add("menubar__item--open");
    trigger.setAttribute("aria-expanded", "true");
    openMenuKey = key;
    openTrigger = trigger;
  }

  overlay.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(
      "[data-menu-action]",
    );
    if (!btn || !openMenuKey) return;
    const idx = Number(btn.dataset.menuAction);
    // Defend against a malformed/missing dataset — Number("") is 0 which
    // would silently fire the first item.
    if (!Number.isInteger(idx) || idx < 0 || idx >= openItems.length) return;
    const item = openItems[idx]!;
    if (!("separator" in item) && item.action && !isDisabled(item)) {
      const a = item.action;
      // Close BEFORE firing so the action can open a palette that wants focus.
      closeDropdown();
      a();
    }
  });

  // Listener for clicks on menubar buttons. Same button toggles closed
  // when already open (classic Mac feel).
  function onMenubarClick(e: MouseEvent): void {
    const btn = (e.target as Element).closest<HTMLElement>(
      "[data-menu]",
    );
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const key = btn.dataset.menu!;
    if (openMenuKey === key) {
      closeDropdown();
      return;
    }
    if (openMenuKey) closeDropdown();
    openDropdown(key, btn);
  }

  // Hover-to-switch: while a dropdown is open, hovering a *different*
  // menubar trigger swaps to that menu without clicking. Classic Mac
  // menubar behaviour — once a menu is "active" the user is effectively
  // browsing the menubar with the cursor. When no menu is open, hover
  // is a no-op (we don't pop a menu just because the cursor passed by).
  function onMenubarHover(e: MouseEvent): void {
    if (!openMenuKey) return;
    const btn = (e.target as Element).closest<HTMLElement>("[data-menu]");
    if (!btn) return;
    const key = btn.dataset.menu!;
    if (key === openMenuKey) return;
    closeDropdown();
    openDropdown(key, btn);
  }

  // Listener for "outside" clicks → close.
  function onDocClick(e: MouseEvent): void {
    if (!openMenuKey) return;
    const target = e.target as Element;
    if (overlay.contains(target)) return;
    if (target.closest("[data-menu]")) return;
    closeDropdown();
  }

  function focusableItems(): HTMLButtonElement[] {
    return Array.from(
      overlay.querySelectorAll<HTMLButtonElement>("[data-menu-action]"),
    );
  }

  function menubarTriggers(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-menu]"));
  }

  function focusItem(idx: number): void {
    const items = focusableItems();
    if (items.length === 0) return;
    const wrapped = ((idx % items.length) + items.length) % items.length;
    items[wrapped]!.focus();
  }

  function switchToNeighborMenu(direction: 1 | -1): void {
    if (!openTrigger) return;
    const triggers = menubarTriggers();
    const i = triggers.indexOf(openTrigger);
    if (i < 0) return;
    const next = triggers[(i + direction + triggers.length) % triggers.length];
    if (!next) return;
    closeDropdown();
    openDropdown(next.dataset.menu!, next);
    // Focus the menubar trigger so further left/right keep working;
    // ArrowDown then moves into the dropdown.
    next.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && openMenuKey) {
      closeDropdown({ restoreFocus: true });
      return;
    }

    // F10 / Alt — enter the menubar from anywhere. Focuses the first
    // menubar trigger so subsequent Arrow / Enter / Type-ahead picks
    // up the walk. Skips when focus is editable (typing in CodeMirror
    // shouldn't be hijacked).
    if (
      (e.key === "F10" || (e.key === "Alt" && !e.repeat)) &&
      !e.shiftKey && !e.ctrlKey && !e.metaKey &&
      !isEditableTarget(e.target as HTMLElement | null) &&
      !isEditableTarget(document.activeElement as HTMLElement | null)
    ) {
      e.preventDefault();
      const triggers = menubarTriggers();
      // If we're already inside the menubar, F10 should close any open
      // menu and return focus to the body (matches Windows convention).
      if (
        openMenuKey ||
        (document.activeElement && triggers.includes(
          document.activeElement as HTMLElement,
        ))
      ) {
        if (openMenuKey) closeDropdown({ restoreFocus: true });
        else (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      triggers[0]?.focus();
      return;
    }

    // When a menubar trigger is focused (but no menu yet open), allow
    // Left/Right to walk the menubar and ArrowDown / Enter / Space to
    // open the focused menu. Mirrors how Mac OS 8's Finder feels once
    // you've "entered" the menubar via F10 (or, in 1997, Power Manager's
    // keyboard menubar mode).
    if (!openMenuKey) {
      const triggers = menubarTriggers();
      const focused = triggers.indexOf(document.activeElement as HTMLElement);
      if (focused >= 0) {
        switch (e.key) {
          case "ArrowLeft": {
            e.preventDefault();
            triggers[(focused - 1 + triggers.length) % triggers.length]!.focus();
            return;
          }
          case "ArrowRight": {
            e.preventDefault();
            triggers[(focused + 1) % triggers.length]!.focus();
            return;
          }
          case "ArrowDown":
          case "Enter":
          case " ": {
            e.preventDefault();
            const t = triggers[focused]!;
            openDropdown(t.dataset.menu!, t);
            // After opening, place focus inside the dropdown so the
            // existing ↓↑ handlers can walk it.
            focusItem(0);
            return;
          }
        }
      }
    }

    // Arrow-key navigation while a dropdown is open. The classic Mac
    // menubar walk: Down/Up move through items, Enter fires, Left/Right
    // jump to neighbour menus.
    if (openMenuKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const items = focusableItems();
          const cur = items.indexOf(document.activeElement as HTMLButtonElement);
          focusItem(cur + 1);
          return;
        }
        case "ArrowUp": {
          e.preventDefault();
          const items = focusableItems();
          const cur = items.indexOf(document.activeElement as HTMLButtonElement);
          focusItem(cur === -1 ? items.length - 1 : cur - 1);
          return;
        }
        case "Home":
          e.preventDefault();
          focusItem(0);
          return;
        case "End": {
          e.preventDefault();
          const items = focusableItems();
          focusItem(items.length - 1);
          return;
        }
        case "ArrowLeft":
          e.preventDefault();
          switchToNeighborMenu(-1);
          return;
        case "ArrowRight":
          e.preventDefault();
          switchToNeighborMenu(1);
          return;
        case "Enter":
        case " ": {
          const active = document.activeElement as HTMLButtonElement | null;
          if (active && active.matches("[data-menu-action]")) {
            e.preventDefault();
            active.click();
            return;
          }
          break;
        }
        default: {
          // Type-ahead: a single printable letter (no modifiers) while a
          // menu is open jumps focus to the next item whose label starts
          // with that letter. Classic Mac menubar behaviour — try it in
          // 1997's Finder and the same thing happens.
          if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
            e.preventDefault();
            const items = focusableItems();
            if (items.length === 0) break;
            const ch = e.key.toLowerCase();
            const curIdx = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            // Search starting AFTER the currently-focused item so repeated
            // presses of the same letter cycle through siblings.
            const start = curIdx === -1 ? 0 : curIdx + 1;
            for (let off = 0; off < items.length; off++) {
              const candidate = items[(start + off) % items.length]!;
              const label = candidate
                .querySelector(".cvm-menu-dropdown__label")
                ?.textContent?.trim()
                .toLowerCase() ?? "";
              if (label.startsWith(ch)) {
                candidate.focus();
                return;
              }
            }
          }
          break;
        }
      }
    }
    // Global Cmd-key (Mac) / Ctrl-key (other) dispatch. We honour
    // shortcuts only when the modifier is held AND the key is a
    // single character matching a registered MenuItem.shortcut. We
    // skip when the user is typing in an input/textarea/contenteditable
    // so CodeMirror keybindings (Cmd-A select-all etc.) win locally.
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey) return;
    // Only single-character keys are shortcuts (skip arrows, F-keys, etc.).
    if (e.key.length !== 1) return;
    // Skip when focus is in an editable surface — CodeMirror, inputs, etc.
    // Check BOTH event target (some events lift target to document.body)
    // and the active element (the real focus owner). Either being editable
    // is enough to defer to local keybindings.
    if (
      isEditableTarget(e.target as HTMLElement | null) ||
      isEditableTarget(document.activeElement as HTMLElement | null)
    ) {
      return;
    }
    const target = e.key.toUpperCase();
    // Walk every menu's schema looking for the shortcut. Static menus
    // only; the Windows menu's dynamic entries don't carry shortcuts.
    for (const key of Object.keys(staticMenus)) {
      for (const item of staticMenus[key]) {
        if ("separator" in item) continue;
        if (isDisabled(item)) continue;
        if (!item.shortcut) continue;
        if (item.shortcut.toUpperCase() === target && item.action) {
          e.preventDefault();
          if (openMenuKey) closeDropdown();
          item.action();
          return;
        }
      }
    }
  }

  function isEditableTarget(el: HTMLElement | null): boolean {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (el.isContentEditable) return true;
    // CodeMirror 6's editing surface is contenteditable inside .cm-content;
    // the isContentEditable check above catches it.
    return false;
  }

  document.addEventListener("click", onMenubarClick, true);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);
  document.addEventListener("mouseover", onMenubarHover);

  return () => {
    document.removeEventListener("click", onMenubarClick, true);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mouseover", onMenubarHover);
    overlay.remove();
  };
}

function buildMenuSchema(a: MenubarActions): Record<string, MenuEntry[]> {
  return {
    // apple — dynamic; built by menuFor("apple") so the Recent Projects
    // list reflects live state. No static schema entry needed.
    file: [
      { label: "Open Project…", action: a.openProjectPicker, shortcut: "O" },
      { label: "Open .zip…", action: a.openZipPicker },
      { separator: true },
      { label: "Download .zip", action: a.downloadCurrentZip, shortcut: "S" },
    ],
    edit: [
      // Cut/Copy/Paste deliberately omit shortcuts here. CodeMirror
      // owns ⌘X / ⌘C / ⌘V inside the editor; outside the editor the
      // browser's defaults already work. Wiring them to a global
      // handler would steal those keystrokes from both.
      { label: "Undo", disabled: true },
      { label: "Redo", disabled: true },
      { separator: true },
      { label: "Cut", disabled: true },
      { label: "Copy", disabled: true },
      { label: "Paste", disabled: true },
      { separator: true },
      { label: "Preferences…", action: a.openPreferences, shortcut: "," },
    ],
    view: [
      // Reset has no shortcut — Cmd-R is browser reload, and stealing
      // that would be a real regression for the most common keystroke.
      { label: "Reset window layout", action: a.resetLayout },
    ],
    special: [
      // Re-launch the most recently built app — calls reboot() on the
      // emulator with the cached lastBootSpec. If no Build & Run has
      // happened yet the action surfaces a console hint and no-ops;
      // we don't dynamically grey because the live state isn't tracked
      // in the menu schema.
      {
        label: "Reboot Mac",
        action: a.rebootEmulator,
        // Disabled until the first Build & Run caches an EmulatorInMemoryDiskSpec
        // in main.ts. Dynamic — evaluated each time the menu opens.
        disabled: () => !a.canRebootEmulator(),
      },
    ],
    help: [{ label: "classic-vibe-mac Help", action: a.openHelp, shortcut: "?" }],
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}
