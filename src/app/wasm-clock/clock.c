/*
 * clock.c — analog desk clock with a digital readout (cv-mac #125).
 *
 * Demonstrates a different Toolbox slice from the other samples:
 *   - GetDateTime + SecondsToDate -> hour / minute / second fields
 *     (the classic Mac time API; pre-Carbon, no struct tm).
 *   - FrameOval to draw the clock face, MoveTo + LineTo for hands,
 *     and FillOval for the centre pivot — pure QuickDraw.
 *   - 60-tick (~1-second) WaitNextEvent timeout so the second hand
 *     advances without busy-waiting; idle events recompute and
 *     redraw only the hand region for a flicker-free tick.
 *   - NumToString + Pascal-string concat to compose the 12-hour
 *     digital readout "h:mm:ss am/pm" under the dial.
 *
 * Trigonometry: the clock uses a tiny precomputed sine/cosine table
 * (one entry every 6 degrees -> 60 entries) instead of pulling in
 * libm — keeps the build tiny and avoids fp/long-double issues some
 * Retro68 sysroots have with sin/cos on 68k.
 *
 * Pairs with clock.r (WIND 128, 200x230, SIZE -1, signature 'CVCK').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <OSUtils.h>   /* GetDateTime, SecondsToDate */
#include <Events.h>

#define kWindowID 128
#define kFaceMargin 12      /* px inset from window edge to clock face */
#define kFaceSize 160       /* clock face diameter in px */
#define kReadoutY 200       /* y of the digital readout baseline */

QDGlobals qd;

static WindowPtr gWin = NULL;
static short gLastSec = -1;  /* skip redraw when the second hasn't changed */

/* Precomputed sin/cos table — index i corresponds to 6*i degrees from
 * 12 o'clock (i.e. straight up, going clockwise). Scaled to 1024 so we
 * can stay in fixed-point integer math throughout the renderer. */
static const short kSinTable[60] = {
       0,  107,  213,  316,  416,  512,  603,  688,  766,  837,
     900,  955, 1002, 1041, 1071, 1092, 1105, 1109, 1105, 1092,
    1071, 1041, 1002,  955,  900,  837,  766,  688,  603,  512,
     416,  316,  213,  107,    0, -107, -213, -316, -416, -512,
    -603, -688, -766, -837, -900, -955,-1002,-1041,-1071,-1092,
   -1105,-1109,-1105,-1092,-1071,-1041,-1002, -955, -900, -837
};
/* cos(theta) = sin(theta + 90deg). 90deg = 15 entries (each is 6deg). */
static short SinIdx(short i) {
    while (i < 0) i += 60;
    while (i >= 60) i -= 60;
    return kSinTable[i];
}
static short CosIdx(short i) { return SinIdx(i + 15); }

static void DrawHand(short cx, short cy, short minutesOf60, short length) {
    /* Index 0 is straight up (12 o'clock). Sin gives the x-offset,
     * cos gives -y-offset (screen y goes down, clock y goes up). */
    long sx = (long)SinIdx(minutesOf60) * length / 1024;
    long sy = (long)CosIdx(minutesOf60) * length / 1024;
    MoveTo(cx, cy);
    LineTo(cx + (short)sx, cy - (short)sy);
}

static void DrawFace(void) {
    Rect face;
    face.left   = kFaceMargin;
    face.top    = kFaceMargin;
    face.right  = kFaceMargin + kFaceSize;
    face.bottom = kFaceMargin + kFaceSize;
    EraseRect(&face);
    FrameOval(&face);

    /* Hour ticks: 12 short marks at the 12 hour positions. */
    short cx = kFaceMargin + kFaceSize / 2;
    short cy = kFaceMargin + kFaceSize / 2;
    short outer = kFaceSize / 2 - 2;
    short inner = outer - 6;
    for (short h = 0; h < 12; h++) {
        short idx = h * 5;  /* 12 marks at 5-minute intervals */
        long ox = (long)SinIdx(idx) * outer / 1024;
        long oy = (long)CosIdx(idx) * outer / 1024;
        long ix = (long)SinIdx(idx) * inner / 1024;
        long iy = (long)CosIdx(idx) * inner / 1024;
        MoveTo(cx + (short)ox, cy - (short)oy);
        LineTo(cx + (short)ix, cy - (short)iy);
    }
}

