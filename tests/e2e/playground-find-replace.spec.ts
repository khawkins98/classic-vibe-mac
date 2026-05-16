/**
 * Find/Replace panel regression guard (cv-mac #169).
 *
 * The playground editor wires @codemirror/search with the standard
 * keymap (⌘F open, ⌘G next, ⇧⌘G prev, ⌘⌥F replace, Esc close).
 *
 * What we verify:
 *   1. ⌘F opens a panel at the *top* of the editor (we use
 *      `top: true` in editor.ts) with the canonical CodeMirror
 *      search controls (next, prev, replace, replaceAll, close,
 *      plus the search input).
 *   2. Typing a query that exists in the editor highlights at least
 *      one match.
 *   3. Esc closes the panel.
 *   4. The panel root carries our Platinum theming (Mac OS 8 chrome
 *      font family).
 */
import { test, expect } from "@playwright/test";

const EDITOR_TEXT_SELECTOR = "#cvm-pg-editor-mount .cm-content";

test.describe("playground Find/Replace", () => {
  test("Cmd-F opens a panel, finds matches, Esc closes", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto(process.env.CVM_BASE_URL ?? "/");

    // Click into the editor so the keymap targets it, not the document.
    await page.click(EDITOR_TEXT_SELECTOR);
    await page.waitForTimeout(200);

    // Open Find. Headless chromium's keymap dispatch through Playwright
    // doesn't reliably reach CodeMirror's search keymap (Mod-f) — the
    // key gets eaten by the page's browser-default Find handler before
    // CM sees it. Drive the panel open via CodeMirror's `openSearchPanel`
    // command instead, dispatched on the editor view we can reach
    // through the visible .cm-editor's __cm_view handle. Functionally
    // identical to the user pressing Cmd-F.
    await page.evaluate(() => {
      // CodeMirror 6 attaches the EditorView instance to the
      // .cm-editor root via `_view` (internal but stable across the
      // versions we use). The standard `openSearchPanel` command takes
      // the view and side-effects the search panel open.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const root = document.querySelector("#cvm-pg-editor-mount .cm-editor") as any;
      if (!root) throw new Error("no .cm-editor mount");
      // Walk up the React-ish handle: CM exposes view via cmView.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const view = (root as any).CodeMirror ?? (root as any)._view ?? (root as any).view;
      // Fallback: dispatch the keyboard event directly to the
      // contenteditable inside. That actually reaches CM's keymap.
      const target = root.querySelector(".cm-content") as HTMLElement;
      target.focus();
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "f",
          code: "KeyF",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      // Silence unused warning if we didn't pull the view through.
      void view;
    });
    await page.waitForTimeout(400);

    // The CM search panel renders inside `.cm-panels.cm-panels-top` —
    // we anchor it top via `search({ top: true })` in editor.ts.
    // Inside is `.cm-search` with input + buttons.
    // CodeMirror's actual class is `.cm-panel.cm-search` — the outer
    // `.cm-panels-top` container is the panel-side wrapper but the
    // search itself is `.cm-search` on a panel div.
    const panel = page.locator(".cm-panel.cm-search");
    await expect(panel).toBeAttached();

    // Confirm Platinum theming applied (Chicago font family).
    const fontFamily = await panel.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).toMatch(/Chicago|ChicagoFLF|Charcoal|Geneva/);

    // Canonical CodeMirror buttons: next, prev, select, replace,
    // replaceAll, close. We just check the count + a couple of names.
    const btnCount = await panel.locator("button").count();
    expect(btnCount).toBeGreaterThanOrEqual(5);
    await expect(panel.locator("button[name='next']")).toBeAttached();
    await expect(panel.locator("button[name='close']")).toBeAttached();

    // Type a single-char query that has to appear in any C source —
    // `#` for include directives, or even a brace. Use `#` since
    // every wasm-shelf .c starts with includes. Don't use `InitGraf`
    // or other Toolbox names because (a) the user may have IDB-edits
    // from a prior session that removed them, (b) the smallest sample
    // (wasm-hello) doesn't always have a fixed surface.
    // CodeMirror's search input updates on onchange / onkeyup, neither
    // of which Playwright's fill() guarantees to fire. Type the query
    // key by key (triggers onkeyup) then press Enter so the search
    // commits immediately rather than waiting for a debounce.
    await panel.locator("input[name='search']").focus();
    await page.keyboard.type("#include");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const matchCount = await page.locator(".cm-searchMatch").count();
    expect(matchCount).toBeGreaterThan(0);

    // Esc closes the panel.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const stillOpen = await page.locator(".cm-panel.cm-search").count();
    expect(stillOpen).toBe(0);
  });
});
