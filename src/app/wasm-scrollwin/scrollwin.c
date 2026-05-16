/*
 * scrollwin.c — Scrollable list demo (cv-mac #125).
 *
 * Fills the Controls / scroll-bar coverage gap the sample-shelf review
 * identified. New Toolbox surface vs the other wasm-* samples:
 *
 *   - NewControl(scrollBarProc)         — instantiate a CDEF 16 scroll bar
 *   - TrackControl(...) + actionProc    — handle thumb drag + arrow / page
 *                                         clicks via a live actionProc
 *   - GetControlValue / SetControlValue — read + write the scroll position
 *   - SetControlMinimum / SetControlMaximum — set the scroll range
 *
 * Renders 50 list items in a 200×220 viewport. The scroll bar lives in
 * the canonical right-edge gutter (15 px wide). Scrolling shifts the
 * draw offset; arrow buttons step by one item, page-up/page-down steps
 * by viewport height, thumb-drag jumps directly.
 *
 * Pairs with scrollwin.r (WIND 128 with smaller-than-default growIcon
 * room since we own the right edge, SIZE -1, signature 'CVSW').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <Controls.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Memory.h>

#define kWindowID 128
#define kScrollBarID 1000

#define ITEM_COUNT 50
#define ITEM_HEIGHT 16
#define SCROLLBAR_WIDTH 15
#define LIST_LEFT 8
#define LIST_TOP 6
#define LIST_RIGHT (300 - SCROLLBAR_WIDTH - 8)

QDGlobals qd;

static WindowPtr gWin = NULL;
static ControlHandle gScroll = NULL;
static short gFirstVisible = 0;

/* Computed-on-demand: how many full items fit vertically. */
static short VisibleCount(void) {
    short listH = gWin->portRect.bottom - LIST_TOP - SCROLLBAR_WIDTH;
    return listH / ITEM_HEIGHT;
}

static void DrawListBody(void) {
    Rect list;
    list.left = LIST_LEFT;
    list.top = LIST_TOP;
    list.right = LIST_RIGHT;
    list.bottom = gWin->portRect.bottom - SCROLLBAR_WIDTH;
    EraseRect(&list);
    FrameRect(&list);
    short visible = VisibleCount();
    short last = gFirstVisible + visible;
    if (last > ITEM_COUNT) last = ITEM_COUNT;
    for (short i = gFirstVisible; i < last; i++) {
        short y = LIST_TOP + (i - gFirstVisible) * ITEM_HEIGHT + 12;
        MoveTo(LIST_LEFT + 6, y);
        /* Compose "Item N" via NumToString — no sprintf in classic
         * Mac Toolbox. Pascal strings throughout. */
        unsigned char prefix[] = { 5, 'I','t','e','m',' ' };
        unsigned char num[16];
        NumToString(i + 1, num);
        DrawString(prefix);
        DrawString(num);
    }
}

static void UpdateScrollRange(void) {
    short visible = VisibleCount();
    short maxVal = ITEM_COUNT - visible;
    if (maxVal < 0) maxVal = 0;
    SetControlMinimum(gScroll, 0);
    SetControlMaximum(gScroll, maxVal);
    if (gFirstVisible > maxVal) gFirstVisible = maxVal;
    SetControlValue(gScroll, gFirstVisible);
}

static void Redraw(void) {
    EraseRect(&gWin->portRect);
    DrawListBody();
    if (gScroll) DrawControls(gWin);
}

static void ScrollTo(short newFirst) {
    short maxVal = GetControlMaximum(gScroll);
    if (newFirst < 0) newFirst = 0;
    if (newFirst > maxVal) newFirst = maxVal;
    if (newFirst == gFirstVisible) return;
    gFirstVisible = newFirst;
    SetControlValue(gScroll, gFirstVisible);
    DrawListBody();
}

/* Live actionProc for TrackControl — called repeatedly while the user
 * holds the mouse on an arrow / page region. partCode tells us which
 * part of the scroll bar is being held. (For the thumb, TrackControl
 * uses NULL actionProc and we read the final value after.) */
static pascal void ScrollAction(ControlHandle ctl, short partCode) {
    if (!ctl) return;
    short delta = 0;
    switch (partCode) {
        case inUpButton:    delta = -1; break;
        case inDownButton:  delta = 1; break;
        case inPageUp:      delta = -VisibleCount(); break;
        case inPageDown:    delta = VisibleCount(); break;
        default: return;
    }
    ScrollTo(gFirstVisible + delta);
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
    TextFont(0); TextSize(12);
    ShowWindow(gWin);

    /* Scroll bar lives in the right gutter, from top to (bottom -
     * scrollbar width) so it doesn't overlap the grow box position
     * (we have no grow box; just leaves the corner empty). */
    Rect sbRect;
    sbRect.left   = gWin->portRect.right - SCROLLBAR_WIDTH;
    sbRect.top    = -1;  /* -1 so the top border merges with the window frame */
    sbRect.right  = gWin->portRect.right + 1;
    sbRect.bottom = gWin->portRect.bottom - SCROLLBAR_WIDTH + 1;
    gScroll = NewControl(gWin, &sbRect, "\p", true, 0, 0, 0,
                         scrollBarProc, kScrollBarID);
    if (!gScroll) { SysBeep(10); return 1; }

    UpdateScrollRange();
    Redraw();

    Boolean done = false;
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    Point local = ev.where;
                    GlobalToLocal(&local);
                    ControlHandle hit;
                    short partCode = FindControl(local, gWin, &hit);
                    if (hit == gScroll) {
                        if (partCode == inThumb) {
                            /* TrackControl with NULL actionProc lets
                             * the user drag the thumb; we read the
                             * final value after. */
                            TrackControl(gScroll, local, NULL);
                            ScrollTo(GetControlValue(gScroll));
                        } else if (partCode != 0) {
                            /* Arrow / page — let the actionProc fire
                             * repeatedly while the button is held. */
                            TrackControl(gScroll, local, ScrollAction);
                        }
                    }
                } else if (part == inGoAway && w == gWin) {
                    if (TrackGoAway(gWin, ev.where)) done = true;
                } else if (part == inDrag && w == gWin) {
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;
                    DragWindow(gWin, ev.where, &bounds);
                }
                break;
            }
            case keyDown:
            case autoKey: {
                char ch = (char)(ev.message & charCodeMask);
                if (ch == 30 || ch == 31) {
                    /* Up/Down arrow keystrokes scroll by one row. */
                    ScrollTo(gFirstVisible + (ch == 31 ? 1 : -1));
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    Redraw();
                    EndUpdate(gWin);
                }
                break;
            case activateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    if (ev.modifiers & activeFlag) {
                        ShowControl(gScroll);
                    } else {
                        HideControl(gScroll);
                    }
                }
                break;
        }
    }
    if (gScroll) DisposeControl(gScroll);
    return 0;
}
