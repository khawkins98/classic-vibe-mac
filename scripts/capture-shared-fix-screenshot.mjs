/*
 * One-off screenshot capture for the shared-folder fix verification.
 * Visits the local dev server, waits for the BasiliskII boot + Reader
 * launch from Startup Items, then writes a PNG.
 *
 * Run from repo root after `npm run dev` is up:
 *   node scripts/capture-shared-fix-screenshot.mjs
 *
 * Not part of the test suite — just an investigation helper. Safe to
 * delete once the fix has landed and the screenshot is committed.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TARGET_URL = process.env.CVM_URL ?? "http://localhost:5173/";
const OUT = new URL("../public/screenshot-shared-fix.png", import.meta.url)
    .pathname;

mkdirSync(dirname(OUT), { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

page.on("console", (msg) => {
    console.log(`[page:${msg.type()}]`, msg.text());
});

console.log("Loading", TARGET_URL);
await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });

console.log("Waiting 12s for COI service worker to install + auto-reload...");
await page.waitForTimeout(12_000);
console.log("Forcing one extra reload to guarantee COI is active...");
await page.reload({ waitUntil: "domcontentloaded" });
console.log("Waiting for network to settle...");
try {
    await page.waitForLoadState("networkidle", { timeout: 45_000 });
} catch (e) {
    console.log("networkidle timeout (expected — emulator keeps fetching):", e.message);
}
console.log("Waiting another 45s for System 7 boot + Reader launch...");
await page.waitForTimeout(45_000);

console.log("Capturing screenshot to", OUT);
await page.screenshot({ path: OUT, fullPage: true });

await browser.close();
console.log("Done.");
