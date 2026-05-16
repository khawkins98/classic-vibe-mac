#!/usr/bin/env node
// Select wasm-icon-gallery, click Build & Run, wait for boot+launch,
// then double-click the Wasm Icon Gallery floppy + the app to launch
// it, then screenshot the gallery window.
import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

try {
  await page.locator("#cvm-files-project").selectOption("wasm-icon-gallery");
  await page.waitForTimeout(600);
} catch {}

await page.locator("#cvm-pg-buildrun").click();

// Wait for "Done in N ms" status
const status = page.locator("#cvm-pg-status");
let finalStatus = "";
for (let i = 0; i < 60; i++) {
  finalStatus = (await status.textContent()) ?? "";
  if (/Done in \d+/.test(finalStatus)) break;
  if (/err|fail|cc1|ld:/i.test(finalStatus)) break;
  await page.waitForTimeout(500);
}
console.log(`final status: ${finalStatus}`);

// Wait for Mac to reboot + Finder to come up
await page.waitForTimeout(20_000);

// Dismiss the explainer modal if it's there
try {
  await page.locator(".cvm-explainer-winbox .wb-close").click({ timeout: 1500 });
  await page.waitForTimeout(400);
} catch {}

const mac = page.locator(".cvm-pane-mac");
if (await mac.count()) {
  await mac.first().screenshot({ path: "/tmp/cvm-gallery-shot.png" });
}
console.log("done");
await browser.close();
