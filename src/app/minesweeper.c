/*
 * minesweeper.c — TEMPORARY hello-world for bisecting the
 * "unimplemented trap" bomb on deploy.
 *
 * The full Minesweeper is preserved as minesweeper-full.c.bak (and
 * its resource fork as minesweeper-full.r.bak). This shrinks the
 * suspect surface to the bare minimum Toolbox surface area:
 *   - basic init (with MoreMasters)
 *   - one WIND resource (id 128)
 *   - draw "It works." into it
 *   - WaitNextEvent loop, exit on Cmd-Q or click in goAway
 *
 * If this boots cleanly on the deployed page, the bomb is in the
 * full Minesweeper code or its richer resource fork. If it ALSO
 * bombs, the bug is in the resource file, basic init, or the
 * Retro68 runtime itself.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68.
 */

#include <Quickdraw.h>
#include <Windows.h>
#include <Events.h>
#include <Fonts.h>
#include <Dialogs.h>
#include <TextEdit.h>
#include <Memory.h>

int main(void)
{
    WindowPtr win;
    EventRecord e;
    Boolean    quit = false;

    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();

    /* Expand the master pointer block a few times so the Memory
     * Manager doesn't have to relocate handles in tight low-memory
     * conditions. Standard System 7-era idiom; Inside Macintosh:
     * Memory recommends this right after InitDialogs. */
    MoreMasters();
    MoreMasters();
    MoreMasters();
    MoreMasters();

    win = GetNewWindow(128, NULL, (WindowPtr)-1L);
    if (win == NULL) {
        /* If the WIND resource didn't load, just spin so we get a
         * known-state hang instead of a wild dereference. */
        while (!quit) {
            WaitNextEvent(everyEvent, &e, 60L, NULL);
        }
        return 1;
    }

    SetPort(win);
    TextFont(applFont);
    TextSize(12);

    while (!quit) {
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown: {
                    WindowPtr which;
                    short part = FindWindow(e.where, &which);
                    if (part == inGoAway && which == win) {
                        if (TrackGoAway(which, e.where)) quit = true;
                    } else if (part == inDrag && which == win) {
                        DragWindow(which, e.where, &qd.screenBits.bounds);
                    } else if (part == inSysWindow) {
                        SystemClick(&e, which);
                    }
                    break;
                }
                case keyDown:
                case autoKey: {
                    char key = (char)(e.message & 0xFF);
                    if ((e.modifiers & cmdKey) && (key == 'q' || key == 'Q')) {
                        quit = true;
                    }
                    break;
                }
                case updateEvt: {
                    WindowPtr w = (WindowPtr)e.message;
                    SetPort(w);
                    BeginUpdate(w);
                    EraseRect(&w->portRect);
                    MoveTo(20, 40);
                    DrawString("\pIt works.");
                    EndUpdate(w);
                    break;
                }
            }
        }
    }

    return 0;
}
