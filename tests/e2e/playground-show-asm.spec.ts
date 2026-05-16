import { test, expect } from "@playwright/test";

/**
 * Show Assembly (cv-mac #64 / wasm-retro-cc #17, palette-ified in #218
 * item 4).
 *
 * The compiler is real cc1.wasm running in the browser — we let it boot
 * once (~3.4 MB brotli download + warm-up), then assert that compiling a
 * known .c file produces m68k assembly we recognise.
 *
 * The asm viewer used to live as an inline `<details>` panel; since
 * #218 item 4 it lives in a draggable WinBox palette opened by the
 * "Show ASM" toolbar button. The internal class names
 * (.cvm-pg-asm-status, .cvm-pg-asm-mount) survived the move so the
 * compile-result assertions below are unchanged in shape — only the
 * "open the viewer" affordance changed.
 *
 * Generous timeouts because:
 *   - First compile pays for the cc1.wasm fetch + Emscripten module
 *     instantiation + sysroot unpacking into MEMFS (~1-3 s cold).
 *   - Subsequent edits are debounced 500 ms then near-instant.
 */

test("playground exposes a Show ASM toolbar button", async ({ page }) => {
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();
  const showAsmBtn = page.locator("#cvm-pg-show-asm");
  await expect(showAsmBtn).toBeAttached();
  await expect(showAsmBtn).toContainText(/Show ASM/i);
});

test("Show ASM palette compiles a .c file to m68k", async ({ page }) => {
  test.setTimeout(45_000); // first-load cold path includes the wasm fetch
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();

  // Switch to a .c file. The default-open tab varies; we click the
  // first .c tab in the tab bar so the palette has C source to compile.
  const cTab = page.locator("#cvm-pg-tabbar [role='tab'][data-file$='.c']").first();
  await cTab.click();

  // Click the toolbar button — opens the palette WinBox, kicks off
  // an immediate (non-debounced) compile.
  await page.locator("#cvm-pg-show-asm").click();

  // The palette's WinBox carries the .cvm-asm-winbox class; the body
  // contains a .cvm-pg-asm-status element managed by setAsmStatus().
  // Wait for the status row to settle on an "ok" result.
  const status = page.locator(".cvm-asm-winbox .cvm-pg-asm-status");
  await expect(status).toBeAttached();
  await expect(status).toHaveAttribute("data-kind", "ok", { timeout: 30_000 });

  // Spot-check the asm viewer contains a recognizable m68k instruction.
  // CodeMirror renders content as a series of .cm-line spans; we just
  // pull the textContent of the mount and grep.
  const asmText = await page
    .locator(".cvm-asm-winbox .cvm-pg-asm-mount")
    .textContent();
  expect(asmText ?? "").toMatch(/\blink\.w\b|\bmove\.l\b|\bjsr\b|\brts\b/);
});
