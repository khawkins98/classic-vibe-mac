/*
 * bounce.c — Offscreen BitMap + CopyBits, no-flicker bouncing ball
 * (cv-mac #125).
 *
 * Fills the "Offscreen GWorld + CopyBits" coverage gap. Different
 * surface from the existing samples: instead of drawing directly to
 * the window port (which flashes between frames), this builds an
 * offscreen 1-bit BitMap, redraws into it every tick, then CopyBits
 * the whole buffer onto the window in one shot. Standard
 * double-buffer pattern that any animated Mac app from 1989 onwards
 * relied on.
 *
 *   1. NewPtr(rowBytes * height) for the offscreen pixel buffer
 *   2. Hand-construct a BitMap struct pointing at that buffer
 *   3. Each frame: SetPort to the offscreen, erase + draw, then
 *      SetPort back, CopyBits offscreen→window
 *   4. The visible window's port is touched exactly once per frame
 *      (by CopyBits), so the user never sees the in-progress draw
 *
 * (Strictly, NewGWorld is the Color QuickDraw way; we use the older
 * NewPtr+BitMap pattern because it always works on 68k System 7 and
 * needs no extra includes. Same end result. See `wasm-gworld` for
 * the modern System 7+ version — same visual outcome, different API.)
 *
 * Pairs with bounce.r (WIND 128 + SIZE -1 + signature 'CVBO').
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

/* Offscreen buffer dimensions. Must be a multiple of 16 wide so
 * rowBytes is a power of 2 and CopyBits is happiest. 240×180 fits
 * inside our 260×200 window with a small margin. */
#define BUF_W 240
#define BUF_H 180
#define BALL_R 12

QDGlobals qd;

static WindowPtr gWin = NULL;
static GrafPort gOffPort;        /* offscreen GrafPort */
static BitMap gOffBits;          /* offscreen BitMap */
static Ptr gOffData = NULL;      /* raw pixel buffer */

/* Ball state. */
static short gBallX = 30, gBallY = 30;
static short gVX = 4, gVY = 3;

static Boolean InitOffscreen(void) {
    /* rowBytes: bytes per scanline, padded to a 16-bit boundary. For
     * 1-bit: (BUF_W + 15) / 16 * 2.  For BUF_W=240: 30 bytes/row. */
    short rowBytes = ((BUF_W + 15) / 16) * 2;
    long size = (long)rowBytes * BUF_H;
    gOffData = NewPtr(size);
    if (!gOffData) return false;
    /* Construct the BitMap that points at our buffer. */
    gOffBits.baseAddr = gOffData;
    gOffBits.rowBytes = rowBytes;
    gOffBits.bounds.top = 0;
    gOffBits.bounds.left = 0;
    gOffBits.bounds.bottom = BUF_H;
    gOffBits.bounds.right = BUF_W;
    /* Open the offscreen port. SetPortBits points the port at our
     * BitMap; OpenPort initialises the bookkeeping (clipRgn, visRgn,
     * etc.). We OpenPort first then point it at our bits. */
    OpenPort(&gOffPort);
    SetPortBits(&gOffBits);
    /* portRect / clipRgn / visRgn already cover the BitMap's bounds. */
    return true;
}

static void DrawFrame(void) {
    /* All this drawing goes to the offscreen port. */
    SetPort(&gOffPort);
    Rect full = gOffBits.bounds;
    EraseRect(&full);
    /* Filled ball. */
    Rect ball;
    ball.left = gBallX - BALL_R;
    ball.top  = gBallY - BALL_R;
    ball.right  = gBallX + BALL_R;
    ball.bottom = gBallY + BALL_R;
    PaintOval(&ball);
    /* Frame the canvas so it's obvious where the offscreen ends. */
    FrameRect(&full);
}

static void BlitToWindow(void) {
    SetPort((GrafPtr)gWin);
    /* Center the offscreen inside the window content area, leaving
     * an 8 px gutter at the top for a status line. */
    Rect dst;
    dst.left = (gWin->portRect.right - BUF_W) / 2;
    dst.top  = 24;
    dst.right = dst.left + BUF_W;
    dst.bottom = dst.top + BUF_H;
    CopyBits(&gOffBits,
             &gWin->portBits,
             &gOffBits.bounds,
             &dst,
             srcCopy,
             NULL);
}

static void TickBall(void) {
    gBallX += gVX;
    gBallY += gVY;
    if (gBallX - BALL_R < 1)         { gBallX = 1 + BALL_R;          gVX = -gVX; }
    if (gBallX + BALL_R > BUF_W - 1) { gBallX = BUF_W - 1 - BALL_R; gVX = -gVX; }
    if (gBallY - BALL_R < 1)         { gBallY = 1 + BALL_R;          gVY = -gVY; }
    if (gBallY + BALL_R > BUF_H - 1) { gBallY = BUF_H - 1 - BALL_R; gVY = -gVY; }
}

static void DrawHeader(void) {
    SetPort((GrafPtr)gWin);
    Rect header;
    header.left = 0; header.top = 0;
    header.right = gWin->portRect.right; header.bottom = 22;
    EraseRect(&header);
    unsigned char title[] = {
        37,
        'O','f','f','s','c','r','e','e','n',' ','+',' ',
        'C','o','p','y','B','i','t','s',' ','-','-',' ',
        'c','l','i','c','k',' ','t','o',' ','q','u','i','t'
    };
    MoveTo(8, 15);
    DrawString(title);
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
    DrawHeader();
    if (!InitOffscreen()) {
        SysBeep(10);
        return 1;
    }

    Boolean done = false;
    unsigned long lastTick = TickCount();
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 1, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    /* Any content click exits — simpler than an Apple
                     * menu Quit for a demo. */
                    done = true;
                } else if (part == inGoAway && w == gWin) {
                    if (TrackGoAway(gWin, ev.where)) done = true;
                } else if (part == inDrag && w == gWin) {
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;
                    DragWindow(gWin, ev.where, &bounds);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    DrawHeader();
                    BlitToWindow();
                    EndUpdate(gWin);
                }
                break;
        }
        /* ~30 fps tick: 60 ticks/sec, advance every 2 ticks. */
        unsigned long now = TickCount();
        if ((unsigned long)(now - lastTick) >= 2) {
            lastTick = now;
            TickBall();
            DrawFrame();
            BlitToWindow();
        }
    }
    if (gOffData) DisposePtr(gOffData);
    return 0;
}
