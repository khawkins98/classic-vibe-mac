/*
 * One-off screenshot capture for the deployed hello-world bisection.
 * Visits the live GH Pages URL, waits long enough for the COOP/COEP
 * service worker reload + emulator boot, then writes a PNG.
 *
 * Run from repo root: node scripts/capture-helloworld-screenshot.mjs
 *
 * Not part of the test suite — just an investigation helper. Safe to
 * delete once the bomb is localised.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TARGET_URL = "https://khawkins98.github.io/classic-vibe-mac/";
const OUT = new URL("../public/screenshot-helloworld.png", import.meta.url)
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

// coi-serviceworker installs on first navigation, then reloads.
// The reload re-runs the page in a cross-origin-isolated context.
// Give it a long lead time: SW install + reload + WASM fetch + ROM
// fetch + boot disk chunks + System 7 boot + Finder + Startup Items
// + (hoped-for) "It works." paint or any bomb.
console.log("Waiting 8s for COI service worker to install + reload...");
await page.waitForTimeout(8_000);
console.log("Waiting for network to settle...");
try {
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
} catch (e) {
    console.log("networkidle timeout (expected — emulator keeps fetching):", e.message);
}
console.log("Waiting another 25s for boot to settle...");
await page.waitForTimeout(25_000);

console.log("Capturing screenshot to", OUT);
await page.screenshot({ path: OUT, fullPage: true });

await browser.close();
console.log("Done.");
