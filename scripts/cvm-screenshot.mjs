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

// Switch to wasm-sound (multi-file: sound.c + sound.r) so the
// tab bar has more than one tab to show. Falls back silently if
// the picker isn't present or the project isn't available.
try {
  const picker = page.locator("#cvm-files-project");
  if ((await picker.count()) > 0) {
    await picker.selectOption("wasm-sound");
    await page.waitForTimeout(400);
  }
} catch { /* fall through to single-tab capture */ }

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

// Tight crop of the tabbar + top of the editor body — the surface
// #229 item 4 (tabs merge with content panel) is targeting.
const tabbar = page.locator("#cvm-pg-tabbar");
if ((await tabbar.count()) > 0) {
  // Capture a slightly-larger region than just the tabbar so we see
  // how the active tab transitions into the editor body.
  const box = await tabbar.boundingBox();
  if (box) {
    await page.screenshot({
      path: out.replace(".png", "-tabs.png"),
      clip: { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 60 },
    });
  }
}

console.log(`saved ${out} (+ files/toolbar crops)`);
await browser.close();