static void DrawHands(short hour, short minute, short second) {
    short cx = kFaceMargin + kFaceSize / 2;
    short cy = kFaceMargin + kFaceSize / 2;
    short faceR = kFaceSize / 2 - 4;

    /* Wipe the inside of the face (leave the rim + hour marks alone).
     * Simpler than fork-aware dirty-rect bookkeeping for a 1-second tick. */
    Rect inner;
    inner.left   = cx - faceR + 8;
    inner.top    = cy - faceR + 8;
    inner.right  = cx + faceR - 8;
    inner.bottom = cy + faceR - 8;
    EraseRect(&inner);

    /* Hour hand: 30deg per hour + a sub-hour fraction from minutes.
     * 360deg = 60 table entries, so 30deg = 5 entries. Hour fraction
     * adds (5 * minute / 60) entries. */
    short hourIdx = (hour % 12) * 5 + minute / 12;
    DrawHand(cx, cy, hourIdx, faceR * 5 / 10);

    /* Minute hand: one entry per minute, longer + thinner. */
    PenSize(2, 2);
    DrawHand(cx, cy, minute, faceR * 8 / 10);
    PenSize(1, 1);

    /* Second hand. */
    DrawHand(cx, cy, second, faceR * 9 / 10);

    /* Centre pivot. */
    Rect pivot;
    pivot.left = cx - 3; pivot.top = cy - 3;
    pivot.right = cx + 3; pivot.bottom = cy + 3;
    FillOval(&pivot, &qd.black);
}

static void AppendNum(unsigned char *out, short value, Boolean twoDigit) {
    Str255 buf;
    NumToString(value, buf);
    if (twoDigit && buf[0] == 1) {
        /* Pad single-digit minutes/seconds with a leading 0. */
        out[++out[0]] = '0';
    }
    for (short i = 1; i <= buf[0]; i++) out[++out[0]] = buf[i];
}

static void DrawReadout(short hour, short minute, short second) {
    /* Digital readout — "h:mm:ss am/pm" centred under the dial. */
    Rect rd;
    rd.left = 0;
    rd.top = kReadoutY - 14;
    rd.right = kFaceMargin * 2 + kFaceSize;
    rd.bottom = kReadoutY + 2;
    EraseRect(&rd);

    Str255 buf;
    buf[0] = 0;
    short displayHour = hour % 12;
    if (displayHour == 0) displayHour = 12;
    Boolean pm = (hour >= 12);
    AppendNum(buf, displayHour, false);
    buf[++buf[0]] = ':';
    AppendNum(buf, minute, true);
    buf[++buf[0]] = ':';
    AppendNum(buf, second, true);
    buf[++buf[0]] = ' ';
    buf[++buf[0]] = pm ? 'p' : 'a';
    buf[++buf[0]] = 'm';

    TextFont(0);
    TextSize(12);
    short w = StringWidth(buf);
    short x = (kFaceMargin * 2 + kFaceSize - w) / 2;
    MoveTo(x, kReadoutY);
    DrawString(buf);
}

static void Tick(void) {
    unsigned long secs;
    DateTimeRec dt;
    GetDateTime(&secs);
    SecondsToDate(secs, &dt);
    if (dt.second == gLastSec) return;
    gLastSec = dt.second;
    DrawHands(dt.hour, dt.minute, dt.second);
    DrawReadout(dt.hour, dt.minute, dt.second);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitCursor();

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);

    /* Initial paint. */
    DrawFace();
    Tick();
    ShowWindow(gWin);

    while (1) {
        EventRecord ev;
        /* 60-tick timeout = ~1 second on the classic 60Hz Mac clock. */
        WaitNextEvent(everyEvent, &ev, 60, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inGoAway && w == gWin && TrackGoAway(w, ev.where)) return 0;
                if (part == inDrag) {
                    Rect b = qd.screenBits.bounds;
                    b.top += 20;
                    DragWindow(w, ev.where, &b);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    DrawFace();
                    gLastSec = -1;   /* force redraw */
                    Tick();
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                Tick();
                break;
        }
    }
}
