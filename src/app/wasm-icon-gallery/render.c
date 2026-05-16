/*
 * render.c — draw the 3×2 grid of icons + their text labels in the
 * window. Each cell is CELL_W × CELL_H; the icon is drawn at the
 * top of the cell, the label centred below it.
 *
 * Uses `PlotIcon` for ICN# resources — the simplest Toolbox call
 * for drawing icons. (PlotIconHandle is the same thing but lets
 * you skip the resource lookup; we already have the handles cached
 * in gallery.c.)
 */

#include <Fonts.h>
#include <Windows.h>
#include <ToolUtils.h>
#include "gallery.h"

static void DrawHeader(void);
static void DrawCell(short index, short col, short row);

void RenderGallery(void) {
    GrafPtr port;
    short i;
    GetPort(&port);
    EraseRect(&port->portRect);
    DrawHeader();
    for (i = 0; i < ICON_COUNT; i++) {
        short col = i % GRID_COLS;
        short row = i / GRID_COLS;
        DrawCell(i, col, row);
    }
}

static void DrawHeader(void) {
    TextFont(systemFont);
    TextSize(0);
    MoveTo(GRID_LEFT, 24);
    /* MacRoman doesn't include U+2605 (★), so we can't put literal
     * stars in a Pascal string here — the UTF-8 bytes would render
     * as three garbled MacRoman characters per star. Use an ASCII
     * label instead; the star rating still appears in the project
     * dropdown via the host-side `complexityStars()` helper. */
    DrawString("\pIcons loaded from icons.rsrc  (6-star tier)");
}

static void DrawCell(short index, short col, short row) {
    short cellX = GRID_LEFT + col * CELL_W;
    short cellY = GRID_TOP + row * CELL_H;
    short iconX = cellX + (CELL_W - ICON_SIZE) / 2;
    short iconY = cellY;
    Rect iconRect;
    short labelWidth;
    Handle icn = GalleryIcon(index);
    const char *name = kIconNames[index];

    SetRect(&iconRect, iconX, iconY, iconX + ICON_SIZE, iconY + ICON_SIZE);
    if (icn) {
        PlotIcon(&iconRect, icn);
    } else {
        /* Loaded-but-missing fallback: outline the cell so the
         * gap is at least visible. */
        FrameRect(&iconRect);
    }

    /* Label below the icon. Pascal-string from the C name. */
    {
        Str255 ps;
        short i = 0;
        while (name[i] != '\0' && i < 255) {
            ps[i + 1] = (unsigned char)name[i];
            i++;
        }
        ps[0] = (unsigned char)i;
        labelWidth = StringWidth(ps);
        MoveTo(cellX + (CELL_W - labelWidth) / 2, iconY + ICON_SIZE + 18);
        DrawString(ps);
    }
}
