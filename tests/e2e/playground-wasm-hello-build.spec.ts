/**
 * Smoke test for the in-browser C compile-and-run wire-up (cv-mac #64).
 *
 * Drives the playground's Build & Run flow on the wasm-hello project —
 * the first sample whose Build path is `compileToBin` (cc1 → as → ld →
 * Elf2Mac) rather than the wasm-rez + splice pipeline. We don't try to
 * verify boot here (the boot-test strategy is "ship to staging, eyes on"
 * — see LEARNINGS "2026-05-15 — In-browser C compile-and-run"). We just
 * verify the click triggers the compile path and the status row reaches
 * a `loaded`/`double-click` state without surfacing a build error.
 *
 * If this spec ever fails with "Build failed" or "Build error:", the
 * regression is somewhere in cc1/as/ld/Elf2Mac chaining, not in the boot
 * logic — that's the failure mode this test catches.
 */
import { test, expect } from "@playwright/test";

test("wasm-hello build kicks off the in-browser C pipeline", async ({ page }) => {
  test.setTimeout(120_000); // cold load: cc1 + as + ld + Elf2Mac + sysroot blobs

  // Capture console for diagnostic in case the build fails — the bridge's
  // intermediate stages don't otherwise surface anywhere we can read.
  const logs: string[] = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

  await page.goto(process.env.CVM_BASE_URL ?? "/");
  await page.setViewportSize({ width: 1100, height: 800 });
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();

  // Switch to the wasm-hello project.
  await page.locator("#cvm-pg-project").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("#cvm-pg-project").selectOption("wasm-hello");
  await expect(page.locator("#cvm-pg-tabbar [role='tab'][data-file='hello.c']")).toBeVisible();

  // Click Build .bin — exercises the .c → MacBinary in-browser path
  // without paying the emulator reboot cost.
  const buildBtn = page.locator("#cvm-pg-build");
  await buildBtn.waitFor({ state: "visible" });
  await buildBtn.click();

  // Wait for the status row to settle on an OK result. The status
  // text on the .c path follows the same "Built X (size) in Yms — downloading"
  // shape as the .r splice path.
  const status = page.locator("#cvm-pg-status");
  try {
    await expect(status).toHaveAttribute("data-kind", "ok", { timeout: 90_000 });
  } catch (err) {
    // Dump console + the actual status text to make CI diagnostic-friendly.
    console.log(`[build] final status: ${await status.textContent()}`);
    console.log(`[build] data-kind: ${await status.getAttribute("data-kind")}`);
    console.log(`[build] console tail (last 30):`);
    for (const l of logs.slice(-30)) console.log(`  ${l}`);
    throw err;
  }

  const text = await status.textContent();
  // Stamped filename: WasmHello-YYYYMMDD-HHMM.bin (see withBuildTimestamp).
  expect(text ?? "").toMatch(/^Built WasmHello-\d{8}-\d{4}\.bin/);
  // Sanity: the size should be at least a MacBinary header (128 B) and
  // not the multi-MB splice payload (that path is for .r-driven projects).
  expect(text ?? "").toMatch(/\((?:\d+ B|\d+(?:\.\d+)? KB)\)/);
});
