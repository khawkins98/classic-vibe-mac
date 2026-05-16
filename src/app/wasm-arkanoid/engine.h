/*
 * engine.h — wasm-arkanoid shared types + constants (cv-mac #233, A).
 *
 * Drawn intentionally tight: the engine module owns the *what*
 * (paddle/ball/brick state, tick advance, collision math) and the
 * render module owns the *how* (QuickDraw drawing). main.c is the
 * Toolbox glue + event dispatch. This file is the contract between
 * the three.
 */

#ifndef WASM_ARKANOID_ENGINE_H
#define WASM_ARKANOID_ENGINE_H

#include <Types.h>
#include <Quickdraw.h>

/* ── Playfield geometry ──────────────────────────────────────────── */

/* Window: 360 wide × 280 tall, leaves 8 px margin around a 344×232
 * play area + a 20 px score header at the top. */
#define WINDOW_ID      128
#define WIN_W          360
#define WIN_H          280

#define PLAY_LEFT      8
#define PLAY_RIGHT     352
#define PLAY_TOP       28          /* leave 20 px for score */
#define PLAY_BOTTOM    272
#define PLAY_W         (PLAY_RIGHT - PLAY_LEFT)
#define PLAY_H         (PLAY_BOTTOM - PLAY_TOP)

#define PADDLE_W       60
#define PADDLE_H       8
#define PADDLE_Y       (PLAY_BOTTOM - 14)
#define PADDLE_STEP    18           /* pixels per arrow-key press */

#define BALL_SIZE      10
#define BALL_INIT_VX   3
#define BALL_INIT_VY   -3

#define BRICK_COLS     10
#define BRICK_ROWS     5
#define BRICK_W        ((PLAY_W - 12) / BRICK_COLS)  /* 33 → 6×5 grid */
#define BRICK_H        14
#define BRICK_TOP      (PLAY_TOP + 16)
#define BRICKS_LEFT    (PLAY_LEFT + 6)

#define INITIAL_LIVES  3
#define SCORE_PER_HIT  10

/* Tick rate. TickCount() returns 60ths of a second.
 * 1 → 60 Hz physics, smooth without burning CPU because WNE sleeps. */
#define MOVE_TICKS     1

/* ── State ───────────────────────────────────────────────────────── */

typedef enum {
    PHASE_PLAYING,
    PHASE_GAME_OVER,
    PHASE_WIN,
    PHASE_PAUSED
} GamePhase;

typedef struct {
    /* Paddle: horizontal position only (top-left x of the paddle rect). */
    short paddle_x;

    /* Ball: position (px) + velocity (px / tick). */
    short ball_x, ball_y;
    short ball_vx, ball_vy;

    /* Brick grid: 1 = present, 0 = broken. Row-major. */
    Byte bricks[BRICK_ROWS][BRICK_COLS];
    short bricks_left;       /* live brick count; reach 0 → win */

    long score;
    short lives;
    GamePhase phase;
    long next_move_tick;     /* TickCount when physics next advances */
} Game;

/* ── engine.c API ────────────────────────────────────────────────── */

/** Reset to a fresh start: full brick grid, paddle centred, ball
 *  perched on the paddle pointing up-right, score 0, lives 3. */
void EngineNewGame(Game *g);

/** Reset just the ball + paddle after a life is lost. Keeps score
 *  and brick state. */
void EngineRespawnBall(Game *g);

/** Advance one tick of physics if the timer says it's time. Returns
 *  TRUE if state changed in a way the renderer should re-draw. */
Boolean EngineTick(Game *g, long now);

/** Move the paddle left/right by PADDLE_STEP. Clamps to playfield. */
void EnginePaddleLeft(Game *g);
void EnginePaddleRight(Game *g);

/** Toggle PHASE_PLAYING ↔ PHASE_PAUSED. No-op outside those two phases. */
void EngineTogglePause(Game *g);

#endif  /* WASM_ARKANOID_ENGINE_H */
