/*
 * notepad.c — TextEdit + real menu bar. The next rung from
 * wasm-textedit toward a mini word processor (cv-mac #125).
 *
 * Demonstrates:
 *   - Apple/File/Edit menu bar loaded from MBAR 128 (notepad.r).
 *   - GetMenuBar / SetMenuBar / DrawMenuBar so System 7's chrome
 *     renders the bar at the top of the screen.
 *   - MenuSelect → HiWord/LoWord splits the result into menuID
 *     + item; we dispatch per menu and per item.
 *   - File → New clears the field; File → Quit exits.
 *   - Edit menu routes Cut / Copy / Paste through TECut / TECopy /
 *     TEPaste, transparently using the system scrap.
 *   - About box: Apple → About Wasm Notepad… opens a tiny modal
 *     via Alert (ALRT 128 in the .r).
 *   - Cmd-key shortcuts: Cmd-N / Cmd-Q / Cmd-X / Cmd-C / Cmd-V
 *     dispatched via MenuKey on the keyDown event.
 *
 * Pairs with notepad.r (MBAR + MENU 128/129/130 + WIND 128 +
 * ALRT 128 + DITL 128 + SIZE -1 + signature 'CVNP').
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

#define kWindowID  128
#define kAlertID   128

#define kMenuApple 128
#define kMenuFile  129
#define kMenuEdit  130

#define kAppleAbout 1
/* File menu items */
#define kFileNew    1
#define kFileQuit   3  /* item 2 is the separator */
/* Edit menu items (Undo greyed in MENU 130 — item 1) */
#define kEditCut    3
#define kEditCopy   4
#define kEditPaste  5
#define kEditClear  6

QDGlobals qd;

static const unsigned char STARTER_TEXT[] = {
    65,
    'N','o','t','e','p','a','d',' ','-','-',' ','t','y','p','e',' ',
    'a','w','a','y','.',13,
    13,
    'F','i','l','e',' ','>',' ','N','e','w',' ','c','l','e','a','r',
    's','.',' ','E','d','i','t',' ','m','e','n','u',' ','i','s',' ',
    'l','i','v','e','.'
};

static TEHandle gTE = NULL;
static WindowPtr gWin = NULL;
static Boolean gDone = FALSE;

static void DoAbout(void) {
    /* StopAlert is OK for a one-button "About". Returns the button id;
     * we don't care which since there's only one. */
    StopAlert(kAlertID, NULL);
}

static void DoMenu(long sel) {
    short menuID = HiWord(sel);
    short item   = LoWord(sel);
    switch (menuID) {
        case kMenuApple:
            if (item == kAppleAbout) DoAbout();
            /* Items 2..N are desk-accessory entries the system fills in;
             * the Mac OS routes them via OpenDeskAcc but we omit that for
             * brevity — see Inside Macintosh: Macintosh Toolbox Essentials,
             * "Menu Manager", "Adding the Apple Menu Items". */
            break;
        case kMenuFile:
            if (item == kFileNew && gTE) {
                TESetText("", 0, gTE);
                TESetSelect(0, 0, gTE);
            } else if (item == kFileQuit) {
                gDone = TRUE;
            }
            break;
        case kMenuEdit:
            if (!gTE) break;
            switch (item) {
                case kEditCut:   TECut(gTE);   break;
                case kEditCopy:  TECopy(gTE);  break;
                case kEditPaste: TEPaste(gTE); break;
                case kEditClear: TEDelete(gTE); break;
            }
            break;
    }
    HiliteMenu(0);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();

    /* Load and install the menu bar from MBAR 128. The Apple menu
     * (MENU 128) was declared with the apple-mark string so the system
     * draws the rainbow apple character automatically. AppendResMenu
     * fills the Apple menu with the system's desk-accessory list — we
     * append even though we don't route DAs, so the bar reads correct. */
    Handle mb = GetNewMBar(128);
    if (mb) {
        SetMenuBar(mb);
        AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
        DrawMenuBar();
    }

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) {
        SysBeep(10);
        return 1;
    }
    SetPort((GrafPtr)gWin);
    ShowWindow(gWin);

    /* TE field fills the window with an 8 px inset. */
    Rect r;
    r.top    = gWin->portRect.top + 8;
    r.left   = gWin->portRect.left + 8;
    r.bottom = gWin->portRect.bottom - 8;
    r.right  = gWin->portRect.right - 8;
    gTE = TENew(&r, &r);
    if (!gTE) {
        SysBeep(10);
        return 1;
    }
    TESetText((Ptr)&STARTER_TEXT[1], (long)STARTER_TEXT[0], gTE);
    TESetSelect(0x7FFF, 0x7FFF, gTE);
    TEActivate(gTE);

    while (!gDone) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);

        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                switch (part) {
                    case inMenuBar: {
                        long sel = MenuSelect(ev.where);
                        if (HiWord(sel) != 0) DoMenu(sel);
                        break;
                    }
                    case inContent:
                        if (w == gWin) {
                            Point local = ev.where;
                            GlobalToLocal(&local);
                            TEClick(local, (ev.modifiers & shiftKey) != 0, gTE);
                        }
                        break;
                    case inDrag: {
                        Rect bounds = qd.screenBits.bounds;
                        bounds.top += 20;
                        DragWindow(w, ev.where, &bounds);
                        break;
                    }
                    case inGoAway:
                        if (TrackGoAway(w, ev.where)) gDone = TRUE;
                        break;
                }
                break;
            }
            case keyDown:
            case autoKey: {
                char ch = (char)(ev.message & charCodeMask);
                if (ev.modifiers & cmdKey) {
                    long sel = MenuKey(ch);
                    if (HiWord(sel) != 0) DoMenu(sel);
                } else if (gTE) {
                    TEKey(ch, gTE);
                }
                break;
            }
            case activateEvt:
                if ((WindowPtr)ev.message == gWin && gTE) {
                    if (ev.modifiers & activeFlag) TEActivate(gTE);
                    else TEDeactivate(gTE);
                }
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    EraseRect(&gWin->portRect);
                    if (gTE) TEUpdate(&gWin->portRect, gTE);
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                if (gTE) TEIdle(gTE);
                break;
        }
    }

    if (gTE) TEDispose(gTE);
    return 0;
}
