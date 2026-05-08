/*
 * Phase 2 verification screenshot. Loads the playground, scrolls to the
 * editor, clicks Build, waits for the status line to flip from
 * "Compiling…" to "Built …" or an error, then snapshots. The download
 * itself is intercepted (we don't actually want to write the .bin to
 * disk every CI run); we just record that one was offered.
 *
 * Run after `npx vite dev --port 5193` from src/web. Saves the PNG to
 * public/screenshot-playground-phase2.png as required by Issue #30.
 *
 * Not part of the test suite — invocation is manual.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TARGET_URL = process.env.PG2_URL ?? "http://localhost:5193/";
const OUT = new URL("../public/screenshot-playground-phase2.png", import.meta.url)
  .pathname;

mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
  acceptDownloads: true,
});
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() === "error") console.log(`[page:err] ${msg.text()}`);
});

await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

// Make sure the editor section is visible. The settings checkbox can
// hide it by default; force it on through the same setter the chrome
// uses so this script also works on a stock-default config.
await page.evaluate(() => {
  // Set the local-storage flag the chrome reads at boot.
  try {
    localStorage.setItem("cvm:show-editor", "true");
  } catch {
    /* ignore */
  }
});
await page.reload({ waitUntil: "domcontentloaded" });

// Wait for the playground build button to be present.
const buildBtn = await page.locator("#cvm-pg-build");
await buildBtn.waitFor({ state: "visible", timeout: 10_000 });

// Scroll to the playground.
await page.locator("#cvm-pg-editor-mount").scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

// Set up download interception BEFORE clicking.
const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });

await buildBtn.click();

// Wait for status to flip out of "Compiling…".
const status = page.locator("#cvm-pg-status");
await page.waitForFunction(
  () => {
    const el = document.querySelector("#cvm-pg-status");
    if (!el) return false;
    const t = (el.textContent ?? "").toLowerCase();
    return t.includes("built") || t.includes("error") || t.includes("failed");
  },
  null,
  { timeout: 30_000 },
);

let download;
try {
  download = await downloadPromise;
  console.log(
    `download offered: ${download.suggestedFilename()} (intercepted)`,
  );
} catch {
  console.log("no download offered — Build likely failed; capturing anyway.");
}

const statusText = await status.textContent();
console.log(`status: ${statusText}`);

// Frame the playground in the screenshot.
await page.locator("#cvm-pg-editor-mount").scrollIntoViewIfNeeded();
await page.waitForTimeout(200);

await page.screenshot({ path: OUT, fullPage: false });
console.log(`saved ${OUT}`);

await browser.close();
