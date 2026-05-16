/*
 * hello.c — the in-browser C compile-and-run demo (cv-mac #64).
 *
 * This source builds end-to-end in the playground itself: the
 * `Build & Run (in-browser)` button compiles it through cc1.wasm →
 * as.wasm → ld.wasm → Elf2Mac.wasm and hot-loads the resulting
 * MacBinary II APPL into BasiliskII. **No CI involved** — the
 * binary you boot is whatever the WebAssembly toolchain in your tab
 * just emitted. First time anyone can write classic Mac C in a
 * browser and watch it run.
 *
 * Why this app exists separately from `hello-mac/hello.c`:
 *   - `hello-mac/` is a full Toolbox example with a window, menus,
 *     a `.r` resource file, and the CMake recipe CI uses to produce
 *     the `.code.bin` that the splice flow fetches. It demonstrates
 *     "classic Mac app structure".
 *   - This `wasm-hello/` deliberately has *no resources* (no
 *     `.r` file, no `WIND`/`MENU`/`STR#`) so we can prove the
 *     in-browser pipeline end-to-end *without* the resource-fork
 *     splice step that other projects rely on. DrawString into the
 *     desktop port is visible without a window.
 *
 * If you've never seen 68k Mac Toolbox C, read
 * `hello-mac/hello.c` first — it explains Pascal strings, the
 * Toolbox init incantation, and the event loop. This one keeps
 * the surface area as small as the Toolbox allows.
 *
 * Source mirrors `wasm-retro-cc/spike/hello_toolbox.c` — the Phase 2.0
 * derisk binary. Building this in-browser and seeing it boot is the
 * milestone that closes the cv-mac #64 north star.
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Memory.h>

/* QDGlobals — the Toolbox's QuickDraw state. Every Mac app has one of
 * these at A5; InitGraf wires it up. Pascal toolchains expose it as
 * `qd` automatically; we declare it explicitly for C. */
QDGlobals qd;

/* "Hello, World!" as a Pascal string: byte 0 = length (13), then chars.
 * Written out as a byte array (not GCC's "\pHello" extension) so the
 * source is portable to any classic Mac C compiler — including PCC,
 * for any future side-by-side comparison work.
 *
 * ← try changing this! Rewrite the bytes (and update the leading
 * length byte to match) and Build & Run — your text will appear on
 * the Mac in ~1 second. */
static const unsigned char kHelloStr[] = {
    13, 'H', 'e', 'l', 'l', 'o', ',', ' ', 'W', 'o', 'r', 'l', 'd', '!'
};

int main(void)
{
    /* Toolbox initialisation — order matters: InitGraf MUST be first
     * (it sets up the QuickDraw globals every other manager reads). */
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();
    FlushEvents(everyEvent, 0);

    /* Draw to the screen port (the desktop) — no window needed. */
    MoveTo(100, 100);
    DrawString(kHelloStr);

    /* Idle until the user clicks. *Don't* use `while (!Button())` — that
     * naive spin polls the live mouse state, which can still read as
     * "pressed" on entry because the second click of the double-click
     * that launched us is bleeding through. The loop would exit
     * immediately and main would return before the user ever sees the
     * drawn string. (We learned this the hard way running the first
     * in-browser-built binary on classic-vibe-mac's deployed playground
     * — see cv-mac LEARNINGS "2026-05-15 — Double-click bleed-through".)
     *
     * Instead: drain the event queue once, then sit in WaitNextEvent
     * filtered to fresh mouseDowns. Any leftover mouseUp from the
     * launch is consumed by FlushEvents above; the next mouseDown
     * that satisfies the filter is genuinely new. SystemTask runs via
     * WNE under cooperative multitasking, so the rest of the Mac stays
     * responsive while we wait. */
    {
        EventRecord ev;
        long sleepTicks = 0x7fffffff; /* "wait forever" until an event */
        while (!WaitNextEvent(mDownMask, &ev, sleepTicks, NULL))
            ;
    }

    return 0;
}
