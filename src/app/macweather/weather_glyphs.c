/*
 * weather_glyphs.c — 1-bit pixel-art weather glyphs drawn with QuickDraw.
 *
 * The glyph palette covers the WMO weather codes that open-meteo's
 * forecast endpoint emits in practice:
 *
 *   0      clear (sun)
 *   1-3    partly cloudy → cloudy
 *   45,48  fog
 *   51-67  drizzle / rain (light → heavy)
 *   71-77  snow
 *   80-82  rain showers
 *   85-86  snow showers
 *   95-99  thunderstorm
 *
 * We deliberately keep the artwork crude. The goal is "instantly readable
 * at 32x32, still distinguishable at 16x16", not Susan Kare. QuickDraw's
 * primitives are: FrameOval/PaintOval, Move/LineTo, FillRect, with a few
 * Pattern constants from Quickdraw.h for shading.
 *
 * All drawing happens in the current GrafPort. We save/restore pen state
 * so callers don't need to.
 */

#include <Quickdraw.h>
#include <Fonts.h>

#include "weather_glyphs.h"

/* ------------------------------------------------------------ helpers */

/* Set up a small filled circle rect — sun body, raindrop, etc. */
static void OvalRect(Rect *r, short cx, short cy, short rx, short ry)
{
    r->left   = cx - rx;
    r->top    = cy - ry;
    r->right  = cx + rx;
    r->bottom = cy + ry;
}

/* Draw a "ray" line from (cx, cy) outward by (dx, dy) starting at radius r1
 * and ending at radius r2. */
static void Ray(short cx, short cy, short dx, short dy, short r1, short r2)
{
    /* dx, dy are unit-ish vectors scaled by 10. */
    MoveTo(cx + (short)((long)dx * r1 / 10), cy + (short)((long)dy * r1 / 10));
    LineTo(cx + (short)((long)dx * r2 / 10), cy + (short)((long)dy * r2 / 10));
}

/* ------------------------------------------------------------ glyphs */

static void DrawSunGlyph(short x, short y, short size)
{
    short cx = (short)(x + size / 2);
    short cy = (short)(y + size / 2);
    short core = (short)(size / 5);
    short outer = (short)(size / 2 - 1);
    Rect r;
    /* core disk */
    OvalRect(&r, cx, cy, core, core);
    PaintOval(&r);
    /* 8 rays in compass directions, 10-unit normalized vectors:
     *   N (0,-10), NE (7,-7), E (10,0), SE (7,7),
     *   S (0,10), SW (-7,7), W (-10,0), NW (-7,-7) */
    PenSize(1, 1);
    short r1 = (short)(core + 1);
    short r2 = outer;
    Ray(cx, cy,   0, -10, r1, r2);
    Ray(cx, cy,   7,  -7, r1, r2);
    Ray(cx, cy,  10,   0, r1, r2);
    Ray(cx, cy,   7,   7, r1, r2);
    Ray(cx, cy,   0,  10, r1, r2);
    Ray(cx, cy,  -7,   7, r1, r2);
    Ray(cx, cy, -10,   0, r1, r2);
    Ray(cx, cy,  -7,  -7, r1, r2);
}

/* A puffy cloud — three overlapping ovals on a flat base. */
static void DrawCloudShape(short x, short y, short size, Boolean filled)
{
    short w  = size;
    short h  = (short)(size * 5 / 8);
    short ox = x;
    short oy = (short)(y + (size - h) / 2);
    Rect lobe;

    /* left lobe */
    lobe.left   = ox + 1;
    lobe.top    = oy + h / 4;
    lobe.right  = ox + w * 3 / 5;
    lobe.bottom = oy + h;
    if (filled) PaintOval(&lobe); else FrameOval(&lobe);

    /* middle (top) lobe */
    lobe.left   = ox + w / 4;
    lobe.top    = oy;
    lobe.right  = ox + w * 3 / 4;
    lobe.bottom = oy + h * 3 / 4;
    if (filled) PaintOval(&lobe); else FrameOval(&lobe);

    /* right lobe */
    lobe.left   = ox + w * 2 / 5;
    lobe.top    = oy + h / 4;
    lobe.right  = ox + w - 1;
    lobe.bottom = oy + h;
    if (filled) PaintOval(&lobe); else FrameOval(&lobe);

    if (!filled) {
        /* Add a flat baseline so the cloud reads as one shape. */
        MoveTo(ox + 2, oy + h - 1);
        LineTo(ox + w - 2, oy + h - 1);
    }
}

static void DrawCloudGlyph(short x, short y, short size)
{
    DrawCloudShape(x, y, size, /*filled=*/false);
}

static void DrawPartlyCloudyGlyph(short x, short y, short size)
{
    /* Sun in the upper-right, cloud in the lower-left. */
    short half = (short)(size * 2 / 3);
    DrawSunGlyph((short)(x + size - half),
                 (short)(y),
                 half);
    /* Erase a small notch inside the cloud area so the sun rays don't
     * poke through. Then draw the cloud on top. */
    DrawCloudShape((short)(x), (short)(y + size / 3), (short)(size * 3 / 4), true);
    /* Outline the cloud with a frame so it stays legible against the rays. */
    PenMode(srcXor);
    DrawCloudShape((short)(x), (short)(y + size / 3), (short)(size * 3 / 4), false);
    PenMode(srcCopy);
}

