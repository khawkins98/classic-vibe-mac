/*
 * render.c — wasm-arkanoid drawing. Reads Game state, paints with
 * QuickDraw. Knows nothing about events or timing.
 *
 * Patterns used:
 *   - PaintRect for paddle and bricks (filled)
 *   - PaintOval for the ball (the in-game sprite; intentionally an
 *     oval not the ICN# resource — ICN# 128 is reserved for the
 *     about-box icon, where its 32×32 size reads cleanly)
 *   - FrameRect for the play-area border
 *   - DrawString + MoveTo for the score header
 *
 * Bricks are drawn with three filled patterns rotated by row, so the
 * 5 brick rows visually distinguish themselves on a 1-bit display
 * without needing Color QuickDraw. (On a colour display Color
 * QuickDraw quantises these to the expected greys.)
 */

#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <ToolUtils.h>     /* NumToString */
#include "engine.h"

/* Forward decl */
static void DrawScoreHeader(const Game *g);
static void DrawBricks(const Game *g);
static void DrawPaddleBall(const Game *g);
static void DrawOverlay(const Game *g);
static void CentreString(short y, ConstStr255Param s);

/* Public entry — repaint everything in the current port. */
void RenderScene(const Game *g) {
    Rect playRect;
    GrafPtr port;
    GetPort(&port);
    EraseRect(&port->portRect);

    /* Play-area border. */
    SetRect(&playRect, PLAY_LEFT - 1, PLAY_TOP - 1,
                       PLAY_RIGHT + 1, PLAY_BOTTOM + 1);
    FrameRect(&playRect);

    DrawScoreHeader(g);
    DrawBricks(g);
    DrawPaddleBall(g);
    DrawOverlay(g);
}

/* Score / lives header, top of the window. */
static void DrawScoreHeader(const Game *g) {
    Str255 s;
    Str255 livesStr;
    short i;

    TextFont(systemFont);
    TextSize(0);     /* default size */

    MoveTo(PLAY_LEFT, PLAY_TOP - 8);
    DrawString("\pScore: ");
    NumToString(g->score, s);
    DrawString(s);

    livesStr[0] = 0;
    DrawString("\p   Lives: ");
    /* Render lives as filled dots — uses a printable char so we can
     * use DrawString instead of QuickDraw primitives. */
    livesStr[0] = (unsigned char)g->lives;
    for (i = 1; i <= g->lives; i++) {
        livesStr[i] = '*';
    }
    DrawString(livesStr);
}

/* Bricks grid. The 5 brick rows alternate between the 5 always-
 * available QuickDraw system patterns (white/ltGray/gray/dkGray/black)
 * for visual variety in 1-bit. The system patterns live in qd as
 * fields — black/dkGray/gray/ltGray/white — and are guaranteed
 * available without any resource lookup, avoiding the
 * GetIndPattern/PAT# resolution that costs a library symbol the
 * wasm-cc1 sysroot doesn't ship. */
static void DrawBricks(const Game *g) {
    short r, c;
    Rect brickRect;
    const Pattern *rowPat;
    for (r = 0; r < BRICK_ROWS; r++) {
        switch (r) {
            case 0: rowPat = &qd.dkGray; break;
            case 1: rowPat = &qd.gray;   break;
            case 2: rowPat = &qd.ltGray; break;
            case 3: rowPat = &qd.gray;   break;
            default: rowPat = &qd.dkGray; break;
        }
        for (c = 0; c < BRICK_COLS; c++) {
            if (!g->bricks[r][c]) continue;
            SetRect(&brickRect,
                BRICKS_LEFT + c * BRICK_W + 1,
                BRICK_TOP   + r * BRICK_H + 1,
                BRICKS_LEFT + (c + 1) * BRICK_W - 1,
                BRICK_TOP   + (r + 1) * BRICK_H - 1);
            FillRect(&brickRect, rowPat);
            FrameRect(&brickRect);
        }
    }
}

/* Paddle (rect) and ball (oval). */
static void DrawPaddleBall(const Game *g) {
    Rect r;
    SetRect(&r, g->paddle_x, PADDLE_Y,
                g->paddle_x + PADDLE_W, PADDLE_Y + PADDLE_H);
    PaintRect(&r);
    SetRect(&r, g->ball_x, g->ball_y,
                g->ball_x + BALL_SIZE, g->ball_y + BALL_SIZE);
    PaintOval(&r);
}

/* Banner shown on pause / win / game-over. */
static void DrawOverlay(const Game *g) {
    short midY = (PLAY_TOP + PLAY_BOTTOM) / 2;
    switch (g->phase) {
        case PHASE_PLAYING:
            return;
        case PHASE_PAUSED:
            CentreString(midY, "\pPaused — Cmd-P to resume");
            return;
        case PHASE_WIN:
            CentreString(midY - 8, "\pYou win!");
            CentreString(midY + 10, "\pClick to play again");
            return;
        case PHASE_GAME_OVER:
            CentreString(midY - 8, "\pGame over");
            CentreString(midY + 10, "\pClick to play again");
            return;
    }
}

/* Draw a Pascal string centred horizontally on the playfield. */
static void CentreString(short y, ConstStr255Param s) {
    short w = StringWidth(s);
    MoveTo((PLAY_LEFT + PLAY_RIGHT - w) / 2, y);
    DrawString(s);
}
