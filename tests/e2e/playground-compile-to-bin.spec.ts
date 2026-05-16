/**
 * Browser-side smoke test for `compileToBin()` from `src/playground/cc1.ts`
 * (cv-mac #64, wasm-retro-cc #15 / #20).
 *
 * We can't run the bridge in Node directly — it uses `fetch` and ESM
 * dynamic import for the Emscripten module factories — so the test
 * drives it inside a real Chromium page against the Vite dev server.
 * The dev server happens to expose `src/` as ES modules, which means we
 * can `await import("/src/playground/cc1.ts")` from `page.evaluate` and
 * call `compileToBin` directly. The same import would fail in
 * production (Vite tree-shakes / bundles `src/`), so this is a
 * dev-only test — exactly like `playground-show-asm.spec.ts`.
 *
 * Done criterion: cc1 → as → ld → Elf2Mac emit a single-fork MacBinary II
 * APPL whose 128-byte header carries `type=APPL creator=????` for a
 * trivial C source. Mirrors the Node-side check the wasm-retro-cc
 * verifier runs.
 */
import { test, expect } from "@playwright/test";

const HELLO_SOURCE = `
#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>

QDGlobals qd;

int main(void) {
  InitGraf(&qd.thePort);
  InitFonts();
  InitWindows();
  InitMenus();
  TEInit();
  InitDialogs(0);
  InitCursor();
  return 0;
}
`;

test("compileToBin produces a MacBinary II APPL", async ({ page }) => {
  test.setTimeout(120_000); // first-call cold load: cc1 + as + ld + Elf2Mac + sysroot blobs

  // Navigate first — `page.evaluate` runs in the page's JS context,
  // where `import()` resolves URLs relative to the page origin. The
  // bare-URL fallback we use here (with location.origin) keeps the test
  // robust to the eval-wrapping `evaluate` does around the function body.
  await page.goto("/");

  const result = await page.evaluate(async (src) => {
    const mod = await import(
      /* @vite-ignore */ `${location.origin}/src/playground/cc1.ts`
    );
    if (typeof mod.compileToBin !== "function") {
      throw new Error("compileToBin not exported from cc1.ts");
    }
    const r = await mod.compileToBin("/", {
      sources: [{ filename: "hello.c", content: src }],
    });
    // Strip Uint8Array out of return — Playwright's evaluate
    // serializer doesn't deeply serialize them, so we just keep
    // length + header bytes + parsed fields the test asserts on.
    return {
      ok: r.ok,
      binLen: r.bin?.length ?? 0,
      header: r.bin ? Array.from(r.bin.subarray(0, 128)) : null,
      asmLen: r.asm?.length ?? 0,
      diagnostics: r.diagnostics,
      rawStderr: r.rawStderr,
      stages: r.stages,
      failedStage: r.failedStage,
      totalMs: r.totalMs,
    };
  }, HELLO_SOURCE);

  // Surface useful diagnostics on failure.
  if (!result.ok) {
    console.log("[compile-to-bin] failedStage:", result.failedStage);
    console.log("[compile-to-bin] rawStderr:");
    for (const l of (result.rawStderr || "").split("\n").slice(0, 30)) {
      console.log(`  ${l}`);
    }
  }

  expect(result.ok).toBe(true);
  expect(result.binLen).toBeGreaterThan(128);
  // MacBinary II byte 0 is the legacy "version" field, always 0.
  expect(result.header![0]).toBe(0);
  // Bytes 65..68 are the file type — ASCII 'APPL'.
  const type = String.fromCharCode(...result.header!.slice(65, 69));
  expect(type).toBe("APPL");
  // The four cc1/as/ld/Elf2Mac stages should each have measured time > 0.
  expect(result.stages!.cc1Ms).toBeGreaterThan(0);
  expect(result.stages!.asMs).toBeGreaterThan(0);
  expect(result.stages!.ldMs).toBeGreaterThan(0);
  expect(result.stages!.elf2macMs).toBeGreaterThan(0);
});

test("compileToBin survives repeat calls (cc1 re-entrancy regression guard)", async ({ page }) => {
  // cv-mac #64 / 2026-05-15: cc1 (and its sibling toolchain binaries) are
  // not safe to re-invoke on a cached Emscripten Module — `decode_options`'
  // statics persist across exits and cause "output filename specified
  // twice" on the second `callMain`. The bridge now instantiates a fresh
  // Module per call. This test calls compileToBin twice in a row and
  // asserts both succeed; a regression to module-caching would fail here.
  test.setTimeout(180_000);
  await page.goto(process.env.CVM_BASE_URL ?? "/");
  const results = await page.evaluate(async (src) => {
    const mod = await import(
      /* @vite-ignore */ `${location.origin}/src/playground/cc1.ts`
    );
    const opts = { sources: [{ filename: "hello.c", content: src }] };
    const r1 = await mod.compileToBin("/", opts);
    const r2 = await mod.compileToBin("/", opts);
    return [
      { ok: r1.ok, failedStage: r1.failedStage, binLen: r1.bin?.length ?? 0 },
      { ok: r2.ok, failedStage: r2.failedStage, binLen: r2.bin?.length ?? 0 },
    ];
  }, HELLO_SOURCE);
  expect(results[0].ok).toBe(true);
  expect(results[1].ok).toBe(true);
  // Both calls should produce identically-sized output for the same source.
  expect(results[0].binLen).toBe(results[1].binLen);
});
