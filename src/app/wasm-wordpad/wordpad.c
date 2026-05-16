/*
 * wordpad.c — Mini word processor (cv-mac #125).
 *
 * Takes wasm-notepad up a rung: instead of a single hard-coded font
 * and size, the whole document is rendered in a user-selectable
 * font / size / style. Three live menus drive it:
 *
 *   Font   — Geneva, Chicago, Monaco, Courier
 *   Size   — 9, 10, 12, 14, 18, 24
 *   Style  — Plain, Bold, Italic, Underline  (Bold/Italic/Underline
 *            stack as a bitmask; Plain clears the lot)
 *
 * Implementation note: this is *monostyle* TextEdit — TENew, not
 * TEStyleNew. The font / size / style apply to the whole document at
 * once (changing the menu re-styles the entire buffer). True per-run
 * styling would need TEStyleNew + TESetStyle on the current selection,
 * which is a meaningful jump in API surface and per-record bookkeeping.
 * Monostyle covers the affordance the user expects and stays close to
 * Notepad's structure so the diff is comprehensible.
 *
 * Apple / File / Edit are the same shape as Notepad. The two new
 * Font/Size/Style menus live to the right of Edit on the bar.
 *
 * Pairs with wordpad.r (MBAR 128 + MENU 128–133 + WIND 128 + ALRT 128
 * + DITL 128 + SIZE -1 + signature 'CVWP').
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

#ifndef FALSE
# define FALSE 0
#endif
#ifndef TRUE
# define TRUE 1
#endif

#define kWindowID  128
#define kAlertID   128

#define kMenuApple  128
#define kMenuFile   129
#define kMenuEdit   130
#define kMenuFont   131
#define kMenuSize   132
#define kMenuStyle  133

#define kAppleAbout 1
/* File menu items */
#define kFileNew    1
#define kFileQuit   3  /* item 2 is the separator */
/* Edit menu items (Undo greyed in MENU 130 — item 1) */
#define kEditCut    3
#define kEditCopy   4
#define kEditPaste  5
#define kEditClear  6

/* Font menu items — 1..4 map to four named font IDs below. */
#define kFontGeneva  1
#define kFontChicago 2
#define kFontMonaco  3
#define kFontCourier 4

/* Size menu items — 1..6 map to six concrete sizes. */
static const short kSizeValues[] = { 9, 10, 12, 14, 18, 24 };
#define kSizeCount 6

/* Style menu items */
#define kStylePlain    1
#define kStyleBold     2  /* item 2 is a separator after Plain — re-check below */
#define kStyleItalic   3
#define kStyleUnderline 4

QDGlobals qd;

static const unsigned char STARTER_TEXT[] = {
    97,
    'M','i','n','i',' ','W','o','r','d',' ','P','r','o','c','e','s',
    's','o','r','.',13,
    13,
    'P','i','c','k',' ','a',' ','f','o','n','t',',',' ','s','i','z',
    'e',',',' ','o','r',' ','s','t','y','l','e',' ','f','r','o','m',
    ' ','t','h','e',' ','m','e','n','u','s',' ','a','b','o','v','e',
    '.',' ','T','y','p','e',' ','t','o',' ','i','n','s','e','r','t',
    '.'
};

static TEHandle gTE = NULL;
static WindowPtr gWin = NULL;
static Boolean gDone = FALSE;

/* Live document styling — applied to the TE record before each redraw. */
static short gFontID  = 3;     /* Geneva is 3 in the classic Mac font table */
static short gSizeIdx = 2;     /* index into kSizeValues — 12pt default */
static short gFaceMask = 0;    /* bitwise OR of bold/italic/underline */

/* Map font-menu item -> classic Mac font ID. */
static short FontIDForMenuItem(short item) {
    switch (item) {
        case kFontGeneva:  return 3;
        case kFontChicago: return 0;   /* system font */
        case kFontMonaco:  return 4;
        case kFontCourier: return 22;
        default:           return 3;
    }
}

/* Re-apply the live (font, size, face) to the TE record's text-style
 * fields and force a relayout + repaint. Monostyle means a single
 * (font, size, face) triple governs the whole buffer. */
