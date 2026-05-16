import { test, expect } from "@playwright/test";

/**
 * Smoke test for the web frontend.
 *
 * Asserts the System 7 chrome renders and the emulator mount point exists.
 * The loader's transient state (loading / stub / canvas) varies between
 * environments, so we don't assert on its content — that's the vision
 * layer's job (see tests/visual/).
 *
 * When real boot lands in deployed Pages, this test should grow to:
 *   - wait for the BasiliskII canvas to mount
 *   - wait for the System 7.5.5 boot to finish (vision-assert is the right
 *     tool for that — see tests/visual/)
 *   - exercise basic interactions (click into the canvas, verify focus)
 */
test("landing page renders the system 7 chrome", async ({ page }) => {
  await page.goto("/");

  // The Mac-style menubar at the top renders. (#225 retired the
  // below-the-fold Read Me section that used to host an <h1> — page
  // identity now lives in the menubar's version chip + document
  // title instead.)
  await expect(page.locator(".menubar")).toBeAttached();
  await expect(page.locator("#cvm-menubar-version")).toContainText("cv-mac");

  // The Macintosh emulator window exists, and the loader's mount point is
  // present in the DOM so the worker has somewhere to land.
  await expect(page.locator("#emulator-canvas-mount")).toBeAttached();

  // Capture a screenshot so the visual layer (and humans) can sanity-check.
  // Saved into test-results/ rather than as a snapshot — we are NOT doing
  // pixel-diff baselines here. See tests/README.md for rationale.
  await page.screenshot({
    path: "test-results/placeholder.png",
    fullPage: true,
  });
});
