#!/usr/bin/env node
// Select wasm-arkanoid, click Build & Run, wait for the Mac to reboot
// and the app to launch, then screenshot.
import { chromium } from "playwright";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto("http://localhost:5173/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

// Pick wasm-arkanoid from the picker.
try {
  await page.locator("#cvm-files-project").selectOption("wasm-arkanoid");
  await page.waitForTimeout(600);
} catch {}

// Click Build & Run.
await page.locator("#cvm-pg-buildrun").click();

// Wait for status to settle on Done. Generous since cold boot.
const status = page.locator("#cvm-pg-status");
for (let i = 0; i < 60; i++) {
  const txt = await status.textContent();
  if (txt && /Done in \d+/.test(txt)) break;
  await page.waitForTimeout(500);
}

// Wait for boot to settle.
await page.waitForTimeout(15_000);

// Dismiss the explainer modal if it's there.
try {
  await page.locator(".cvm-explainer-winbox .wb-close").click({ timeout: 1500 });
  await page.waitForTimeout(400);
} catch {}

const mac = page.locator(".cvm-pane-mac");
if (await mac.count()) {
  await mac.first().screenshot({ path: "/tmp/arkanoid-shot.png" });
}
console.log("done");
await browser.close();
