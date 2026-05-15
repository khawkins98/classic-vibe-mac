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
 * for any future side-by-side comparison work. */
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
    FlushEvents(everyEvent, 0);

    /* Draw to the screen port (the desktop) — no window needed. */
    MoveTo(100, 100);
    DrawString(kHelloStr);

    /* Spin until the user clicks, so the playground screenshot has
     * time to capture the drawn string before the app exits. */
    while (!Button())
        ;

    return 0;
}
