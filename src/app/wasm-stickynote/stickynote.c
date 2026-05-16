/*
 * stickynote.c — small floating sticky-note demo (cv-mac #125).
 *
 * The whole sticky-note vibe in ~120 lines:
 *   - A small, borderless WIND (modeless dialog look) you can drag
 *     anywhere on the desktop. Smaller and lighter than wasm-notepad.
 *   - Pale-yellow paper field painted underneath the TextEdit so the
 *     window reads as a Mac OS yellow sticky.
 *   - One-line title at the top in Chicago bold; the body is Geneva 12
 *     where TextEdit lives.
 *   - Click the close box to dismiss the note (and quit).
 *
 * What this *doesn't* do (deliberate, to keep the sample small):
 *   - No persistence across launches. The Mac filesystem inside
 *     BasiliskII doesn't survive a fresh build & run, so persistence
 *     wouldn't be observable to the user anyway.
 *   - No menus or scrap. wasm-notepad covers that ladder rung.
 *
 * Pairs with stickynote.r (WIND 128 with a borderless dBoxProc-style
 * frame, SIZE -1, signature 'CVSN').
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

/* Pale yellow — RGB 0xFFFF / 0xFFFF / 0xCCCC. RGBForeColor expects
 * RGBColor with 16-bit channels, so each component spans 0..0xFFFF.
 * Not const: the Toolbox's RGBForeColor / RGBBackColor signatures
 * take a non-const RGBColor* and the Retro68 headers don't bend on
 * that. */
static RGBColor kPaperYellow = { 0xFFFF, 0xFFFF, 0xCCCC };
static RGBColor kInkBlack    = { 0x0000, 0x0000, 0x0000 };

static const unsigned char kTitle[] = {
    11, 'S','t','i','c','k','y',' ','N','o','t','e'
};

static const unsigned char kStarter[] = {
    63,
    'C','l','i','c','k',' ','a','n','y','w','h','e','r','e',' ',
    't','o',' ','t','y','p','e','.',13,
    13,
    'D','r','a','g',' ','b','y',' ','t','h','e',' ','t','i','t','l',
    'e',' ','b','a','r','.',' ',' ','C','l','o','s','e',' ','t','o',' ','q','u','i','t','.'
};

static TEHandle gTE = NULL;
static WindowPtr gWin = NULL;
/* Using 0 instead of FALSE — Retro68 headers don't reliably expose
 * the FALSE macro at file scope across all SDKs we target. 0 is the
 * portable Boolean false in C. */
static Boolean gDone = 0;

/* Paint the yellow paper + the title row. Called from the update event
 * before TEUpdate so the editor draws over the paper, not the other
 * way around. */
static void DrawChrome(void) {
    RGBColor saveFG, saveBG;
    GetForeColor(&saveFG);
    GetBackColor(&saveBG);

    /* Fill the whole port with pale yellow. RGBBackColor sticks for
     * the lifetime of the port so subsequent EraseRect calls (TextEdit
     * uses one internally) preserve the look. */
    RGBBackColor(&kPaperYellow);
    EraseRect(&gWin->portRect);

    /* Title row — Chicago 12 bold, centred horizontally. */
    RGBForeColor(&kInkBlack);
    TextFont(0);          /* system font (Chicago in classic Mac) */
    TextFace(bold);
    TextSize(12);
    short titleW = StringWidth(kTitle);
    short cx = (gWin->portRect.right - gWin->portRect.left - titleW) / 2;
    MoveTo(cx, 16);
    DrawString(kTitle);

    /* Thin ink rule under the title so the body reads as a separate
     * pane. */
    MoveTo(gWin->portRect.left + 4, 22);
    LineTo(gWin->portRect.right - 4, 22);

    /* Reset face for whatever draws next. We don't switch back to a
     * specific font here — the editor field below sets its own when
     * TextEdit draws. */
    TextFace(0);
    TextSize(12);
    RGBForeColor(&saveFG);
    RGBBackColor(&saveBG);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);

    /* TE field sits below the title row, 6 px inset on all other sides. */
    Rect te;
    te.top    = 28;
    te.left   = gWin->portRect.left + 6;
    te.right  = gWin->portRect.right - 6;
    te.bottom = gWin->portRect.bottom - 6;
    gTE = TENew(&te, &te);
    if (!gTE) { SysBeep(10); return 1; }
    TESetText((Ptr)&kStarter[1], (long)kStarter[0], gTE);
    TESetSelect(0x7FFF, 0x7FFF, gTE);
    TEActivate(gTE);

    ShowWindow(gWin);

    while (!gDone) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                switch (part) {
                    case inContent:
                        if (w == gWin) {
                            Point local = ev.where;
                            GlobalToLocal(&local);
                            /* Treat clicks above the title rule as
                             * focus-only (no caret move) so the rule
                             * itself doesn't feel like a hidden text
                             * region. */
                            if (local.v >= 28) {
                                TEClick(local, (ev.modifiers & shiftKey) != 0, gTE);
                            }
                        }
                        break;
                    case inDrag: {
                        Rect bounds = qd.screenBits.bounds;
                        bounds.top += 20;
                        DragWindow(w, ev.where, &bounds);
                        break;
                    }
                    case inGoAway:
                        if (TrackGoAway(w, ev.where)) gDone = 1;
                        break;
                }
                break;
            }
            case keyDown:
            case autoKey:
                if (gTE) TEKey((char)(ev.message & charCodeMask), gTE);
                break;
            case activateEvt:
                if ((WindowPtr)ev.message == gWin && gTE) {
                    if (ev.modifiers & activeFlag) TEActivate(gTE);
                    else TEDeactivate(gTE);
                }
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    DrawChrome();
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
