import { test, expect } from "@playwright/test";

/**
 * Smoke test for the web frontend.
 *
 * Today src/web is a placeholder page that just renders some text describing
 * where BasiliskII will eventually live. This test asserts the page loads,
 * the placeholder text shows up, and we can capture a screenshot.
 *
 * When the real emulator lands, this test should grow to:
 *   - wait for the BasiliskII canvas to mount
 *   - wait for the System 7.5.5 boot to finish (a vision check is the right
 *     tool for that — see tests/visual/)
 *   - exercise basic interactions (click into the canvas, verify focus)
 */
test("placeholder page renders", async ({ page }) => {
  await page.goto("/");

  // The current placeholder explicitly says "TODO: BasiliskII goes here."
  await expect(page.locator("h1")).toHaveText("classic-mac-builder");
  await expect(page.getByText("TODO: BasiliskII goes here.")).toBeVisible();

  // Capture a screenshot so the visual layer (and humans) can sanity-check.
  // Saved into test-results/ rather than as a snapshot — we are NOT doing
  // pixel-diff baselines here. See tests/README.md for rationale.
  await page.screenshot({
    path: "test-results/placeholder.png",
    fullPage: true,
  });
});
