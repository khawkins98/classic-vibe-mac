#!/usr/bin/env node
// Drive cv-mac to "Build & Run" then screenshot the resulting Mac
// desktop so we can see the custom floppy icon.
import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

// Click Build & Run for the default project (wasm-hello)
await page.locator("#cvm-pg-buildrun").click();

// Wait for the build status to settle on "Done in Xms (...)"
const status = page.locator("#cvm-pg-status");
await status.waitFor({ timeout: 30_000 });
// Wait until the status text contains "Done"
for (let i = 0; i < 60; i++) {
  const txt = await status.textContent();
  if (txt && /Done in \d+/.test(txt)) break;
  await page.waitForTimeout(500);
}

// Wait for the Mac to reboot + boot through to Finder + show the floppy
await page.waitForTimeout(10_000);

// Dismiss the "What just happened?" first-time modal if it's there
// so the canvas isn't dimmed in the screenshot.
try {
  await page.locator(".cvm-explainer-winbox .wb-close").click({ timeout: 1500 });
  await page.waitForTimeout(400);
} catch { /* not present */ }

await page.screenshot({ path: "/tmp/cvm-buildrun-shot.png", fullPage: false });

const mac = page.locator(".cvm-pane-mac");
if (await mac.count()) {
  await mac.first().screenshot({ path: "/tmp/cvm-mac-pane.png" });
}

// Tighter crop of just the right edge of the canvas where the
// secondary-disk icon appears.
const canvas = page.locator("#emulator-canvas-mount canvas");
if (await canvas.count()) {
  const box = await canvas.boundingBox();
  if (box) {
    await page.screenshot({
      path: "/tmp/cvm-mac-rightside.png",
      clip: {
        x: box.x + box.width - 100,
        y: box.y + 30,
        width: 100,
        height: Math.min(box.height - 30, 400),
      },
    });
  }
}

console.log("done");
await browser.close();
