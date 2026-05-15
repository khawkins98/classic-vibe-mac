/*
 * scribble.c — Mouse-tracking draw demo (cv-mac #125).
 *
 * Different Toolbox surface from the existing samples: no TextEdit,
 * no resource buttons, no game timing — just QuickDraw's classic
 * "drag the mouse to draw a line" loop. Demonstrates StillDown
 * polling, MoveTo / LineTo per pixel, and a click-to-clear gesture.
 *
 * The mouseDown event handler stays inside the drawing loop until
 * the user releases the button. Every iteration: poll GetMouse,
 * convert to local coords, LineTo the new point if it moved. This
 * is the standard Mac OS 7 "rubber-band-line" pattern straight from
 * Inside Macintosh: Macintosh Toolbox Essentials, ch. 1.
 *
 * Click the desktop (outside the window) to quit. Click in the
 * Clear button area (top-right of the window) to wipe and start
 * over. Drag in the rest of the window body to draw.
 *
 * Same Path B (in-browser C + WASM-Rez splice). Signature 'CVSC'.
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

/* Tiny "Clear" button in the top-right corner of the window. The
 * window itself is 300×220; this button is 56×20 at right=294,top=4. */
static Rect gClearRect;
static WindowPtr gWin = NULL;

static void DrawClearButton(void) {
    FrameRoundRect(&gClearRect, 6, 6);
    /* Centred "Clear" label. */
    unsigned char label[] = { 5, 'C', 'l', 'e', 'a', 'r' };
    short txtW = StringWidth(label);
    MoveTo(gClearRect.left + ((gClearRect.right - gClearRect.left) - txtW) / 2,
           gClearRect.top + 14);
    DrawString(label);
}

static void DrawHint(void) {
    /* One-line instruction below the Clear button, drawn once at
     * startup + on each Clear. Subtle, doesn't compete with the user's
     * scribbles since the user is expected to draw further down. */
    unsigned char hint[] = {
        24,
        'D','r','a','g',' ','i','n','s','i','d','e',' ','t','o',' ',
        'd','r','a','w','.',' ','C','l','i','c','k',' '
    };
    MoveTo(8, gClearRect.bottom + 14);
    DrawString(hint);
    unsigned char hint2[] = {
        21,
        'C','l','e','a','r',' ','t','o',' ','w','i','p','e',';',' ',
        'c','l','o','s','e',' ','='
    };
    DrawString(hint2);
    unsigned char hint3[] = { 5, ' ','q','u','i','t' };
    DrawString(hint3);
}

static void ClearDrawing(void) {
    Rect full = gWin->portRect;
    EraseRect(&full);
    DrawClearButton();
    DrawHint();
}

static void TrackDraw(Point startLocal) {
    Point cur = startLocal;
    MoveTo(cur.h, cur.v);
    /* Two-pixel filled dot at the start so a tap registers. */
    Rect dot;
    dot.left = cur.h - 1; dot.top = cur.v - 1;
    dot.right = cur.h + 1; dot.bottom = cur.v + 1;
    PaintRect(&dot);
    MoveTo(cur.h, cur.v);
    /* Poll while the mouse is down. StillDown returns false the moment
     * the button is released. GetMouse is in local coordinates (SetPort
     * already pointed us at gWin). */
    while (StillDown()) {
        Point now;
        GetMouse(&now);
        if (now.h != cur.h || now.v != cur.v) {
            LineTo(now.h, now.v);
            cur = now;
        }
    }
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

    /* Place the Clear button. */
    gClearRect.left = gWin->portRect.right - 64;
    gClearRect.top = 4;
    gClearRect.right = gWin->portRect.right - 8;
    gClearRect.bottom = 24;

    ShowWindow(gWin);
    ClearDrawing();

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
                    if (PtInRect(local, &gClearRect)) {
                        InvertRoundRect(&gClearRect, 6, 6);
                        unsigned long t = TickCount();
                        while (TickCount() - t < 6) { /* ~100 ms flash */ }
                        InvertRoundRect(&gClearRect, 6, 6);
                        ClearDrawing();
                    } else {
                        TrackDraw(local);
                    }
                } else if (part == inGoAway && w == gWin) {
                    if (TrackGoAway(gWin, ev.where)) done = true;
                } else if (part == inDrag && w == gWin) {
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;
                    DragWindow(gWin, ev.where, &bounds);
                } else if (part == inDesk) {
                    /* Click outside the window quits. Convenient
                     * because Scribble has no menus / no Cmd-Q. */
                    done = true;
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    /* Note: we don't replay strokes here — clicking
                     * Clear is the only way to wipe. Update events
                     * just redraw the chrome. */
                    DrawClearButton();
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
