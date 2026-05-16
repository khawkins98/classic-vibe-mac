/*
 * main.c — wasm-icon-gallery (cv-mac #233 ★★★★★★ tier demo).
 *
 * What this proves out at the 6-star tier:
 *   - The build pipeline injects a pre-built `.rsrc.bin` file
 *     onto the disk alongside the app, via the splice infra
 *     landed in #251 (`ExtraFile.resourceFork`).
 *   - The app opens it at runtime with `OpenResFile("Icons")`
 *     and pulls resources out via standard Resource Manager calls.
 *   - The icons.rsrc.bin file is generated offline by
 *     `scripts/build-icon-gallery-rsrc.mjs`, committed to the
 *     repo as a binary — a real "asset shipped with the app"
 *     workflow rather than the in-Rez-source ICN# trick we used
 *     for the about-box icon in wasm-arkanoid.
 *
 * The Toolbox surface and UX are deliberately tiny: open a window,
 * show a 3×2 grid of icons with labels, About menu, Quit. The
 * complexity points come from the multi-source structure and the
 * external asset pipeline, not from gameplay loops or input.
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Devices.h>
#include "gallery.h"

#define MBAR_ID         128
#define APPLE_MENU_ID   128
#define FILE_MENU_ID    129
#define APPLE_ABOUT     1
#define FILE_QUIT       1
#define ABOUT_ALRT_ID   128

static WindowPtr gWin;
static Boolean gQuit;

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
    if (appleMenu) AppendResMenu(appleMenu, 'DRVR');
    DrawMenuBar();
}

static void SetupWindow(void) {
    gWin = GetNewWindow(WINDOW_ID, NULL, (WindowPtr)-1L);
    if (gWin) {
        SetPort(gWin);
        ShowWindow(gWin);
    }
}

static void DoAboutBox(void) {
    SetCursor(&qd.arrow);
    NoteAlert(ABOUT_ALRT_ID, NULL);
}

static void HandleMenu(long mc) {
    short menuID = HiWord(mc);
    short itemID = LoWord(mc);
    if (menuID == APPLE_MENU_ID) {
        if (itemID == APPLE_ABOUT) {
            DoAboutBox();
        } else {
            Str255 daName;
            GetMenuItemText(GetMenuHandle(APPLE_MENU_ID), itemID, daName);
            OpenDeskAcc(daName);
        }
    } else if (menuID == FILE_MENU_ID) {
        if (itemID == FILE_QUIT) gQuit = true;
    }
    HiliteMenu(0);
}

static void HandleKey(EventRecord *e) {
    char ch = e->message & charCodeMask;
    if (e->modifiers & cmdKey) {
        long mc = MenuKey(ch);
        if (HiWord(mc) != 0) HandleMenu(mc);
    }
}

static void HandleMouse(EventRecord *e) {
    WindowPtr w;
    short part = FindWindow(e->where, &w);
    if (part == inMenuBar) {
        HandleMenu(MenuSelect(e->where));
    } else if (part == inDrag && w == gWin) {
        Rect bounds = qd.screenBits.bounds;
        DragWindow(gWin, e->where, &bounds);
    } else if (part == inGoAway && w == gWin) {
        if (TrackGoAway(gWin, e->where)) gQuit = true;
    } else if (part == inSysWindow) {
        SystemClick(e, w);
    }
}

static void HandleUpdate(EventRecord *e) {
    WindowPtr w = (WindowPtr)e->message;
    if (w == gWin) {
        SetPort(w);
        BeginUpdate(w);
        RenderGallery();
        EndUpdate(w);
    }
}

int main(void) {
    EventRecord event;

    InitToolbox();
    SetupMenus();
    SetupWindow();

    /* Open the binary asset file shipped alongside us by the build
     * pipeline. If it's missing, the window still draws but with
     * outlined empty cells where the icons would be — the visible
     * failure mode for "the splice infra didn't deliver the file." */
    GalleryOpen();

    SetPort(gWin);
    RenderGallery();
    gQuit = false;

    while (!gQuit) {
        if (WaitNextEvent(everyEvent, &event, 10, NULL)) {
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
    }

    GalleryClose();
    return 0;
}
