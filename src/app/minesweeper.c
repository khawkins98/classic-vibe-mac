/*
 * minesweeper.c — TEMPORARY hello-world for bisecting the
 * "unimplemented trap" bomb on deploy. ROUND 2.
 *
 * Round 1 (one WIND in the .r file + GetNewWindow) also bombed,
 * so this round goes one step further: NO resource-defined window,
 * NO GetNewWindow. The window is created from C with NewWindow()
 * and a hardcoded Rect. The .r file is now SIZE-only + vers.
 *
 * If this still bombs, the bug is in: the Retro68 runtime startup,
 * the SIZE flag combination, the .bin Type/Creator, or the ROM/SDK
 * version mismatch — see LEARNINGS.md round-1 entry.
 *
 * Originals preserved as minesweeper-full.{c,r}.bak.
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
    Rect       r;
    WindowPtr  win;
    EventRecord e;
    Boolean    quit = false;

    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();

    MoreMasters();
    MoreMasters();
    MoreMasters();
    MoreMasters();

    /* Hardcoded window — no WIND resource. SetRect(top, left, bottom,
     * right? no — SetRect signature is (r, left, top, right, bottom).
     * Inside Macintosh: Imaging With QuickDraw, p. 2-49. */
    SetRect(&r, 60, 60, 320, 180);
    win = NewWindow(NULL, &r, "\pHello",
                    true,             /* visible */
                    documentProc,     /* WDEF id 0, plain document window */
                    (WindowPtr)-1L,   /* in front */
                    true,             /* goAwayFlag */
                    0L);              /* refCon */

    if (win == NULL) {
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
