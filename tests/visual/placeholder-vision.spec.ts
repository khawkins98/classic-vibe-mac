import { test, expect } from "@playwright/test";
import { visionAssert, hasVisionApiKey } from "./vision-assert";

/**
 * Example vision test against the placeholder page.
 *
 * When the real BasiliskII emulator lands, this file should grow assertions
 * like:
 *   - "a System 7 desktop is visible (menu bar at top, trash can at bottom-right)"
 *   - "a window titled 'Minesweeper' is open"
 *   - "the Minesweeper grid has 9 rows and 9 columns of cells"
 *
 * For now we just prove the wiring: load the placeholder page, screenshot it,
 * and assert something trivially true via the vision API.
 */
test.describe("vision assertions", () => {
  test.skip(
    !hasVisionApiKey(),
    "ANTHROPIC_API_KEY not set — skipping vision tests. Set the env var to run.",
  );

  test("placeholder page contains visible text", async ({ page }, testInfo) => {
    await page.goto("/");
    const screenshotPath = testInfo.outputPath("placeholder-vision.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const result = await visionAssert(
      screenshotPath,
      "the screenshot shows a webpage with visible readable text on it",
    );

    // Attach the model's reasoning so failures are debuggable from the report.
    await testInfo.attach("vision-reasoning", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    expect(result.pass, `vision check failed: ${result.reasoning}`).toBe(true);
  });
});