/* Three little vertical strokes under a cloud = rain. */
static void DrawRainGlyph(short x, short y, short size)
{
    DrawCloudGlyph(x, y, (short)(size * 3 / 4));
    short cy = (short)(y + size * 3 / 4);
    short step = (short)(size / 5);
    if (step < 2) step = 2;
    short len = (short)(size / 4);
    if (len < 2) len = 2;
    for (short i = 0; i < 4; i++) {
        short rx = (short)(x + step + i * step);
        if (rx > x + size - 2) break;
        MoveTo(rx, cy);
        LineTo(rx, (short)(cy + len));
    }
}

static void DrawDrizzleGlyph(short x, short y, short size)
{
    /* Lighter rain — fewer + shorter dashes. */
    DrawCloudGlyph(x, y, (short)(size * 3 / 4));
    short cy = (short)(y + size * 3 / 4);
    short step = (short)(size / 4);
    if (step < 2) step = 2;
    short len = (short)(size / 6);
    if (len < 2) len = 2;
    for (short i = 0; i < 3; i++) {
        short rx = (short)(x + step + i * step);
        if (rx > x + size - 2) break;
        MoveTo(rx, cy);
        LineTo(rx, (short)(cy + len));
    }
}

/* Asterisks under a cloud = snow. */
static void DrawSnowGlyph(short x, short y, short size)
{
    DrawCloudGlyph(x, y, (short)(size * 3 / 4));
    short cy = (short)(y + size * 3 / 4 + size / 12);
    short step = (short)(size / 4);
    if (step < 3) step = 3;
    short s = (short)(size / 8);
    if (s < 2) s = 2;
    for (short i = 0; i < 3; i++) {
        short cx = (short)(x + step + i * step);
        if (cx > x + size - 2) break;
        /* + */
        MoveTo((short)(cx - s), cy);
        LineTo((short)(cx + s), cy);
        MoveTo(cx, (short)(cy - s));
        LineTo(cx, (short)(cy + s));
        /* x — only at larger sizes; skip if the glyph would smear. */
        if (size >= 24) {
            MoveTo((short)(cx - s + 1), (short)(cy - s + 1));
            LineTo((short)(cx + s - 1), (short)(cy + s - 1));
            MoveTo((short)(cx + s - 1), (short)(cy - s + 1));
            LineTo((short)(cx - s + 1), (short)(cy + s - 1));
        }
    }
}

/* Stacked horizontal lines = fog. */
static void DrawFogGlyph(short x, short y, short size)
{
    short cx = x;
    short top = (short)(y + size / 4);
    short rows = 4;
    short gap = (short)(size / (rows + 1));
    if (gap < 2) gap = 2;
    for (short i = 0; i < rows; i++) {
        short ry = (short)(top + i * gap);
        short indent = (short)((i & 1) ? (size / 8) : 0);
        MoveTo((short)(cx + indent + 1), ry);
        LineTo((short)(cx + size - indent - 1), ry);
    }
}

/* Cloud + lightning bolt zigzag. */
static void DrawThunderGlyph(short x, short y, short size)
{
    DrawCloudGlyph(x, y, (short)(size * 3 / 4));
    /* Zigzag bolt from cloud bottom downward. */
    short bx = (short)(x + size / 2);
    short by = (short)(y + size * 3 / 4 - 1);
    short s = (short)(size / 5);
    if (s < 2) s = 2;
    MoveTo(bx, by);
    LineTo((short)(bx - s), (short)(by + s));
    LineTo(bx, (short)(by + s));
    LineTo((short)(bx - s), (short)(by + 2 * s));
}

/* Fallback "?" for any code not in our table. */
static void DrawUnknownGlyph(short x, short y, short size)
{
    Rect r;
    r.left = x; r.top = y;
    r.right = (short)(x + size); r.bottom = (short)(y + size);
    FrameRect(&r);
    /* Draw a "?" character centered in the box using the system font.
     * Read txFont/txSize/txFace off the current port via GetPort — Retro68's
     * multiversal headers don't expose the bare `thePort` global; use the
     * accessor instead. */
    GrafPtr port;
    GetPort(&port);
    short oldFont = port->txFont;
    short oldSize = port->txSize;
    Style oldFace = port->txFace;
    TextFont(applFont);
    TextSize((short)(size * 2 / 3));
    TextFace(bold);
    short tw = StringWidth("\p?");
    MoveTo((short)(x + (size - tw) / 2),
           (short)(y + size * 3 / 4));
    DrawString("\p?");
    TextFont(oldFont);
    TextSize(oldSize);
    TextFace(oldFace);
}

/* ------------------------------------------------------------ dispatch */

void WeatherDrawGlyph(unsigned char wmo, short x, short y, short size)
{
    /* Save pen state — callers want their pen position back. */
    PenState savedPen;
    GetPenState(&savedPen);
    PenNormal();

    if (wmo == 0) {
        DrawSunGlyph(x, y, size);
    } else if (wmo == 1 || wmo == 2) {
        DrawPartlyCloudyGlyph(x, y, size);
    } else if (wmo == 3) {
        DrawCloudGlyph(x, y, size);
    } else if (wmo == 45 || wmo == 48) {
        DrawFogGlyph(x, y, size);
    } else if ((wmo >= 51 && wmo <= 57) || wmo == 80) {
        DrawDrizzleGlyph(x, y, size);
    } else if ((wmo >= 61 && wmo <= 67) || (wmo >= 81 && wmo <= 82)) {
        DrawRainGlyph(x, y, size);
    } else if ((wmo >= 71 && wmo <= 77) || wmo == 85 || wmo == 86) {
        DrawSnowGlyph(x, y, size);
    } else if (wmo >= 95 && wmo <= 99) {
        DrawThunderGlyph(x, y, size);
    } else {
        DrawUnknownGlyph(x, y, size);
    }

    SetPenState(&savedPen);
}
