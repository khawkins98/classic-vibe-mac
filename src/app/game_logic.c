/*
 * game_logic.c — pure-C Minesweeper engine.
 *
 * Standard C99 only. Nothing in here may include MacTypes.h, Quickdraw.h,
 * or anything Toolbox-flavored — this module is compiled by both Retro68
 * (for the real app) and the host gcc/clang (for unit tests).
 */

#include "game_logic.h"

#include <string.h>

/* xorshift32 — small, deterministic, good enough for mine placement.
 * Chosen over rand() so test results are stable across host libc
 * implementations. */
static unsigned long xs_next(unsigned long *state)
{
    unsigned long x = *state;
    if (x == 0) x = 1;             /* 0 is a fixed point */
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

int game_index(int col, int row)
{
    if (col < 0 || col >= GAME_COLS) return -1;
    if (row < 0 || row >= GAME_ROWS) return -1;
    return row * GAME_COLS + col;
}

void game_init(GameBoard *b, unsigned long seed)
{
    memset(b, 0, sizeof(*b));
    b->status   = GAME_PLAYING;
    b->rng_seed = seed ? seed : GAME_DEFAULT_SEED;
}

void game_init_default(GameBoard *b)
{
    game_init(b, GAME_DEFAULT_SEED);
}

/* Returns 1 if (col, row) is the clicked cell or one of its 8 neighbors. */
static int is_safe_zone(int col, int row, int safe_col, int safe_row)
{
    int dc = col - safe_col;
    int dr = row - safe_row;
    if (dc < 0) dc = -dc;
    if (dr < 0) dr = -dr;
    return (dc <= 1 && dr <= 1);
}

static void place_mines(GameBoard *b, int safe_col, int safe_row)
{
    int placed = 0;
    while (placed < GAME_MINES) {
        unsigned long r = xs_next(&b->rng_seed);
        int idx = (int)(r % (unsigned long)GAME_CELLS);
        int col = idx % GAME_COLS;
        int row = idx / GAME_COLS;
        if (b->is_mine[idx]) continue;
        if (is_safe_zone(col, row, safe_col, safe_row)) continue;
        b->is_mine[idx] = 1;
        placed++;
    }
    b->mines_placed = placed;

    /* Compute neighbor counts. */
    for (int row = 0; row < GAME_ROWS; row++) {
        for (int col = 0; col < GAME_COLS; col++) {
            int idx = row * GAME_COLS + col;
            if (b->is_mine[idx]) continue;
            int count = 0;
            for (int dr = -1; dr <= 1; dr++) {
                for (int dc = -1; dc <= 1; dc++) {
                    if (dr == 0 && dc == 0) continue;
                    int nidx = game_index(col + dc, row + dr);
                    if (nidx >= 0 && b->is_mine[nidx]) count++;
                }
            }
            b->neighbor_count[idx] = (unsigned char)count;
        }
    }
}

/* Recursive flood-fill on zero-neighbor cells. Stack depth is bounded by
 * GAME_CELLS (81) so recursion is fine — no need for an explicit stack. */
static void flood_reveal(GameBoard *b, int col, int row)
{
    int idx = game_index(col, row);
    if (idx < 0) return;
    if (b->state[idx] != CELL_HIDDEN) return;
    if (b->is_mine[idx]) return;     /* shouldn't happen for zero cells */

    b->state[idx] = CELL_REVEALED;
    b->cells_revealed++;

    if (b->neighbor_count[idx] != 0) return;

    for (int dr = -1; dr <= 1; dr++) {
        for (int dc = -1; dc <= 1; dc++) {
            if (dr == 0 && dc == 0) continue;
            flood_reveal(b, col + dc, row + dr);
        }
    }
}

static void check_win(GameBoard *b)
{
    if (b->cells_revealed >= GAME_CELLS - GAME_MINES) {
        b->status = GAME_WON;
    }
}

int game_reveal(GameBoard *b, int col, int row)
{
    if (b->status != GAME_PLAYING) return 0;
    int idx = game_index(col, row);
    if (idx < 0) return 0;
    if (b->state[idx] == CELL_REVEALED || b->state[idx] == CELL_FLAGGED) {
        return 0;
    }

    /* First click: place mines now so we can guarantee safety. */
    if (b->mines_placed == 0) {
        place_mines(b, col, row);
    }

    if (b->is_mine[idx]) {
        b->state[idx] = CELL_MINE_REVEALED;
        b->status    = GAME_LOST;
        return 1;
    }

    flood_reveal(b, col, row);
    check_win(b);
    return 1;
}

int game_toggle_flag(GameBoard *b, int col, int row)
{
    if (b->status != GAME_PLAYING) return 0;
    int idx = game_index(col, row);
    if (idx < 0) return 0;
    if (b->state[idx] == CELL_HIDDEN) {
        b->state[idx] = CELL_FLAGGED;
        b->flags_placed++;
        return 1;
    }
    if (b->state[idx] == CELL_FLAGGED) {
        b->state[idx] = CELL_HIDDEN;
        b->flags_placed--;
        return 1;
    }
    return 0;
}

int game_mines_remaining(const GameBoard *b)
{
    return GAME_MINES - b->flags_placed;
}
