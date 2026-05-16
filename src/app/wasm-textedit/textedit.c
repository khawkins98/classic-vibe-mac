/*
 * textedit.c — Tiny TextEdit demo and foundation for a future word
 * processor (cv-mac #125).
 *
 * Demonstrates:
 *   - Toolbox TextEdit: create a TEHandle bound to a destRect/viewRect,
 *     route keystrokes via TEKey, mouse clicks via TEClick, and let it
 *     handle wrapping/scrolling/selection drawing itself.
 *   - Update events that call TEUpdate so the text re-paints when the
 *     window is exposed or resized.
 *   - Idle events that blink the caret via TEIdle.
 *   - Close-box exit: clicking the close box (goAway) returns 0.
 *
 * This is intentionally minimal — no file I/O, no menus, no font
 * picker. It's the ladder rung between "a window with a static
 * DrawString" (Hello Window) and "a working notepad-style editor".
 * Once File menu + TESave/TEFromScrap land, this evolves into a
 * little word processor (NotePad / WordPad style).
 *
 * Pairs with textedit.r (WIND 128 + SIZE -1 + signature 'CVTE').
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

/* ← try changing this starter text! Rewrite the bytes (and update the
 * leading length byte to match the new length) and Build & Run — the
 * new text appears in the editor field on launch. */
static const unsigned char SAMPLE_PSTR[] = {
    71,
    'T','y','p','e',' ','i','n','t','o',' ','t','h','i','s',' ',
    'w','i','n','d','o','w',' ','-','-',' ','t','h','e',' ','b',
    'r','o','w','s','e','r',' ','c','o','m','p','i','l','e','d',
    ' ','i','t',' ','f','o','r',' ','y','o','u','.',13,
    13,
    'P','r','e','s','s',' ','c','l','i','c','k',' ','t','o',' '
};

static const unsigned char SAMPLE_LINE2[] = {
    14,
    'q','u','i','t',' ','t','h','i','s',' ','d','e','m','o','.'
};

int main(void) {
    /* Standard Toolbox init. */
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();

    /* Load the WIND 128 declared in textedit.r. */
    WindowPtr win = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!win) {
        SysBeep(10);
        return 1;
    }
    SetPort((GrafPtr)win);
    ShowWindow(win);

    /* TextEdit field. destRect is where text is *drawn*; viewRect is
     * what's *visible* — making them identical gives us a non-scrolling
     * edit field that fills the window with a small margin. */
    Rect r;
    r.top    = win->portRect.top + 8;
    r.left   = win->portRect.left + 8;
    r.bottom = win->portRect.bottom - 8;
    r.right  = win->portRect.right - 8;

    TEHandle te = TENew(&r, &r);
    if (!te) {
        SysBeep(10);
        return 1;
    }

    /* Seed with sample text so it's obvious the field is editable. */
    TESetText((Ptr)&SAMPLE_PSTR[1], (long)SAMPLE_PSTR[0], te);
    TESetSelect(0x7FFF, 0x7FFF, te);  /* place cursor at end */
    TEInsert((Ptr)&SAMPLE_LINE2[1], (long)SAMPLE_LINE2[0], te);
    TEActivate(te);

    /* Event loop. WaitNextEvent(60-tick sleep) gives TEIdle enough
     * granularity to blink the caret without burning CPU. */
    for (;;) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);

        switch (ev.what) {
            case mouseDown: {
                WindowPtr clickWin;
                short part = FindWindow(ev.where, &clickWin);
                if (part == inContent && clickWin == win) {
                    Point local = ev.where;
                    GlobalToLocal(&local);
                    Boolean shiftDown = (ev.modifiers & shiftKey) != 0;
                    TEClick(local, shiftDown, te);
                } else if (part == inGoAway && clickWin == win) {
                    if (TrackGoAway(win, ev.where)) {
                        TEDispose(te);
                        return 0;
                    }
                } else if (part == inDrag && clickWin == win) {
                    /* Allow dragging the window around. The boundary
                     * rect is the desktop port rect minus a small
                     * inset so the title bar always stays grabbable. */
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;  /* below menu bar */
                    DragWindow(win, ev.where, &bounds);
                }
                break;
            }
            case keyDown:
            case autoKey: {
                char ch = (char)(ev.message & charCodeMask);
                TEKey(ch, te);
                break;
            }
            case activateEvt:
                if ((WindowPtr)ev.message == win) {
                    if (ev.modifiers & activeFlag) {
                        TEActivate(te);
                    } else {
                        TEDeactivate(te);
                    }
                }
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == win) {
                    BeginUpdate(win);
                    EraseRect(&win->portRect);
                    TEUpdate(&win->portRect, te);
                    EndUpdate(win);
                }
                break;
            case nullEvent:
                TEIdle(te);
                break;
        }
    }
    return 0;
}
