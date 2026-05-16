/**
 * Toolbox Reference window regression guard (cv-mac #196 Phase 3).
 *
 * Covers the in-tab Inside-Macintosh-style reference window opened by
 * ⌘-click on a known Toolbox identifier, by `openToolboxReference()`
 * directly, or by Help → Toolbox Reference…
 *
 * What we verify:
 *   1. The reference module loads and exports `openToolboxReference` +
 *      `isToolboxIdentifier` — the surface the editor + menubar wire
 *      against.
 *   2. Calling `openToolboxReference("NewGWorld")` mounts a WinBox
 *      whose body contains the expected name, the right header
 *      (<QDOffscreen.h>), the signature text, and a non-empty
 *      "See also" list.
 *   3. Clicking a See-Also entry navigates the same window in place
 *      (singleton — no second WinBox spawns; title updates).
 *   4. `isToolboxIdentifier` returns true for known calls and false
 *      for unknown ones — the editor's ⌘-click handler relies on this
 *      to ignore user variables.
 *
 * Why not test the ⌘-click DOM path: hover/click hit-testing through
 * CodeMirror in headless is flaky (virtualised viewport, span splits
 * for syntax highlighting). The exported function IS the integration
 * point; if it works, the editor's click handler works.
 */
import { test, expect } from "@playwright/test";

test.describe("playground Toolbox Reference", () => {
  test("opens, navigates via See-Also, recognises known + unknown identifiers", async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto(process.env.CVM_BASE_URL ?? "/");

    const state = await page.evaluate(async () => {
      const mod = await import(
        /* @vite-ignore */ `${location.origin}/src/playground/toolbox-reference-window.ts`
      );

      const out: Record<string, unknown> = {};
      out.hasOpen = typeof mod.openToolboxReference === "function";
      out.hasIs = typeof mod.isToolboxIdentifier === "function";
      out.knownIdent = mod.isToolboxIdentifier("NewGWorld");
      out.unknownIdent = mod.isToolboxIdentifier("CVM_NOT_A_REAL_CALL_42");
      // 3-char-or-less safety: hover skips short idents to avoid flicker,
      // but the dictionary lookup itself should still work for valid 3-char
      // names like "Get*" etc. There are no <3-char Toolbox calls.
      mod.openToolboxReference("NewGWorld");
      await new Promise((r) => setTimeout(r, 400));
      const card = document.querySelector(".cvm-toolbox-winbox .cvm-toolbox-ref");
      out.firstCard = card
        ? {
            name: card.querySelector(".cvm-toolbox-ref__name")?.textContent,
            include: card.querySelector(".cvm-toolbox-ref__include")?.textContent,
            sigHead: card.querySelector(".cvm-toolbox-ref__sig")?.textContent?.slice(0, 60),
            blurbHead: card.querySelector(".cvm-toolbox-ref__blurb")?.textContent?.slice(0, 30),
            seeAlsoCount: card.querySelectorAll(".cvm-toolbox-ref__see-also li").length,
          }
        : null;

      // Navigate via See-Also: click the first link, confirm same WinBox
      // (no new one spawned), confirm the body updated.
      const links = document.querySelectorAll<HTMLAnchorElement>(
        ".cvm-toolbox-winbox .cvm-toolbox-ref__see-also a",
      );
      out.firstSeeAlsoTarget = links[0]?.dataset.cvmToolboxRef;
      links[0]?.click();
      await new Promise((r) => setTimeout(r, 250));
      const card2 = document.querySelector(".cvm-toolbox-winbox .cvm-toolbox-ref");
      out.afterNav = {
        name: card2?.querySelector(".cvm-toolbox-ref__name")?.textContent,
        windowCount: document.querySelectorAll(".cvm-toolbox-winbox").length,
      };
      return out;
    });

    expect(state.hasOpen).toBe(true);
    expect(state.hasIs).toBe(true);
    expect(state.knownIdent).toBe(true);
    expect(state.unknownIdent).toBe(false);

    expect(state.firstCard).not.toBeNull();
    const card = state.firstCard as {
      name: string; include: string; sigHead: string;
      blurbHead: string; seeAlsoCount: number;
    };
    expect(card.name).toBe("NewGWorld");
    expect(card.include).toBe("<QDOffscreen.h>");
    expect(card.sigHead).toMatch(/NewGWorld/);
    expect(card.blurbHead.length).toBeGreaterThan(10);
    expect(card.seeAlsoCount).toBeGreaterThanOrEqual(1);

    // Navigation
    expect(state.firstSeeAlsoTarget).toBeTruthy();
    const after = state.afterNav as { name: string; windowCount: number };
    expect(after.name).toBe(state.firstSeeAlsoTarget);
    // Singleton — no second WinBox.
    expect(after.windowCount).toBe(1);
  });
});
