#!/usr/bin/env node
/*
 * snapshot-readme-screenshot.mjs — capture public/screenshot-deployed.png
 * (the hero image at the top of the README and the social-share OG card)
 * from the dev server.
 *
 * The screenshot needs refreshing whenever:
 *   - The IDE chrome changes (menubar additions, new toolbar buttons,
 *     titlebar tweaks, scrollbar restyles).
 *   - Visible copy changes (Playground intro paragraph, Reset caption,
 *     picker descriptions are visible in the project pane).
 *   - The picker grows new samples worth showing on the BasiliskII side.
 *
 * Usage:
 *   1. In one shell:  npm run dev
 *   2. In another:   node scripts/snapshot-readme-screenshot.mjs
 *
 * Output: public/screenshot-deployed.png at 1600x1100 @2x.
 *
 * Waits for the BasiliskII canvas to mount and Startup Items to settle
 * (20 s buffer) so the Mac pane shows running apps, not the boot
 * progress bar.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const OUT = resolve(REPO, "public/screenshot-deployed.png");

const args = process.argv.slice(2);
function flag(name, def) {
  const i = args.indexOf("--" + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const url = flag("url", "http://localhost:5173/");
const bootWaitMs = Number(flag("boot-wait-ms", "20000"));
const playwrightPath = flag(
  "playwright",
  resolve(REPO, "node_modules/playwright/index.mjs"),
);
if (!existsSync(playwrightPath)) {
  console.error(
    `Could not find Playwright at ${playwrightPath}. The npm install in ` +
      `this repo should provide it; pass --playwright /path/to/playwright/index.mjs ` +
      `to override.`,
  );
  process.exit(1);
}

const { chromium } = await import(playwrightPath);
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1100 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
console.log(`fetching ${url}…`);
await page.goto(url, { waitUntil: "domcontentloaded" });

// Wait for the BasiliskII canvas to actually mount. The element appears
// after the worker boots, which is the slow part (~10-30s on a cold
// disk cache, faster on warm).
console.log("waiting for emulator canvas…");
await page.waitForSelector("#emulator-canvas", { timeout: 90_000 });
console.log(`emulator up, waiting ${bootWaitMs}ms for Startup Items to settle…`);
await page.waitForTimeout(bootWaitMs);

await page.screenshot({ path: OUT });
await browser.close();

console.log(`wrote ${OUT}`);
