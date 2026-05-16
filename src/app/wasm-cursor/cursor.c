/*
 * cursor.c — region-driven Cursor Manager demo (cv-mac).
 *
 * The window is divided into four labelled quadrants. As the mouse
 * crosses between quadrants, the cursor swaps to whatever each
 * region's caption advertises:
 *
 *   top-left      arrow      (Apple default — the system's startup cursor)
 *   top-right     I-beam     (TextEdit's typing cursor — IBeamCursor())
 *   bottom-left   watch      (busy / wait — GetCursor(watchCursor))
 *   bottom-right  cross-hair (precision / select — GetCursor(crossCursor))
 *
 * Outside the window (in the desktop port) we restore the arrow so
 * the cursor stays predictable when leaving the app's region. The
 * caption inside each quadrant tells you which cursor you're about
 * to see, so the swap is observable even on systems that animate
 * cursor changes slowly.
 *
 * Pairs with cursor.r (WIND 128 + SIZE -1 + signature 'CVCR').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Events.h>
#include <ToolUtils.h>   /* GetCursor */

#define kWindowID 128

/* Standard resource IDs the System file ships for these cursors. */
#define kWatchID  4   /* watch / hourglass */
#define kCrossID  2   /* crosshair */

QDGlobals qd;

static WindowPtr gWin = NULL;
static short gCurrent = -1;   /* last-set cursor index; -1 = none */
static Boolean gDone = 0;

static void DrawCaption(short cx, short cy, const unsigned char *label) {
    short w = StringWidth(label);
    MoveTo(cx - w / 2, cy);
    DrawString(label);
}

static void DrawWindow(void) {
    Rect r = gWin->portRect;
    EraseRect(&r);
    /* Frame the four quadrants. */
    short midX = (r.right + r.left) / 2;
    short midY = (r.bottom + r.top) / 2;
    MoveTo(midX, r.top);    LineTo(midX, r.bottom);
    MoveTo(r.left, midY);   LineTo(r.right, midY);
    FrameRect(&r);

    TextFont(0);
    TextSize(12);
    unsigned char l1[] = { 5, 'a','r','r','o','w' };
    unsigned char l2[] = { 6, 'I','-','b','e','a','m' };
    unsigned char l3[] = { 5, 'w','a','t','c','h' };
    unsigned char l4[] = { 10, 'c','r','o','s','s','-','h','a','i','r' };
    DrawCaption(midX / 2, midY / 2, l1);
    DrawCaption(midX + (r.right - midX) / 2, midY / 2, l2);
    DrawCaption(midX / 2, midY + (r.bottom - midY) / 2, l3);
    DrawCaption(midX + (r.right - midX) / 2, midY + (r.bottom - midY) / 2, l4);

    /* Header / hint. */
    unsigned char hint[] = {
        24,
        'M','o','v','e',' ','m','o','u','s','e',' ','i','n','t','o',
        ' ','a',' ','q','u','a','d','r','a','n','t'
    };
    DrawCaption((r.right + r.left) / 2, r.top + 14, hint);
}

/* Which quadrant is the local point in? 0..3 clockwise from top-left,
 * or -1 if we're outside the inner area. */
static short QuadrantFor(Point p) {
    Rect r = gWin->portRect;
    if (!PtInRect(p, &r)) return -1;
    short midX = (r.right + r.left) / 2;
    short midY = (r.bottom + r.top) / 2;
    if (p.h < midX && p.v < midY) return 0;  /* TL */
    if (p.h >= midX && p.v < midY) return 1; /* TR */
    if (p.h < midX && p.v >= midY) return 2; /* BL */
    return 3;                                 /* BR */
}

static void SetCursorFor(short idx) {
    if (idx == gCurrent) return;
    gCurrent = idx;
    switch (idx) {
        case 0:  InitCursor();        break;  /* arrow */
        case 1: {
            CursHandle c = GetCursor(iBeamCursor);
            if (c) SetCursor(*c);
            break;
        }
        case 2: {
            CursHandle c = GetCursor(kWatchID);
            if (c) SetCursor(*c);
            break;
        }
        case 3: {
            CursHandle c = GetCursor(kCrossID);
            if (c) SetCursor(*c);
            break;
        }
        default:
            /* Outside the window: arrow. */
            InitCursor();
            break;
    }
}

/* Each null-tick we sample the mouse and adjust the cursor — this
 * is the canonical "mouse region tracking" pattern from IM:Toolbox
 * (the Mac has no enter/leave events; you poll). */
static void TrackMouse(void) {
    Point mouse;
    GetMouse(&mouse);
    /* GetMouse returns LOCAL coords for the current port. SetPort'd
     * gWin so we're already in window-local space — good. */
    short q = QuadrantFor(mouse);
    SetCursorFor(q);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitCursor();

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);
    ShowWindow(gWin);
    DrawWindow();

    while (!gDone) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 6, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inGoAway && w == gWin && TrackGoAway(w, ev.where)) gDone = 1;
                else if (part == inDrag && w == gWin) {
                    Rect b = qd.screenBits.bounds;
                    b.top += 20;
                    DragWindow(w, ev.where, &b);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    DrawWindow();
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                TrackMouse();
                break;
        }
    }
    return 0;
}
