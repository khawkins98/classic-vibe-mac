import { defineConfig, devices } from "@playwright/test";

/**
 * Separate Playwright config for the vision test layer.
 *
 * Why split from the main playwright.config.ts?
 *   - Vision tests cost money (per-image API calls) and shouldn't run as part
 *     of the default `npm run test:e2e` loop. They get their own command.
 *   - Different testDir scope keeps `npm run test:e2e` from accidentally
 *     pulling these in.
 *
 * The webServer config mirrors the e2e one so this can run standalone.
 */
export default defineConfig({
  testDir: ".",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: "../..",
  },
  outputDir: "../../test-results-visual",
});
