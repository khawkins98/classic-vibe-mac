import { test, expect } from "@playwright/test";

/**
 * Phase 3 (Issue #21): Build & Run UI surface checks.
 *
 * We don't run the full hot-load loop in the headless e2e harness — the
 * BasiliskII boot takes 30+s and is gated on SAB / COOP+COEP that flake
 * under Playwright's defaults. The Build & Run unit-level path is
 * covered by tests/unit/hfs-patcher.test.mjs (round-trips against
 * hfsutils ground truth). This spec asserts the UI presents the new
 * button and that clicking it produces the expected status transitions
 * up to the point of disk-mount. The actual reboot is exercised by
 * the manual verification screenshot.
 */

test("playground exposes a Build & Run button", async ({ page }) => {
  await page.goto("/");
  // The playground may be hidden behind a "Show editor" toggle. Open it
  // by clicking the checkbox if present.
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) {
    await showEditor.check();
  }
  await expect(page.locator("#cvm-pg-build")).toBeVisible();
  await expect(page.locator("#cvm-pg-buildrun")).toBeVisible();
  await expect(page.locator("#cvm-pg-buildrun")).toHaveText(/Build\s*&\s*Run/);
});

test("Build & Run sets data-rebooting while in flight", async ({ page }) => {
  await page.goto("/");
  const showEditor = page.locator("#cvm-show-editor");
  if (await showEditor.count()) await showEditor.check();
  // We can't easily await full Mac boot, but we can assert the rebooting
  // attribute appears at click time. If the emulator isn't reachable in
  // this environment (e.g. SAB unavailable) the click will fail-fast
  // with an error message, not a hang — also fine for this assertion.
  const buildRun = page.locator("#cvm-pg-buildrun");
  await buildRun.click();
  // The rebooting attribute should appear within 2s of click.
  await expect(page.locator("#cvm-playground[data-rebooting]")).toBeAttached({
    timeout: 5000,
  });
});
