/*
 * minesweeper.c — Classic Mac OS Minesweeper clone
 * Target: 68k Mac, System 7+, compiled with Retro68
 *
 * TODO: implement game logic
 *   - Grid initialization with random mine placement
 *   - Reveal cells on click (flood fill for empty cells)
 *   - Flag cells on option-click
 *   - Win/lose detection
 *   - New game button
 */

#include <MacTypes.h>
#include <QuickDraw.h>
#include <Windows.h>
#include <Events.h>
#include <Menus.h>

int main(void)
{
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(nil);
    InitCursor();

    /* Placeholder: open a window and spin the event loop */
    Rect bounds = { 50, 50, 300, 300 };
    WindowPtr win = NewWindow(nil, &bounds, "\pMinesweeper", true, noGrowDocProc,
                              (WindowPtr)-1L, true, 0);
    SetPort(win);

    EventRecord evt;
    for (;;) {
        WaitNextEvent(everyEvent, &evt, 60, nil);
        if (evt.what == keyDown) {
            char key = evt.message & charCodeMask;
            if ((evt.modifiers & cmdKey) && key == 'q') break;
        }
    }

    return 0;
}
