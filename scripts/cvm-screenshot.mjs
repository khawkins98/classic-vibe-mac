#!/usr/bin/env node
// One-shot Playwright screenshot of cv-mac dev server for the Platinum
// accuracy iteration loop (#229). Captures the full page + a tight
// crop of the Files-pane project picker so I can verify the popup
// arrow-box (#234) actually rendered.
import { chromium } from "playwright";

const url = process.env.URL ?? "http://localhost:5173/";
const out = process.env.OUT ?? "/tmp/cvm-shot.png";

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "domcontentloaded" });
// Give WinBox + chrome a beat to settle.
await page.waitForTimeout(800);
await page.screenshot({ path: out, fullPage: false });

// Also capture a crop of the Files pane (left side) where the project
// picker lives — that's the surface the user's screenshot showed
// looking wrong.
const filesPane = page.locator(".cvm-pane-files");
if ((await filesPane.count()) > 0) {
  await filesPane.first().screenshot({ path: out.replace(".png", "-files.png") });
}

// And a crop of the playground toolbar.
const toolbar = page.locator(".cvm-pg-toolbar--icons");
if ((await toolbar.count()) > 0) {
  await toolbar.first().screenshot({ path: out.replace(".png", "-toolbar.png") });
}

console.log(`saved ${out} (+ files/toolbar crops)`);
await browser.close();
