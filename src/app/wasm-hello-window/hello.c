/*
 * hello.c — windowed Hello, mixed C + .r demo (cv-mac #100 Phase B).
 *
 * Pairs with hello.r. Demonstrates the in-browser path where BOTH the
 * .c source AND the .r resources are compiled client-side and spliced
 * into one MacBinary. The resource fork's WIND, MBAR, MENU, etc.
 * resources come from hello.r; the data fork's CODE 0..N + RELA + a
 * default SIZE come from cc1+as+ld+Elf2Mac; spliceResourceFork merges
 * them (user-wins on collision, so this app's SIZE overrides the
 * default 1 MB heap from runBuildInBrowserC).
 *
 * Differs from wasm-hello/hello.c (no-window demo) by having an actual
 * window resource — gets a proper title bar, content area, the works.
 * The window's ID is 128 (matching the WIND resource declared in
 * hello.r). NewWindow(...) loads it from the resource fork at runtime.
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

#define kWindowID 128

QDGlobals qd;

static const unsigned char HELLO_PSTR[] = {
    13, 'H', 'e', 'l', 'l', 'o', ',', ' ',
    'W', 'o', 'r', 'l', 'd', '!',
};

int main(void) {
    /* Standard Toolbox init. */
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);

    /* GetNewWindow loads our window definition from the resource fork
     * (WIND 128 declared in hello.r). The (-1) puts it on top of the
     * window list; (WindowPtr)NULL passes no behind-window placement. */
    WindowPtr win = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!win) {
        SysBeep(10);
        return 1;
    }
    SetPort((GrafPtr)win);
    ShowWindow(win);

    /* Draw "Hello, World!" centred-ish in the window. */
    MoveTo(120, 80);
    DrawString(HELLO_PSTR);

    /* Event loop: redraw on update events, quit on click. */
    for (;;) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 60, NULL);
        switch (ev.what) {
            case mouseDown:
                if (FindWindow(ev.where, &win) == inGoAway) {
                    return 0;  /* click close box → exit */
                }
                return 0;  /* any other click exits too */
            case updateEvt:
                if ((WindowPtr)ev.message == win) {
                    BeginUpdate(win);
                    MoveTo(120, 80);
                    DrawString(HELLO_PSTR);
                    EndUpdate(win);
                }
                break;
        }
    }
    return 0;
}
