#!/usr/bin/env node
// Build & Run wasm-glypha3 and screenshot the result.
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
  await page.locator("#cvm-files-project").selectOption("wasm-glypha3");
  await page.waitForTimeout(600);
} catch {}

await page.locator("#cvm-pg-buildrun").click();

const status = page.locator("#cvm-pg-status");
let finalStatus = "";
for (let i = 0; i < 120; i++) {
  finalStatus = (await status.textContent()) ?? "";
  if (/Done in \d+/.test(finalStatus)) break;
  if (/err|fail|cc1|ld:/i.test(finalStatus)) break;
  await page.waitForTimeout(500);
}
console.log(`status: ${finalStatus}`);

// Wait for boot
await page.waitForTimeout(20_000);

try {
  await page.locator(".cvm-explainer-winbox .wb-close").click({ timeout: 1500 });
  await page.waitForTimeout(400);
} catch {}

const mac = page.locator(".cvm-pane-mac");
if (await mac.count()) {
  await mac.first().screenshot({ path: "/tmp/glypha-shot.png" });
}
console.log("done");
await browser.close();
