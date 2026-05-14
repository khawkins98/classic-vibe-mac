import { defineConfig, devices } from "@playwright/test";

/**
 * Separate Playwright config for the `tools/test-demo.sh` debug-loop
 * tool (issue #71).  Differs from the main `playwright.config.ts` in
 * two ways:
 *
 *   1. **No `webServer`** — the driver script is responsible for
 *      whatever server is being tested against (vite preview locally,
 *      or just the deployed Pages URL with no local server at all).
 *      The main config's auto-launched `npm run dev` would conflict
 *      with the driver's own server, and is unwanted overhead when
 *      pointing at Pages.
 *
 *   2. **`baseURL` read from `BASE_URL` env var.** Defaults to the
 *      deployed Pages URL — the most common case for "I just want to
 *      see what the live binary does" — but the driver script
 *      overrides it for preview mode.
 *
 *   3. `testMatch` is narrowed to just the boot-test spec so a stray
 *      `npx playwright test --config=…` won't sweep up unrelated
 *      e2e tests.
 *
 *   4. No retries.  This is a debug tool, not a CI gate — a flaky
 *      pass would be misleading.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["prebuilt-demo-boot.spec.ts"],
  fullyParallel: false,
  forbidOnly: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.BASE_URL ?? "https://khawkins98.github.io/classic-vibe-mac/",
    trace: "off",
    screenshot: "off", // we take our own
    video: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "test-results-test-demo",
});
