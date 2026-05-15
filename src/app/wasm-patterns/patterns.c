/*
 * patterns.c — QuickDraw 8x8 dither-pattern gallery (cv-mac #125).
 *
 * Fills the Bitmaps / Pattern coverage gap. Different surface from
 * the existing samples:
 *
 *   - Custom Pattern construction (8-byte 1-bit bitmap)
 *   - FillRect with a Pattern arg
 *   - The Toolbox's system patterns: gray, ltGray, dkGray, white
 *     (declared by InitGraf as part of QDGlobals — see Inside Mac:
 *     Imaging With QuickDraw, "Patterns")
 *
 * Renders a 4×3 grid of 60×60 swatches, each filled with a distinct
 * pattern + labelled. Click anywhere in the body to redraw (mostly
 * a vehicle for proving the event loop is alive).
 *
 * Pairs with patterns.r (WIND 128 + SIZE -1 + signature 'CVPT').
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

#define SWATCH_W 60
#define SWATCH_H 60
#define COL_COUNT 4
#define ROW_COUNT 3
#define GUTTER_X 12
#define GUTTER_Y 30
#define LABEL_GAP 14
#define ORIGIN_X 16
#define ORIGIN_Y 20

QDGlobals qd;

/* Twelve patterns. The first four use QuickDraw's built-in globals
 * (white, ltGray, gray, dkGray — declared by InitGraf as part of
 * QDGlobals). The rest are hand-rolled 8x8 bitmaps. Each byte = 8
 * pixels of one row, MSB on the left. Familiar to anyone who has
 * flipped through ResEdit's Pattern editor. */
static const Pattern gCustomPatterns[8] = {
    /* horizontal stripes (1 of every 2 rows) */
    {{ 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00, 0xFF, 0x00 }},
    /* vertical stripes */
    {{ 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA, 0xAA }},
    /* diagonal stripes \\ */
    {{ 0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01 }},
    /* diagonal stripes // */
    {{ 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80 }},
    /* fine checkerboard */
    {{ 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA }},
    /* sparse dots */
    {{ 0x88, 0x00, 0x22, 0x00, 0x88, 0x00, 0x22, 0x00 }},
    /* bricks */
    {{ 0xFF, 0x80, 0x80, 0x80, 0xFF, 0x08, 0x08, 0x08 }},
    /* tartan-ish weave */
    {{ 0xFF, 0x44, 0x44, 0x44, 0x55, 0xAA, 0x55, 0xAA }},
};

static const char *const LABELS[12] = {
    "white", "ltGray", "gray", "dkGray",
    "h-stripes", "v-stripes", "diag \\", "diag /",
    "checker", "dots", "bricks", "tartan",
};

static WindowPtr gWin = NULL;

static void PStringFromC(const char *src, unsigned char *out) {
    short n = 0;
    while (src[n] && n < 254) n++;
    out[0] = (unsigned char)n;
    for (short i = 0; i < n; i++) out[i + 1] = (unsigned char)src[i];
}

static void GetSwatchPattern(short idx, Pattern *out) {
    switch (idx) {
        case 0: *out = qd.white;  break;
        case 1: *out = qd.ltGray; break;
        case 2: *out = qd.gray;   break;
        case 3: *out = qd.dkGray; break;
        default: *out = gCustomPatterns[idx - 4]; break;
    }
}

static void DrawGallery(void) {
    EraseRect(&gWin->portRect);
    /* Centred title at the top. */
    unsigned char title[40];
    PStringFromC("QuickDraw patterns", title);
    MoveTo(16, 14);
    DrawString(title);

    for (short i = 0; i < COL_COUNT * ROW_COUNT; i++) {
        short col = i % COL_COUNT;
        short row = i / COL_COUNT;
        Rect sw;
        sw.left   = ORIGIN_X + col * (SWATCH_W + GUTTER_X);
        sw.top    = ORIGIN_Y + row * (SWATCH_H + GUTTER_Y);
        sw.right  = sw.left + SWATCH_W;
        sw.bottom = sw.top + SWATCH_H;
        Pattern pat;
        GetSwatchPattern(i, &pat);
        FillRect(&sw, &pat);
        FrameRect(&sw);
        /* Label under the swatch. */
        unsigned char lbl[40];
        PStringFromC(LABELS[i], lbl);
        short txtW = StringWidth(lbl);
        MoveTo(sw.left + (SWATCH_W - txtW) / 2, sw.bottom + LABEL_GAP);
        DrawString(lbl);
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
    ShowWindow(gWin);
    DrawGallery();

    Boolean done = false;
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    /* Click in the body to redraw — proves the event
                     * loop is alive. */
                    DrawGallery();
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
                    DrawGallery();
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
