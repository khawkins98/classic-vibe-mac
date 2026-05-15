import { test, expect } from "@playwright/test";

/**
 * Show Assembly (cv-mac #64 / wasm-retro-cc #17).
 *
 * The compiler is real cc1.wasm running in the browser — we let it boot
 * once (~3.4 MB brotli download + warm-up), then assert that compiling a
 * known .c file produces m68k assembly we recognise.
 *
 * Generous timeouts because:
 *   - First compile pays for the cc1.wasm fetch + Emscripten module
 *     instantiation + sysroot unpacking into MEMFS (~1-3 s cold).
 *   - Subsequent edits are debounced 500 ms then near-instant.
 */

test("playground exposes a Show Assembly panel", async ({ page }) => {
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();
  const panel = page.locator("#cvm-pg-asm-panel");
  await expect(panel).toBeAttached();
  await expect(panel.locator("summary").first()).toContainText(
    /Show Assembly/i,
  );
});

test("Show Assembly compiles a .c file to m68k", async ({ page }) => {
  test.setTimeout(45_000); // first-load cold path includes the wasm fetch
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();

  // Switch to a .c file. The default-open tab is reader.r, so we click
  // the reader.c tab in the tab bar.
  const cTab = page.locator("#cvm-pg-tabbar [role='tab'][data-file$='.c']").first();
  await cTab.click();

  // Open the panel — the toggle fires lazy load.
  const panel = page.locator("#cvm-pg-asm-panel");
  await panel.locator("summary").first().click();
  await expect(panel).toHaveAttribute("open", "");

  // Wait for the status row to settle on an "ok" result.
  const status = page.locator("#cvm-pg-asm-status");
  await expect(status).toHaveAttribute("data-kind", "ok", { timeout: 30_000 });

  // Spot-check the asm viewer contains a recognizable m68k instruction.
  // CodeMirror renders content as a series of .cm-line spans; we just
  // pull the textContent of the mount and grep.
  const asmText = await page.locator("#cvm-pg-asm-mount").textContent();
  expect(asmText ?? "").toMatch(/\blink\.w\b|\bmove\.l\b|\bjsr\b|\brts\b/);
});