static void ApplyStyle(void) {
    if (!gTE) return;
    TEPtr p = *gTE;
    p->txFont = gFontID;
    p->txSize = kSizeValues[gSizeIdx];
    p->txFace = gFaceMask;
    /* Re-measure line breaks against the new metrics. TECalText is
     * exactly the "I changed something stylistic, please relayout"
     * primitive — undocumented in the original IM but ships in every
     * Universal Headers we target. */
    TECalText(gTE);
    InvalRect(&(**gTE).viewRect);
}

/* Toggle the check marks in the Font, Size, Style menus so the current
 * selection reads correctly when the user pulls down. */
static void UpdateMenuChecks(void) {
    MenuHandle mh;

    mh = GetMenuHandle(kMenuFont);
    if (mh) {
        for (short i = 1; i <= 4; i++) {
            CheckItem(mh, i, FontIDForMenuItem(i) == gFontID);
        }
    }
    mh = GetMenuHandle(kMenuSize);
    if (mh) {
        for (short i = 1; i <= kSizeCount; i++) {
            CheckItem(mh, i, (i - 1) == gSizeIdx);
        }
    }
    mh = GetMenuHandle(kMenuStyle);
    if (mh) {
        /* Plain is a "clear" affordance — checked only when the face
         * mask is empty. */
        CheckItem(mh, kStylePlain, gFaceMask == 0);
        CheckItem(mh, kStyleBold,     (gFaceMask & bold) != 0);
        CheckItem(mh, kStyleItalic,   (gFaceMask & italic) != 0);
        CheckItem(mh, kStyleUnderline,(gFaceMask & underline) != 0);
    }
}

static void DoAbout(void) {
    StopAlert(kAlertID, NULL);
}

static void DoFileMenu(short item) {
    if (item == kFileNew && gTE) {
        TESetText("", 0, gTE);
        TESetSelect(0, 0, gTE);
    } else if (item == kFileQuit) {
        gDone = TRUE;
    }
}

static void DoEditMenu(short item) {
    if (!gTE) return;
    switch (item) {
        case kEditCut:   TECut(gTE);    break;
        case kEditCopy:  TECopy(gTE);   break;
        case kEditPaste: TEPaste(gTE);  break;
        case kEditClear: TEDelete(gTE); break;
    }
}

static void DoFontMenu(short item) {
    short newFont = FontIDForMenuItem(item);
    if (newFont == gFontID) return;
    gFontID = newFont;
    ApplyStyle();
    UpdateMenuChecks();
}

static void DoSizeMenu(short item) {
    short idx = item - 1;
    if (idx < 0 || idx >= kSizeCount) return;
    if (idx == gSizeIdx) return;
    gSizeIdx = idx;
    ApplyStyle();
    UpdateMenuChecks();
}

static void DoStyleMenu(short item) {
    short mask = 0;
    switch (item) {
        case kStylePlain:    gFaceMask = 0;            ApplyStyle(); UpdateMenuChecks(); return;
        case kStyleBold:     mask = bold;      break;
        case kStyleItalic:   mask = italic;    break;
        case kStyleUnderline:mask = underline; break;
        default:             return;
    }
    /* Bold/Italic/Underline toggle individually — XOR the bit. */
    gFaceMask ^= mask;
    ApplyStyle();
    UpdateMenuChecks();
}

static void DoMenu(long sel) {
    short menuID = HiWord(sel);
    short item   = LoWord(sel);
    switch (menuID) {
        case kMenuApple:
            if (item == kAppleAbout) DoAbout();
            break;
        case kMenuFile:  DoFileMenu(item);  break;
        case kMenuEdit:  DoEditMenu(item);  break;
        case kMenuFont:  DoFontMenu(item);  break;
        case kMenuSize:  DoSizeMenu(item);  break;
        case kMenuStyle: DoStyleMenu(item); break;
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

    Handle mb = GetNewMBar(128);
    if (mb) {
        SetMenuBar(mb);
        AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
        DrawMenuBar();
    }

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);
    ShowWindow(gWin);

    Rect r;
    r.top    = gWin->portRect.top + 8;
    r.left   = gWin->portRect.left + 8;
    r.bottom = gWin->portRect.bottom - 8;
    r.right  = gWin->portRect.right - 8;
    gTE = TENew(&r, &r);
    if (!gTE) { SysBeep(10); return 1; }
    TESetText((Ptr)&STARTER_TEXT[1], (long)STARTER_TEXT[0], gTE);
    TESetSelect(0x7FFF, 0x7FFF, gTE);
    TEActivate(gTE);
    ApplyStyle();
    UpdateMenuChecks();

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
