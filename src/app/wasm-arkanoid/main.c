/*
 * main.c — wasm-arkanoid Toolbox glue + event loop (cv-mac #233, A).
 *
 * Owns init, window/menu setup, and event dispatch. Routes input
 * events into engine.c via the API in engine.h; calls RenderScene()
 * (render.c) when state changes.
 *
 * Multi-file structure is the ★★★★★-tier feature this demo
 * primarily demonstrates: main.c is ~120 lines of Toolbox bedrock,
 * engine.c is ~150 lines of pure game logic with no Toolbox
 * dependencies, render.c is ~110 lines of QuickDraw painting. The
 * separation makes each file readable in one screen and lets you
 * change e.g. the renderer's pattern choice without touching the
 * physics math.
 *
 * Resources (arkanoid.r): standard MBAR + MENUs, an ALRT for About,
 * a SIZE override for the heap, and an ICN# 128 — the custom
 * about-box icon — embedded as a hex literal directly in the Rez
 * source. That ICN# is the "binary asset" piece of the ★★★★★
 * complexity rating: a real binary resource shipped with the app,
 * loaded via GetResource('ICN#', 128), rendered with PlotIconID.
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Devices.h>           /* HandleAppleMenuSelect helpers */
#include <Resources.h>
#include "engine.h"

/* From render.c */
void RenderScene(const Game *g);

/* ── Menu IDs ────────────────────────────────────────────────────── */

#define MBAR_ID         128
#define APPLE_MENU_ID   128
#define FILE_MENU_ID    129
#define GAME_MENU_ID    130

#define APPLE_ABOUT     1

#define FILE_QUIT       1

#define GAME_NEW        1
#define GAME_PAUSE      2

#define ABOUT_ALRT_ID   128

/* ── Globals (single window, single game). ───────────────────────── */

static WindowPtr gWin;
static Game gGame;
static Boolean gQuit;

/* ── Init ────────────────────────────────────────────────────────── */

static void InitToolbox(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0L);
    InitCursor();
    FlushEvents(everyEvent, 0);
}

static void SetupMenus(void) {
    Handle mbar = GetNewMBar(MBAR_ID);
    MenuHandle appleMenu;
    if (mbar) {
        SetMenuBar(mbar);
        DisposeHandle(mbar);
    }
    appleMenu = GetMenuHandle(APPLE_MENU_ID);
    if (appleMenu) {
        AppendResMenu(appleMenu, 'DRVR');
    }
    DrawMenuBar();
}

static void SetupWindow(void) {
    gWin = GetNewWindow(WINDOW_ID, NULL, (WindowPtr)-1L);
    if (gWin) {
        SetPort(gWin);
        ShowWindow(gWin);
    }
}

/* ── Menu handling ───────────────────────────────────────────────── */

static void DoAboutBox(void) {
    /* Standard NoteAlert — the ALRT 128 resource references a DITL
     * which references our custom ICN# 128 for the icon. That's the
     * "binary asset is actually rendered" hookup. */
    SetCursor(&qd.arrow);
    NoteAlert(ABOUT_ALRT_ID, NULL);
}

static void HandleMenu(long menuChoice) {
    short menuID = HiWord(menuChoice);
    short itemID = LoWord(menuChoice);
    if (menuID == APPLE_MENU_ID) {
        if (itemID == APPLE_ABOUT) {
            DoAboutBox();
        } else {
            /* Desk accessory selected. */
            Str255 daName;
            GetMenuItemText(GetMenuHandle(APPLE_MENU_ID), itemID, daName);
            OpenDeskAcc(daName);
        }
    } else if (menuID == FILE_MENU_ID) {
        if (itemID == FILE_QUIT) gQuit = true;
    } else if (menuID == GAME_MENU_ID) {
        if (itemID == GAME_NEW) {
            EngineNewGame(&gGame);
            InvalRect(&gWin->portRect);
        } else if (itemID == GAME_PAUSE) {
            EngineTogglePause(&gGame);
            InvalRect(&gWin->portRect);
        }
    }
    HiliteMenu(0);
}

/* ── Event dispatch ──────────────────────────────────────────────── */

static void HandleKey(EventRecord *e) {
    char ch = e->message & charCodeMask;
    /* Cmd-key menu shortcuts. */
    if (e->modifiers & cmdKey) {
        long mc = MenuKey(ch);
        if (HiWord(mc) != 0) {
            HandleMenu(mc);
            return;
        }
    }
    /* Arrow keys → paddle. Arrow keys come in as 0x1c/0x1d/0x1e/0x1f. */
    if (ch == 0x1c) {                /* left arrow */
        EnginePaddleLeft(&gGame);
    } else if (ch == 0x1d) {         /* right arrow */
        EnginePaddleRight(&gGame);
    }
}

static void HandleMouse(EventRecord *e) {
    WindowPtr whichWin;
    short part = FindWindow(e->where, &whichWin);
    if (part == inMenuBar) {
        HandleMenu(MenuSelect(e->where));
    } else if (part == inContent && whichWin == gWin) {
        if (gGame.phase == PHASE_GAME_OVER || gGame.phase == PHASE_WIN) {
            EngineNewGame(&gGame);
            InvalRect(&gWin->portRect);
        }
    } else if (part == inDrag && whichWin == gWin) {
        Rect dragBounds = qd.screenBits.bounds;
        DragWindow(gWin, e->where, &dragBounds);
    } else if (part == inGoAway && whichWin == gWin) {
        if (TrackGoAway(gWin, e->where)) gQuit = true;
    } else if (part == inSysWindow) {
        SystemClick(e, whichWin);
    }
}

static void HandleUpdate(EventRecord *e) {
    WindowPtr w = (WindowPtr)e->message;
    if (w == gWin) {
        SetPort(w);
        BeginUpdate(w);
        RenderScene(&gGame);
        EndUpdate(w);
    }
}

/* ── Main loop ───────────────────────────────────────────────────── */

int main(void) {
    EventRecord event;
    long lastDrawTick;

    InitToolbox();
    SetupMenus();
    SetupWindow();

    EngineNewGame(&gGame);
    SetPort(gWin);
    RenderScene(&gGame);
    lastDrawTick = TickCount();
    gQuit = false;

    while (!gQuit) {
        if (WaitNextEvent(everyEvent, &event, 1, NULL)) {
            switch (event.what) {
                case keyDown:
                case autoKey:
                    HandleKey(&event);
                    break;
                case mouseDown:
                    HandleMouse(&event);
                    break;
                case updateEvt:
                    HandleUpdate(&event);
                    break;
            }
        }
        /* Physics tick — runs even on null events to keep ball moving. */
        if (EngineTick(&gGame, TickCount())) {
            SetPort(gWin);
            RenderScene(&gGame);
            lastDrawTick = TickCount();
        }
        /* Defensive periodic redraw if nothing has triggered one in
         * over a second (e.g. after a desk accessory closes). */
        if (TickCount() - lastDrawTick > 60) {
            SetPort(gWin);
            RenderScene(&gGame);
            lastDrawTick = TickCount();
        }
    }
    return 0;
}
