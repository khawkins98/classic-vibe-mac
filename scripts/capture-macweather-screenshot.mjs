/*
 * One-off screenshot capture for MacWeather.
 *
 * Loads the local dev server, waits for boot + MacWeather to launch from
 * Startup Items, gives the JS weather poller time to fetch from
 * api.open-meteo.com and write :Unix:weather.json, then captures the
 * frame.
 *
 * Run from repo root after `npm run dev` is up:
 *   node scripts/capture-macweather-screenshot.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TARGET_URL = process.env.CVM_URL ?? "http://localhost:5173/";
const OUT = new URL("../public/screenshot-macweather.png", import.meta.url)
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
console.log("Waiting another 120s for System 7 boot + both apps launching from Startup Items + first weather fetch...");
await page.waitForTimeout(120_000);

console.log("Capturing screenshot to", OUT);
await page.screenshot({ path: OUT, fullPage: true });

await browser.close();
console.log("Done.");
