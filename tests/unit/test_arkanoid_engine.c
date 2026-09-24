/*
 * test_arkanoid_engine.c — host-compiled tests for wasm-arkanoid's
 * engine.c physics.
 *
 * Screen coordinates: y grows DOWNWARD (QuickDraw), so vy < 0 means
 * the ball is rising. #357 was exactly this sign getting crossed.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "engine.h"

static int failures = 0;

#define CHECK(cond, ...) do { \
    if (!(cond)) { \
        failures++; \
        printf("  FAIL %s:%d: ", __FILE__, __LINE__); \
        printf(__VA_ARGS__); \
        printf("\n"); \
    } \
} while (0)

static long clock_now = 1;

static void Step(Game *g) {
    g->next_move_tick = 0;
    EngineTick(g, clock_now++);
}

/* A playing game with no bricks except the ones a test adds. */
static void EmptyBoard(Game *g) {
    memset(g, 0, sizeof *g);
    g->phase = PHASE_PLAYING;
    g->lives = INITIAL_LIVES;
    g->bricks_left = 1;   /* nonzero so an empty board isn't a win */
    g->paddle_x = PLAY_LEFT + (PLAY_W - PADDLE_W) / 2;
}

/* Place the ball one tick above the paddle, moving at (vx, +3), so
 * that the ball's centre lands `offset` px from the paddle centre. */
static void DropOntoPaddle(Game *g, short vx, short offset) {
    short land_x = g->paddle_x + PADDLE_W / 2 + offset - BALL_SIZE / 2;
    g->ball_vx = vx;
    g->ball_vy = 3;
    g->ball_x = land_x - vx;
    g->ball_y = PADDLE_Y - BALL_SIZE + 1 - 3;
}

static void test_paddle_sends_ball_up(void) {
    Game g;
    short offsets[] = { -30, -15, 0, 15, 30 };
    short vxs[] = { -3, 3 };
    unsigned i, j;
    printf("paddle bounce always sends the ball upward\n");
    for (i = 0; i < sizeof offsets / sizeof *offsets; i++) {
        for (j = 0; j < sizeof vxs / sizeof *vxs; j++) {
            EmptyBoard(&g);
            DropOntoPaddle(&g, vxs[j], offsets[i]);
            Step(&g);
            CHECK(g.ball_vy < 0, "vx=%d offset=%d: vy=%d after paddle hit",
                  vxs[j], offsets[i], g.ball_vy);
        }
    }
}

static void test_paddle_centre_keeps_direction(void) {
    Game g;
    printf("centre hit keeps the ball's horizontal direction\n");

    EmptyBoard(&g);
    DropOntoPaddle(&g, 3, 0);
    Step(&g);
    CHECK(g.ball_vx > 0, "moving right, centre hit: vx=%d", g.ball_vx);

    EmptyBoard(&g);
    DropOntoPaddle(&g, -3, 0);
    Step(&g);
    CHECK(g.ball_vx < 0, "moving left, centre hit: vx=%d", g.ball_vx);
}

static void test_paddle_edges_steer(void) {
    Game g;
    printf("paddle edges steer the ball toward that edge\n");

    EmptyBoard(&g);
    DropOntoPaddle(&g, 3, -30);
    Step(&g);
    CHECK(g.ball_vx < 0, "moving right, far-left hit: vx=%d", g.ball_vx);

    EmptyBoard(&g);
    DropOntoPaddle(&g, -3, 30);
    Step(&g);
    CHECK(g.ball_vx > 0, "moving left, far-right hit: vx=%d", g.ball_vx);
}

/* Brick (r, c)'s rect, as engine.c computes it. */
static void BrickRect(short r, short c, short *x, short *y) {
    *x = BRICKS_LEFT + c * BRICK_W;
    *y = BRICK_TOP + r * BRICK_H;
}

static void test_brick_underside_off_centre(void) {
    Game g;
    short bx, by;
    printf("hitting a brick's underside off-centre bounces the ball down\n");
    EmptyBoard(&g);
    g.bricks[4][3] = 1;
    g.bricks_left = 2;
    BrickRect(4, 3, &bx, &by);
    /* Ball rising, centre 12 px right of the brick centre, its top
     * 2 px into the brick's bottom edge after this tick. */
    g.ball_vx = 1;
    g.ball_vy = -3;
    g.ball_x = bx + BRICK_W / 2 + 12 - BALL_SIZE / 2 - 1;
    g.ball_y = by + BRICK_H - 1 - 2 + 3;
    Step(&g);
    CHECK(g.bricks[4][3] == 0, "brick not broken");
    CHECK(g.ball_vy > 0, "vy=%d, ball kept rising through the brick row",
          g.ball_vy);
    CHECK(g.ball_vx == 1, "vx=%d, horizontal velocity flipped", g.ball_vx);
}

static void test_brick_side_hit(void) {
    Game g;
    short bx, by;
    printf("hitting a brick's side bounces the ball sideways\n");
    EmptyBoard(&g);
    g.bricks[2][5] = 1;
    g.bricks_left = 2;
    BrickRect(2, 5, &bx, &by);
    /* Ball moving right, vertically centred on the brick, its right
     * edge 2 px into the brick's left edge after this tick. */
    g.ball_vx = 3;
    g.ball_vy = -1;
    g.ball_x = bx - BALL_SIZE + 2 - 3;
    g.ball_y = by + BRICK_H / 2 - BALL_SIZE / 2 + 1;
    Step(&g);
    CHECK(g.bricks[2][5] == 0, "brick not broken");
    CHECK(g.ball_vx < 0, "vx=%d after side hit", g.ball_vx);
    CHECK(g.ball_vy == -1, "vy=%d, vertical velocity flipped", g.ball_vy);
}

/* End-to-end: a paddle that tracks the ball perfectly should never
 * lose a life, and every paddle contact should send the ball up. */
static void test_perfect_paddle_never_loses(void) {
    Game g;
    long t;
    printf("a perfectly tracking paddle never loses a life\n");
    EngineNewGame(&g);
    for (t = 0; t < 60L * 60 * 10 && g.phase == PHASE_PLAYING; t++) {
        short want = g.ball_x + BALL_SIZE / 2 - PADDLE_W / 2;
        if (want < PLAY_LEFT) want = PLAY_LEFT;
        if (want > PLAY_RIGHT - PADDLE_W) want = PLAY_RIGHT - PADDLE_W;
        g.paddle_x = want;
        Step(&g);
        if (g.lives != INITIAL_LIVES) break;
    }
    CHECK(g.lives == INITIAL_LIVES, "lost a life at tick %ld", t);
    CHECK(g.phase == PHASE_WIN || g.phase == PHASE_PLAYING,
          "phase=%d", (int)g.phase);
}

int main(void) {
    test_paddle_sends_ball_up();
    test_paddle_centre_keeps_direction();
    test_paddle_edges_steer();
    test_brick_underside_off_centre();
    test_brick_side_hit();
    test_perfect_paddle_never_loses();
    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("ok\n");
    return 0;
}
