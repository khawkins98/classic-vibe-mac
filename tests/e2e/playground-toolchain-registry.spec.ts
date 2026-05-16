/**
 * Toolchain registry regression guard (cv-mac #100 Phase C).
 *
 * Locks in the public surface a future second backend (PowerPC,
 * per #98) would slot into. Catches:
 *   - the Toolchain interface drifting (capabilities reshape,
 *     compile signature change)
 *   - the default backend id changing accidentally
 *   - the registry returning something different than expected
 *     for unknown ids (must fall back to the default, not throw)
 *   - the public exports going missing
 *
 * Does NOT run a real compile through it — that's covered by the
 * existing playground-compile-to-bin.spec.ts which talks to cc1
 * directly. This spec is about the abstraction layer only.
 */
import { test, expect } from "@playwright/test";

test.describe("playground toolchain registry", () => {
  test("exports the expected surface and registers retro68-68k", async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto(process.env.CVM_BASE_URL ?? "/");

    const state = await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ `${location.origin}/src/playground/toolchain.ts`
      );
      const tc = mod.getToolchain("retro68-68k", "/");
      const tcDefault = mod.getToolchain(undefined, "/");
      const tcUnknown = mod.getToolchain("future-ppc-backend", "/");
      const list = mod.listToolchains("/");
      return {
        // Exports
        defaultId: mod.DEFAULT_TOOLCHAIN_ID,
        hasGet: typeof mod.getToolchain === "function",
        hasList: typeof mod.listToolchains === "function",
        hasRetro68: typeof mod.retro68_68k === "function",

        // Backend shape
        id: tc.id,
        label: tc.label,
        targets: tc.targets,
        capabilities: tc.capabilities,
        compileIsFn: typeof tc.compile === "function",

        // Default + fallback
        defaultMatches: tcDefault.id === tc.id,
        unknownFallsbackTo: tcUnknown.id,

        // Registry
        listIds: list.map((t: { id: string }) => t.id),
      };
    });

    // Public surface
    expect(state.defaultId).toBe("retro68-68k");
    expect(state.hasGet).toBe(true);
    expect(state.hasList).toBe(true);
    expect(state.hasRetro68).toBe(true);

    // 68k backend shape
    expect(state.id).toBe("retro68-68k");
    expect(state.label).toMatch(/Retro68/i);
    expect(state.targets).toContain("mac-classic-68k-appl");
    expect(state.compileIsFn).toBe(true);

    // Capabilities — the future PowerPC backend would advertise its
    // own set, but the 68k one's shape is fixed.
    const caps = state.capabilities as {
      multifile: boolean; mixedResources: boolean; cxx: boolean; optLevels: string[];
    };
    expect(caps.multifile).toBe(true);
    expect(caps.mixedResources).toBe(true);
    expect(caps.cxx).toBe(false);
    expect(caps.optLevels).toEqual(["O0", "Os", "O2"]);

    // Default + unknown-fallback behaviour
    expect(state.defaultMatches).toBe(true);
    expect(state.unknownFallsbackTo).toBe("retro68-68k");

    // Registry
    expect(state.listIds).toContain("retro68-68k");
  });
});
