#!/usr/bin/env node
// Capture the Mac canvas just after the System 7.5.5 boot finishes,
// so we can see which windows the Finder auto-opened.
// Used to verify cv-mac #245's window-suppression patching.
import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
// Wait long enough for the boot to finish — the chunked disk download
// + System 7 boot is ~30-50s cold.
await page.waitForTimeout(55_000);

// Dismiss any popovers
try {
  await page.locator(".cvm-explainer-winbox .wb-close").click({ timeout: 1500 });
  await page.waitForTimeout(400);
} catch {}

const mac = page.locator(".cvm-pane-mac");
if (await mac.count()) {
  await mac.first().screenshot({ path: "/tmp/cvm-postboot.png" });
}

console.log("done");
await browser.close();
