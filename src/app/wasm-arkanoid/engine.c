/*
 * engine.c — wasm-arkanoid game logic (paddle, ball, bricks, scoring).
 *
 * Pure-ish: no QuickDraw calls, no Toolbox event handling. Just
 * updates Game state from input + the tick clock. The renderer
 * (render.c) reads Game and paints; main.c routes events into here
 * via the API in engine.h.
 *
 * Collision model:
 *   - Ball is treated as an axis-aligned BALL_SIZE × BALL_SIZE box
 *     for simplicity. (At 10 px this reads as a square ball even
 *     though we render an oval; the discrepancy doesn't matter at
 *     human reaction times.)
 *   - On a collision with a brick, we resolve by reflecting whichever
 *     velocity component points into the brick. Two collisions in the
 *     same tick (corner case) reflect both components.
 *   - Paddle reflection scales horizontal velocity by where on the
 *     paddle the ball hit — far ends bounce more sharply, like a
 *     real Arkanoid.
 */

#include <Events.h>          /* TickCount */
#include "engine.h"

/* ── Initial states ──────────────────────────────────────────────── */

void EngineNewGame(Game *g) {
    short r, c;
    for (r = 0; r < BRICK_ROWS; r++) {
        for (c = 0; c < BRICK_COLS; c++) {
            g->bricks[r][c] = 1;
        }
    }
    g->bricks_left = BRICK_ROWS * BRICK_COLS;
    g->score = 0;
    g->lives = INITIAL_LIVES;
    g->phase = PHASE_PLAYING;
    EngineRespawnBall(g);
}

void EngineRespawnBall(Game *g) {
    g->paddle_x = PLAY_LEFT + (PLAY_W - PADDLE_W) / 2;
    g->ball_x = g->paddle_x + (PADDLE_W - BALL_SIZE) / 2;
    g->ball_y = PADDLE_Y - BALL_SIZE - 2;
    g->ball_vx = BALL_INIT_VX;
    g->ball_vy = BALL_INIT_VY;
    g->next_move_tick = TickCount() + MOVE_TICKS;
    if (g->phase != PHASE_GAME_OVER && g->phase != PHASE_WIN) {
        g->phase = PHASE_PLAYING;
    }
}

/* ── Paddle input ────────────────────────────────────────────────── */

void EnginePaddleLeft(Game *g) {
    if (g->phase != PHASE_PLAYING) return;
    g->paddle_x -= PADDLE_STEP;
    if (g->paddle_x < PLAY_LEFT) g->paddle_x = PLAY_LEFT;
}

void EnginePaddleRight(Game *g) {
    if (g->phase != PHASE_PLAYING) return;
    g->paddle_x += PADDLE_STEP;
    if (g->paddle_x + PADDLE_W > PLAY_RIGHT) {
        g->paddle_x = PLAY_RIGHT - PADDLE_W;
    }
}

void EngineTogglePause(Game *g) {
    if (g->phase == PHASE_PLAYING)      g->phase = PHASE_PAUSED;
    else if (g->phase == PHASE_PAUSED)  g->phase = PHASE_PLAYING;
}

/* ── Per-tick physics ────────────────────────────────────────────── */

/* Reflect ball off bricks. Returns 1 if any brick was hit this tick. */
static Boolean HitBricks(Game *g) {
    short c, r;
    Boolean hit_h = false, hit_v = false;
    short bx = g->ball_x, by = g->ball_y;
    short bx2 = bx + BALL_SIZE, by2 = by + BALL_SIZE;
    for (r = 0; r < BRICK_ROWS; r++) {
        for (c = 0; c < BRICK_COLS; c++) {
            short brx, bry, brx2, bry2;
            if (!g->bricks[r][c]) continue;
            brx = BRICKS_LEFT + c * BRICK_W;
            bry = BRICK_TOP + r * BRICK_H;
            brx2 = brx + BRICK_W - 1;
            bry2 = bry + BRICK_H - 1;
            if (bx >= brx2 || bx2 <= brx) continue;
            if (by >= bry2 || by2 <= bry) continue;
            /* Overlap detected. Reflect whichever axis the centre is
             * closer to the brick's perpendicular edge on. */
            {
                short cx = bx + BALL_SIZE / 2;
                short cy = by + BALL_SIZE / 2;
                short brcx = (brx + brx2) / 2;
                short brcy = (bry + bry2) / 2;
                short dx = cx - brcx; if (dx < 0) dx = -dx;
                short dy = cy - brcy; if (dy < 0) dy = -dy;
                if (dx > dy) hit_h = true;
                else         hit_v = true;
            }
            g->bricks[r][c] = 0;
            g->bricks_left--;
            g->score += SCORE_PER_HIT;
        }
    }
    if (hit_h) g->ball_vx = -g->ball_vx;
    if (hit_v) g->ball_vy = -g->ball_vy;
    return hit_h || hit_v;
}

Boolean EngineTick(Game *g, long now) {
    if (g->phase != PHASE_PLAYING) return false;
    if (now < g->next_move_tick) return false;
    g->next_move_tick = now + MOVE_TICKS;

    /* Advance ball. */
    g->ball_x += g->ball_vx;
    g->ball_y += g->ball_vy;

    /* Walls. */
    if (g->ball_x <= PLAY_LEFT) {
        g->ball_x = PLAY_LEFT;
        g->ball_vx = -g->ball_vx;
    } else if (g->ball_x + BALL_SIZE >= PLAY_RIGHT) {
        g->ball_x = PLAY_RIGHT - BALL_SIZE;
        g->ball_vx = -g->ball_vx;
    }
    if (g->ball_y <= PLAY_TOP) {
        g->ball_y = PLAY_TOP;
        g->ball_vy = -g->ball_vy;
    }

    /* Paddle. Only deflect when descending (vy > 0). */
    if (g->ball_vy > 0 &&
        g->ball_y + BALL_SIZE >= PADDLE_Y &&
        g->ball_y + BALL_SIZE <= PADDLE_Y + PADDLE_H &&
        g->ball_x + BALL_SIZE > g->paddle_x &&
        g->ball_x < g->paddle_x + PADDLE_W) {
        /* Reflect vertical; tilt horizontal by paddle-hit position. */
        short hit_centre = (g->ball_x + BALL_SIZE / 2) - g->paddle_x;
        short tilt = (hit_centre - PADDLE_W / 2) / 8;  /* -3..+3 */
        g->ball_vy = -BALL_INIT_VY;
        g->ball_vx = BALL_INIT_VX + (g->ball_vx < 0 ? -tilt : tilt);
        if (g->ball_vx == 0) g->ball_vx = (tilt >= 0) ? 1 : -1;
        if (g->ball_vx >  6) g->ball_vx =  6;
        if (g->ball_vx < -6) g->ball_vx = -6;
        g->ball_y = PADDLE_Y - BALL_SIZE - 1;
    }

    /* Brick collisions. */
    HitBricks(g);
    if (g->bricks_left == 0) {
        g->phase = PHASE_WIN;
        return true;
    }

    /* Fell off the bottom — life lost. */
    if (g->ball_y >= PLAY_BOTTOM) {
        g->lives--;
        if (g->lives <= 0) {
            g->phase = PHASE_GAME_OVER;
        } else {
            EngineRespawnBall(g);
        }
    }
    return true;
}
