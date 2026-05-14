/**
 * Prebuilt demo boot-tester (issue #71).
 *
 * Drives one demo through the playground UI from cold start to a
 * post-boot screenshot.  Used as a debug-loop tool, not a regression
 * suite — failure here is expected when a vendored binary is broken
 * (which it currently is — see tracker #64).  The test ALWAYS PASSES
 * if it reaches the screenshot step; the artefact itself carries the
 * signal.  An AI agent or a human can read the captured image and
 * decide what happened (crash dialog / blank desktop / rendered text).
 *
 * Configuration via env vars:
 *   DEMO_ID    — required.  One of the PrebuiltDemo `id` values:
 *                "hello-toolbox" | "hello-bare" | "hello-initgraf".
 *   BOOT_WAIT  — optional.  Seconds to wait after click before screenshot.
 *                Default 30.  Long enough for BasiliskII to boot on a
 *                cold cache, the disk to hot-load, and the app to launch
 *                (or crash visibly).
 *   OUT_DIR    — optional.  Directory for screenshot + result.json.
 *                Default `tests/e2e/screenshots/`.
 *
 * Outputs (under OUT_DIR):
 *   <DEMO_ID>-<ISO timestamp>.png  — canvas screenshot
 *   <DEMO_ID>-<ISO timestamp>.json — { demoId, sha256, lastModified,
 *                                       consoleLogs, durationMs }
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_ID = process.env.DEMO_ID;
const BOOT_WAIT_S = Number(process.env.BOOT_WAIT ?? 45);
const OUT_DIR = process.env.OUT_DIR ?? "tests/e2e/screenshots";

if (!DEMO_ID) {
  throw new Error("DEMO_ID env var required (e.g. hello-toolbox)");
}

// Generous overall timeout — emulator boot is genuinely slow.
test.setTimeout(120_000);

test(`boot ${DEMO_ID}`, async ({ page }) => {
  mkdirSync(OUT_DIR, { recursive: true });

  // Capture every console message (including [prebuilt-demo] line that
  // PR #66 emits, and [emulator]/[basilisk]/[worker] traces).
  const consoleLogs: { type: string; text: string; ts: number }[] = [];
  const start = Date.now();
  page.on("console", (msg) => {
    consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      ts: Date.now() - start,
    });
  });
  page.on("pageerror", (err) => {
    consoleLogs.push({
      type: "pageerror",
      text: err.message,
      ts: Date.now() - start,
    });
  });

  // Always-on artefact paths — we write these even if the assertions
  // below fail, so the human/agent reading the result has a screenshot
  // and a JSON either way.
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const pngPath = join(OUT_DIR, `${DEMO_ID}-${iso}.png`);
  const jsonPath = join(OUT_DIR, `${DEMO_ID}-${iso}.json`);

  // Helper: write current state to disk.  Called in a finally so partial
  // failures still produce a useful artefact.
  const writeArtefacts = async (stage: string, err?: unknown) => {
    try {
      await page.screenshot({ path: pngPath, fullPage: false });
    } catch {
      // ignore — sometimes the page closed before screenshot
    }
    const demoLogLine = consoleLogs.find((l) =>
      l.text.includes("[prebuilt-demo]"),
    );
    const shaMatch = demoLogLine?.text.match(/sha256=([0-9a-f]+)/);
    const summary = {
      demoId: DEMO_ID,
      bootWaitSeconds: BOOT_WAIT_S,
      durationMs: Date.now() - start,
      stage,
      error: err
        ? err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err)
        : null,
      sha256Prefix: shaMatch?.[1] ?? null,
      prebuiltDemoConsoleLine: demoLogLine?.text ?? null,
      screenshotPath: pngPath,
      consoleLogCount: consoleLogs.length,
      consoleLogs,
    };
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  };

  try {
    // NB: don't pass `/` — when the baseURL includes a path segment
    // (e.g. https://khawkins98.github.io/classic-vibe-mac/), Playwright
    // resolves `/` against the host, dropping the path.  Pass the full
    // URL or empty string to inherit baseURL verbatim.
    const targetUrl =
      process.env.BASE_URL ?? "https://khawkins98.github.io/classic-vibe-mac/";
    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Debug: dump what Playwright sees right after navigation.
    const titleSeen = await page.title().catch(() => "(no title)");
    const bodyText = await page
      .locator("body")
      .textContent()
      .catch(() => "(no body)");
    consoleLogs.push({
      type: "harness",
      text: `post-goto: title='${titleSeen}'  body.len=${(bodyText ?? "").length}`,
      ts: Date.now() - start,
    });

    // Wait for the playground to mount.  Be generous; the bundle pulls
    // CodeMirror and a chunk of WASM.  Note that the COOP/COEP service
    // worker auto-reloads the page on first install — page.goto returns
    // before the SW is active, then the SW reloads to enable
    // SharedArrayBuffer.  Waiting for #cvm-playground naturally handles
    // this because the locator re-evaluates after the reload.
    await expect(page.locator("#cvm-playground")).toBeAttached({
      timeout: 30_000,
    });

    // Show editor toggle — defaults ON, but be defensive.
    const showEditor = page.locator("#cvm-show-editor");
    if (await showEditor.count()) {
      if (!(await showEditor.isChecked())) {
        await showEditor.check();
      }
    }

    // Wait for the emulator to finish booting BEFORE clicking the demo.
    // Boot signals we can detect from outside the canvas:
    //   [emulator] first frame painted   (~2s post-load)
    //   chunks loading                    (over 5-30s)
    //   [emulator] status: prefetching Apps  (when ready for hot-load)
    // We watch for a stable "no new emulator log lines for 3s" signal as
    // a proxy for "boot quiesced" — the disk has finished loading and
    // the Mac is sitting at the Finder desktop ready to accept input.
    const bootReady = (async () => {
      let lastEmulatorTs = Date.now();
      const onMsg = (msg: { text: () => string }) => {
        const t = msg.text();
        if (
          t.includes("[emulator]") ||
          t.includes("[basilisk]") ||
          t.includes("[worker]") ||
          t.includes("chunk ")
        ) {
          lastEmulatorTs = Date.now();
        }
      };
      page.on("console", onMsg);
      // Poll until emulator has been silent for 3 seconds OR 45s total.
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline) {
        const silentFor = Date.now() - lastEmulatorTs;
        if (silentFor > 3_000) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      page.off("console", onMsg);
    })();
    await bootReady;
    consoleLogs.push({
      type: "harness",
      text: `boot quiesced; clicking demo now`,
      ts: Date.now() - start,
    });

    // Demo button locator.
    const demoBtn = page.locator(
      `button.cvm-pg-demo-load[data-demo-id="${DEMO_ID}"]`,
    );
    await demoBtn.scrollIntoViewIfNeeded({ timeout: 15_000 });
    await expect(demoBtn).toBeVisible({ timeout: 15_000 });

    const buttonLabel = (await demoBtn.textContent()) ?? "(no label)";
    consoleLogs.push({
      type: "harness",
      text: `clicking demo button: ${buttonLabel.trim()}`,
      ts: Date.now() - start,
    });
    // Track the emulator reboot.  hotLoad destroys the running BasiliskII
    // and starts a fresh one against the patched disk; the new emulator's
    // startup is marked by a second "[worker] BasiliskIIPrefs:" log line.
    // We wait for that signal before grabbing the canvas locator, so we
    // hit the NEW (live) canvas rather than the stale post-reboot one.
    let rebootSeenAtMs = -1;
    let prefsCount = 0;
    const onReboot = (msg: { text: () => string }) => {
      if (msg.text().includes("[worker] BasiliskIIPrefs")) {
        prefsCount += 1;
        if (prefsCount >= 2) rebootSeenAtMs = Date.now() - start;
      }
    };
    page.on("console", onReboot);

    await demoBtn.click();

    // Wait up to 30s for the reboot signal.
    const rebootDeadline = Date.now() + 30_000;
    while (Date.now() < rebootDeadline && rebootSeenAtMs < 0) {
      await page.waitForTimeout(500);
    }
    page.off("console", onReboot);

    if (rebootSeenAtMs < 0) {
      consoleLogs.push({
        type: "harness",
        text: "WARN: reboot signal not seen within 30s post-click",
        ts: Date.now() - start,
      });
    } else {
      consoleLogs.push({
        type: "harness",
        text: `reboot signal seen at ${rebootSeenAtMs}ms`,
        ts: Date.now() - start,
      });
    }

    // After reboot signal, wait for the new emulator to finish booting
    // System 7.5.5 from the patched disk.  Use the same "console silence
    // for 3s" heuristic — but ONLY counting [emulator]/[basilisk]/chunk
    // messages so unrelated logs don't reset the timer.
    let lastEmTs = Date.now();
    const onEm = (msg: { text: () => string }) => {
      const t = msg.text();
      if (
        t.includes("[emulator]") ||
        t.includes("[basilisk]") ||
        t.includes("chunk ")
      ) {
        lastEmTs = Date.now();
      }
    };
    page.on("console", onEm);
    const newBootDeadline = Date.now() + (BOOT_WAIT_S - 10) * 1000;
    while (Date.now() < newBootDeadline) {
      if (Date.now() - lastEmTs > 3_000) break;
      await page.waitForTimeout(500);
    }
    page.off("console", onEm);
    consoleLogs.push({
      type: "harness",
      text: `new emulator quiesced; attempting canvas double-click`,
      ts: Date.now() - start,
    });

    // NOW grab the canvas locator — the new one created by the reboot.
    // Programmatic double-click on the emulator canvas.  Coordinates
    // chosen empirically from user-supplied screenshots showing the
    // hello_toolbox app icon in the auto-opened Apps window at roughly
    // (130, 270) of the visible canvas.
    try {
      // Re-evaluate the locator AFTER reboot — old canvas is detached.
      const canvas = page.locator("#emulator-canvas-mount canvas").first();
      const box = await canvas.boundingBox();
      if (box) {
        const x = box.x + box.width * (130 / 512);
        const y = box.y + box.height * (270 / 342);
        consoleLogs.push({
          type: "harness",
          text: `double-clicking canvas at (${x.toFixed(0)}, ${y.toFixed(0)})`,
          ts: Date.now() - start,
        });
        await page.mouse.move(x, y);
        await page.mouse.click(x, y);
        await page.waitForTimeout(150);
        await page.mouse.click(x, y);
      } else {
        consoleLogs.push({
          type: "harness",
          text: "no canvas bounding box found — skipping double-click",
          ts: Date.now() - start,
        });
      }
    } catch (clickErr) {
      consoleLogs.push({
        type: "harness",
        text: `canvas double-click failed: ${String(clickErr)}`,
        ts: Date.now() - start,
      });
    }

    // Final settle wait for the app to launch / crash dialog to draw.
    await page.waitForTimeout(10_000);

    // Capture an extra 5s of quiesce — catches the case where the app
    // crashed late and the system error dialog is still being drawn.
    let lastConsoleAt = Date.now();
    const onLate = () => {
      lastConsoleAt = Date.now();
    };
    page.on("console", onLate);
    const quiesceDeadline = Date.now() + 8_000;
    while (Date.now() < quiesceDeadline) {
      if (Date.now() - lastConsoleAt > 3_000) break;
      await page.waitForTimeout(500);
    }
    page.off("console", onLate);

    await writeArtefacts("post-boot-wait");
  } catch (err) {
    await writeArtefacts("error", err);
    throw err;
  }

  console.log(`\n=== prebuilt-demo boot result ===`);
  const demoLogLine = consoleLogs.find((l) =>
    l.text.includes("[prebuilt-demo]"),
  );
  console.log(`demoId: ${DEMO_ID}`);
  console.log(`prebuilt-demo log: ${demoLogLine?.text ?? "(not seen)"}`);
  console.log(`screenshot: ${pngPath}`);
  console.log(`result json: ${jsonPath}`);
  console.log(`total console entries: ${consoleLogs.length}`);
});
