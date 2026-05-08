/*
 * One-off screenshot capture for the .html → Reader binding fix.
 *
 * Loads the local dev server, waits for boot + Reader to launch from
 * Startup Items via the oapp handler (same path as the prior shared-fix
 * screenshot — proves the new BNDL/AppleEvent code didn't break the
 * happy launch path).
 *
 * The full proof — that double-clicking inside-macintosh.html in the
 * Shared volume routes through 'odoc' to LoadDocument(spec.name) — is
 * NOT exercised by this script, because Playwright can't reliably drive
 * the emulator's mouse to land on a specific Finder icon and synthesize
 * a double-click. Verification of that path lives at the resource level
 * (hls -l ":Shared:" shows TEXT/CVMR; xxd of Reader.bin shows APPL/CVMR
 * in the MacBinary header) — see the PR description.
 *
 * Run from repo root after `npm run dev` is up:
 *   node scripts/capture-html-binding-screenshot.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TARGET_URL = process.env.CVM_URL ?? "http://localhost:5173/";
const OUT = new URL("../public/screenshot-html-binding.png", import.meta.url)
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
