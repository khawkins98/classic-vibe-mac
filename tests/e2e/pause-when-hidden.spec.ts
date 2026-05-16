import { test, expect } from "@playwright/test";

/**
 * Sleep-when-hidden behavior test.
 *
 * What we verify, end-to-end (no Atomics introspection — that's the worker's
 * private business, see emulator-worker.ts):
 *   1. The settings checkbox renders and reflects the default (ON).
 *   2. Toggling visibility to "hidden" with the setting ON flips the body
 *      class to `cvm-paused` and surfaces the visible "💤 Paused" caption.
 *   3. Toggling back to "visible" clears both.
 *   4. With the setting OFF, a visibility flip does NOT pause.
 *
 * Why we drive visibility manually rather than minimising the browser:
 * Playwright doesn't expose a "minimise window" primitive that reliably
 * fires `visibilitychange` cross-platform. Patching `document.visibilityState`
 * + dispatching the event matches the browser's contract for our handler
 * (it reads `document.visibilityState`, that's it). The Atomics.wait inside
 * the worker is exercised in dev manually (Activity Monitor) — the loader
 * IS observably calling Atomics.store(pauseFlag, 0, 1) once we see the
 * cvm-paused class.
 *
 * Boot dependencies: the emulator may or may not be booted by the time we
 * check (depends on CI disk-image availability). The visibility handler is
 * armed only AFTER `emulator_ready` — so we skip the test cleanly if the
 * loader didn't reach the running phase. The chrome and the checkbox work
 * regardless of whether the emulator booted.
 */

const FORCE_VISIBILITY = (state: "visible" | "hidden") => {
  // Patch visibilityState + the matching `hidden` boolean, then dispatch
  // visibilitychange. document.hidden is just a `!== "visible"` mirror.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => state === "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

test.describe("sleep-when-hidden", () => {
  test("settings checkbox is on by default and persists", async ({ page }) => {
    await page.goto("/");

    // The "pause when tab is hidden" toggle moved from the main chrome
    // into the Preferences palette (Edit menu → Preferences…). Open the
    // palette first via the module's exported entry-point — same dev-only
    // dynamic-import trick the compileToBin tests use.
    await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ `${location.origin}/src/preferencesPalette.ts`
      );
      mod.openPreferences();
    });

    const cb = page.locator("#cvm-prefs-pause");
    await expect(cb).toBeAttached();
    await expect(cb).toBeChecked();

    await cb.uncheck({ force: true });
    const stored = await page.evaluate(() =>
      localStorage.getItem("cvm.pauseWhenHidden"),
    );
    expect(stored).toBe("false");

    await cb.check({ force: true });
    const stored2 = await page.evaluate(() =>
      localStorage.getItem("cvm.pauseWhenHidden"),
    );
    expect(stored2).toBe("true");
  });

  test("hiding the page sets paused state when setting is ON", async ({ page }) => {
    await page.goto("/");

    // Make sure the setting is ON (the default, but be explicit so the
    // test is independent of test-ordering / test-isolation quirks).
    await page.evaluate(() => {
      localStorage.setItem("cvm.pauseWhenHidden", "true");
    });
    await page.reload();

    // Wait for the loader to either start the emulator OR drop into stub.
    // The visibility handler is only armed after emulator_ready; in stub
    // mode (no SAB / no boot disk), we still want the checkbox to work
    // but the body class will never flip. We detect which branch we're in.
    const phase = await page.evaluate(async () => {
      // Give the loader a beat to reach a terminal state. We don't have a
      // hook for "done", so just poll for either the canvas or the stub.
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        const canvas = document.querySelector("#emulator-canvas");
        const stub = document.querySelector(".loader--stub");
        const error = document.querySelector(".loader--error");
        if (canvas || stub || error) {
          return canvas ? "canvas" : stub ? "stub" : "error";
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return "timeout";
    });

    if (phase !== "canvas") {
      test.skip(
        true,
        `emulator did not reach running phase (got ${phase}); pause-state can only be verified once armed`,
      );
      return;
    }

    // Hide the page — should pause.
    await page.evaluate(FORCE_VISIBILITY, "hidden");
    await expect(page.locator("body")).toHaveClass(/cvm-paused/);
    await expect(page.locator("#cvm-pause-status")).toContainText("Paused");

    // Reveal — should unpause.
    await page.evaluate(FORCE_VISIBILITY, "visible");
    await expect(page.locator("body")).not.toHaveClass(/cvm-paused/);
    await expect(page.locator("#cvm-pause-status")).toHaveText("");
  });

  test("hiding the page does NOT pause when setting is OFF", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("cvm.pauseWhenHidden", "false");
    });
    await page.reload();

    // Same phase-gate as above.
    const phase = await page.evaluate(async () => {
      const start = Date.now();
      while (Date.now() - start < 30_000) {
        if (document.querySelector("#emulator-canvas")) return "canvas";
        if (document.querySelector(".loader--stub")) return "stub";
        if (document.querySelector(".loader--error")) return "error";
        await new Promise((r) => setTimeout(r, 250));
      }
      return "timeout";
    });
    if (phase !== "canvas") {
      test.skip(true, `emulator did not reach running phase (got ${phase})`);
      return;
    }

    await page.evaluate(FORCE_VISIBILITY, "hidden");
    // Body class should NOT flip even though we went hidden — setting is OFF.
    await page.waitForTimeout(200);
    await expect(page.locator("body")).not.toHaveClass(/cvm-paused/);

    await page.evaluate(FORCE_VISIBILITY, "visible");
  });
});
