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
  /** Fired when the item is clicked. Omit for disabled stubs that read
   *  as "coming soon". */
  action?: () => void;
  /** Greyed/non-interactive (still rendered for context). */
  disabled?: boolean;
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
  /** Provide a list of currently open WinBox windows (docked + palettes)
   *  so the Windows menu can list them dynamically. Caller raises a
   *  window by clicking the corresponding item. */
  listOpenWindows: () => Array<{ title: string; focus: () => void }>;
}

/** Wire dropdown menus to existing menubar buttons (created in
 *  main.ts's root.innerHTML). Returns a cleanup function. */
export function mountMenubar(actions: MenubarActions): () => void {
  // Static menus built once; the Windows menu is rebuilt each open
  // from actions.listOpenWindows() since it depends on live state.
  const staticMenus = buildMenuSchema(actions);
  function menuFor(key: string): MenuEntry[] {
    if (key === "windows") {
      const wins = actions.listOpenWindows();
      if (wins.length === 0) {
        return [{ label: "(no open windows)", disabled: true }];
      }
      return wins.map((w) => ({ label: w.title, action: w.focus }));
    }
    return staticMenus[key] ?? [];
  }
  const overlay = document.createElement("div");
  overlay.className = "cvm-menu-dropdown";
  overlay.setAttribute("role", "menu");
  overlay.hidden = true;
  document.body.appendChild(overlay);

  let openMenuKey: string | null = null;
  let openTrigger: HTMLElement | null = null;

  function closeDropdown(): void {
    overlay.hidden = true;
    overlay.innerHTML = "";
    if (openTrigger) openTrigger.classList.remove("menubar__item--open");
    openMenuKey = null;
    openTrigger = null;
  }

  function openDropdown(key: string, trigger: HTMLElement): void {
    const items = menuFor(key);
    if (!items) return;
    overlay.innerHTML = items
      .map((it, idx) => {
        if ("separator" in it) {
          return `<div class="cvm-menu-dropdown__sep" role="separator"></div>`;
        }
        const cls =
          "cvm-menu-dropdown__item" +
          (it.disabled ? " cvm-menu-dropdown__item--disabled" : "");
        const attrs = it.disabled ? "aria-disabled='true'" : `data-menu-action='${idx}'`;
        return `<button type="button"
                  class="${cls}"
                  role="menuitem"
                  ${attrs}>${escapeHtml(it.label)}</button>`;
      })
      .join("");
    const rect = trigger.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.bottom}px`;
    overlay.hidden = false;
    trigger.classList.add("menubar__item--open");
    openMenuKey = key;
    openTrigger = trigger;
  }

  overlay.addEventListener("click", (e) => {
    const btn = (e.target as Element).closest<HTMLButtonElement>(
      "[data-menu-action]",
    );
    if (!btn || !openMenuKey) return;
    const idx = Number(btn.dataset.menuAction);
    const item = menuFor(openMenuKey)[idx];
    if (item && !("separator" in item) && item.action && !item.disabled) {
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

  // Listener for "outside" clicks → close.
  function onDocClick(e: MouseEvent): void {
    if (!openMenuKey) return;
    const target = e.target as Element;
    if (overlay.contains(target)) return;
    if (target.closest("[data-menu]")) return;
    closeDropdown();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape" && openMenuKey) closeDropdown();
  }

  document.addEventListener("click", onMenubarClick, true);
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  return () => {
    document.removeEventListener("click", onMenubarClick, true);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    overlay.remove();
  };
}

function buildMenuSchema(a: MenubarActions): Record<string, MenuEntry[]> {
  return {
    apple: [{ label: "About classic-vibe-mac…", action: a.openAbout }],
    file: [
      { label: "Open Project…", action: a.openProjectPicker },
      { label: "Open .zip…", action: a.openZipPicker },
      { separator: true },
      { label: "Download .zip", action: a.downloadCurrentZip },
    ],
    edit: [
      { label: "Undo", disabled: true },
      { label: "Redo", disabled: true },
      { separator: true },
      { label: "Cut", disabled: true },
      { label: "Copy", disabled: true },
      { label: "Paste", disabled: true },
      { separator: true },
      { label: "Preferences…", action: a.openPreferences },
    ],
    view: [
      { label: "Reset window layout", action: a.resetLayout },
    ],
    special: [
      // Wired in a follow-up: reboot the emulator with the currently
      // mounted secondary disk so the user can re-launch their app
      // without rebuilding.
      { label: "Reboot Mac", disabled: true, action: a.rebootEmulator },
    ],
    help: [{ label: "classic-vibe-mac Help", action: a.openHelp }],
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
