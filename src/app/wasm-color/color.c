/*
 * color.c — Color QuickDraw RGBForeColor demo (cv-mac #125).
 *
 * Different surface from the existing (1-bit-only) samples. If the
 * emulator's video mode supports it, this draws a horizontal stripe
 * of six classic Mac OS colors (the original 1990 Macintosh II
 * 8-colour palette) using RGBForeColor + PaintRect. Each stripe is
 * labelled with its colour name.
 *
 * On a 1-bit-only system the RGB values are rounded to black or white
 * by the QuickDraw colour-quantisation path, so the output degrades
 * gracefully — every stripe just becomes black or white depending on
 * brightness. No special-case needed; this is the documented Mac
 * behaviour from Inside Mac: Imaging With QuickDraw, ch. 1 ("Color
 * QuickDraw").
 *
 * Toolbox surfaces:
 *   - RGBColor record { red, green, blue } — each 16-bit
 *   - RGBForeColor / RGBBackColor — set foreground / background
 *   - PaintRect with the current foreground colour
 *   - ForeColor(blackColor) to reset to monochrome
 *
 * Pairs with color.r (WIND 128 + SIZE -1 + signature 'CVCR').
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

#define STRIPE_W  46
#define STRIPE_H 100
#define STRIPE_TOP 30
#define STRIPE_LEFT 12
#define STRIPE_GAP 2

QDGlobals qd;

static WindowPtr gWin = NULL;

/* Six colours in the canonical 1990 Macintosh II 8-colour palette
 * (we omit black + white which are the implicit edge cases). Each
 * RGBColor field is 0..65535. The mapping is:
 *   red    = (0xFFFF, 0,      0)
 *   yellow = (0xFFFF, 0xFFFF, 0)
 *   green  = (0,      0xFFFF, 0)
 *   cyan   = (0,      0xFFFF, 0xFFFF)
 *   blue   = (0,      0,      0xFFFF)
 *   magenta= (0xFFFF, 0,      0xFFFF)
 */
static const RGBColor PALETTE[6] = {
    { 0xFFFF, 0x0000, 0x0000 },  /* red */
    { 0xFFFF, 0xFFFF, 0x0000 },  /* yellow */
    { 0x0000, 0xFFFF, 0x0000 },  /* green */
    { 0x0000, 0xFFFF, 0xFFFF },  /* cyan */
    { 0x0000, 0x0000, 0xFFFF },  /* blue */
    { 0xFFFF, 0x0000, 0xFFFF },  /* magenta */
};
static const char *const NAMES[6] = {
    "red", "yel", "grn", "cyn", "blu", "mag"
};

static void PStringFromC(const char *src, unsigned char *out) {
    short n = 0;
    while (src[n] && n < 254) n++;
    out[0] = (unsigned char)n;
    for (short i = 0; i < n; i++) out[i + 1] = (unsigned char)src[i];
}

static void DrawStripes(void) {
    EraseRect(&gWin->portRect);
    /* Title line in black. */
    ForeColor(blackColor);
    unsigned char title[] = {
        29,
        'C','o','l','o','r',' ','Q','u','i','c','k','D','r','a','w',' ',
        'R','G','B','F','o','r','e','C','o','l','o','r'
    };
    MoveTo(12, 18);
    DrawString(title);

    for (short i = 0; i < 6; i++) {
        Rect sw;
        sw.left = STRIPE_LEFT + i * (STRIPE_W + STRIPE_GAP);
        sw.top  = STRIPE_TOP;
        sw.right = sw.left + STRIPE_W;
        sw.bottom = sw.top + STRIPE_H;
        RGBColor c = PALETTE[i];
        RGBForeColor(&c);
        PaintRect(&sw);
        /* Frame + label in black. */
        ForeColor(blackColor);
        FrameRect(&sw);
        unsigned char lbl[8];
        PStringFromC(NAMES[i], lbl);
        short w = StringWidth(lbl);
        MoveTo(sw.left + (STRIPE_W - w) / 2, sw.bottom + 14);
        DrawString(lbl);
    }
    /* Reset for any subsequent drawing. */
    ForeColor(blackColor);
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
    DrawStripes();

    Boolean done = false;
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    /* Click to redraw — vehicle for proving the
                     * event loop is alive. */
                    DrawStripes();
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
                    DrawStripes();
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
