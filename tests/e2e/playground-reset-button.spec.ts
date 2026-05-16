/**
 * Reset button regression guard (cv-mac #164).
 *
 * The Playground toolbar's Reset button discards local IDB edits and
 * re-fetches every file for the active project from the bundled
 * defaults. Easy to break:
 *   - changing the file-state lifecycle (IDB schema, fileKey shape)
 *   - changing the persistence module's clearProjectFiles export
 *   - changing the editor's confirm dialog flow
 *
 * What we verify:
 *   1. The button + the explanatory caption render in the toolbar.
 *   2. Editing the source then clicking Reset (with the confirm
 *      auto-accepted) drops the user's marker text.
 *   3. The status line announces success.
 *
 * Note: CodeMirror's `.cm-content` only renders the in-viewport lines
 * into the DOM, so we use a presence-of-marker check rather than
 * full-text length compares. The marker is unique enough that any
 * remaining occurrence means Reset did not actually wipe IDB.
 */
import { test, expect } from "@playwright/test";

const EDITOR_TEXT_SELECTOR = "#cvm-pg-editor-mount .cm-content";

test.describe("playground Reset button", () => {
  test("discards local edits and reloads bundled defaults", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(process.env.CVM_BASE_URL ?? "/");

    // The cvm-pg-reset button + cvm-pg-toolbar-note caption are both
    // emitted by editor.ts. Assert they're attached so a regression
    // that drops the markup fails fast.
    const resetBtn = page.locator("#cvm-pg-reset");
    const note = page.locator(".cvm-pg-toolbar-note");
    await expect(resetBtn).toBeAttached();
    await expect(note).toBeAttached();
    await expect(note).toContainText(/Reset/i);

    // Auto-accept the confirm() dialog Reset prompts before destroying
    // edits — that's the contract — so the test acknowledges and proceeds.
    page.on("dialog", (d) => { void d.accept(); });

    // Type a marker into the editor.
    await page.click(EDITOR_TEXT_SELECTOR);
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n/* CVM_RESET_REGRESSION_MARKER */");
    await page.waitForTimeout(300);

    // Confirm the marker is now visible — otherwise the type sequence
    // never reached the editor and Reset would no-op trivially.
    const dirtyHasMarker = await page.evaluate(
      (sel) => (document.querySelector(sel)?.textContent ?? "").includes("CVM_RESET_REGRESSION_MARKER"),
      EDITOR_TEXT_SELECTOR,
    );
    expect(dirtyHasMarker).toBe(true);

    // Click Reset → confirm auto-accepts → wait for the status line to
    // settle into "reset to bundled defaults".
    await resetBtn.click();
    await page.waitForFunction(
      () => /reset to bundled defaults/i.test(
        document.querySelector("#cvm-pg-status")?.textContent ?? "",
      ),
      null,
      { timeout: 20_000 },
    );

    // The marker must be gone after Reset. If CodeMirror has scrolled
    // such that the original last line is off-screen, the marker would
    // also be off-screen — but our type sequence placed it at the end,
    // which is where CodeMirror keeps the active viewport after a
    // dispatch. Any remaining marker in the visible window means Reset
    // did not actually clear IDB.
    const afterHasMarker = await page.evaluate(
      (sel) => (document.querySelector(sel)?.textContent ?? "").includes("CVM_RESET_REGRESSION_MARKER"),
      EDITOR_TEXT_SELECTOR,
    );
    expect(afterHasMarker).toBe(false);

    // Active file tab should not show the dirty dot.
    const activeTab = page.locator(".cvm-files__tab.cvm-files__tab--active");
    if (await activeTab.count()) {
      await expect(activeTab).not.toHaveClass(/cvm-files__tab--dirty/);
    }
  });
});
