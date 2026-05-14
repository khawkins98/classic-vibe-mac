import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for classic-vibe-mac.
 *
 * The dev server is the Vite app under src/web (workspace), launched via
 * `npm run dev` at the repo root which proxies to `vite` on port 5173.
 * Playwright will boot that server before tests and tear it down after.
 *
 * We deliberately keep this minimal — chromium only — for two reasons:
 *  1. The emulator (BasiliskII WASM) requires SharedArrayBuffer + COOP/COEP,
 *     which behaves most consistently in chromium for our use case.
 *  2. Cross-browser parity isn't a POC concern.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // Exclude the debug-loop boot-tester spec (issue #71).  It's run via
  // tools/test-demo.sh with its own dedicated config (playwright.test-demo.config.ts),
  // not as part of the regular e2e suite.  Picking it up here fails
  // because the spec requires a DEMO_ID env var that the regular suite
  // doesn't set.
  testIgnore: ["prebuilt-demo-boot.spec.ts"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
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
    stdout: "pipe",
    stderr: "pipe",
  },
  outputDir: "test-results",
});
