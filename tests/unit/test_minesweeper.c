/*
 * test_minesweeper.c — host-compiled unit tests for game_logic.c.
 *
 * Compiled with the host gcc/clang. Exercises the pure-C game engine
 * directly — no Mac Toolbox involved. Sub-second feedback loop.
 */

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "game_logic.h"

/* Count mines on the board. After the first reveal places mines, the
 * count must equal GAME_MINES. */
static int count_mines(const GameBoard *b)
{
    int n = 0;
    for (int i = 0; i < GAME_CELLS; i++) if (b->is_mine[i]) n++;
    return n;
}

static int count_revealed(const GameBoard *b)
{
    int n = 0;
    for (int i = 0; i < GAME_CELLS; i++) {
        if (b->state[i] == CELL_REVEALED) n++;
    }
    return n;
}

/* ---------------------------------------------------------------- tests */

static void test_init(void)
{
    GameBoard b;
    game_init_default(&b);
    assert(b.status == GAME_PLAYING);
    assert(b.mines_placed == 0);
    assert(b.cells_revealed == 0);
    assert(b.flags_placed == 0);
    assert(count_mines(&b) == 0);
    for (int i = 0; i < GAME_CELLS; i++) {
        assert(b.state[i] == CELL_HIDDEN);
    }
    printf("  ok: init\n");
}

static void test_index_bounds(void)
{
    assert(game_index(0, 0) == 0);
    assert(game_index(GAME_COLS - 1, GAME_ROWS - 1) == GAME_CELLS - 1);
    assert(game_index(-1, 0)  == -1);
    assert(game_index(0, -1)  == -1);
    assert(game_index(GAME_COLS, 0) == -1);
    assert(game_index(0, GAME_ROWS) == -1);
    printf("  ok: index bounds\n");
}

static void test_mine_count_after_first_reveal(void)
{
    GameBoard b;
    game_init_default(&b);
    /* First click anywhere — mines get placed lazily. */
    int changed = game_reveal(&b, 4, 4);
    assert(changed == 1);
    assert(b.mines_placed == GAME_MINES);
    assert(count_mines(&b) == GAME_MINES);
    printf("  ok: mine placement count\n");
}

static void test_first_click_safety(void)
{
    /* Try several seeds and a few different first-click positions to
     * make sure the safe zone is honoured regardless of RNG state. */
    int positions[][2] = {
        {0, 0}, {4, 4}, {GAME_COLS - 1, GAME_ROWS - 1}, {2, 5}, {7, 1}
    };
    unsigned long seeds[] = { 1, 2, 3, 0xDEADBEEFUL, 0x1234ABCDUL, 42, 99999 };

    for (size_t s = 0; s < sizeof(seeds) / sizeof(seeds[0]); s++) {
        for (size_t p = 0; p < sizeof(positions) / sizeof(positions[0]); p++) {
            GameBoard b;
            game_init(&b, seeds[s]);
            int col = positions[p][0];
            int row = positions[p][1];
            game_reveal(&b, col, row);
            /* The clicked cell and its 8 neighbors must not be mines. */
            for (int dr = -1; dr <= 1; dr++) {
                for (int dc = -1; dc <= 1; dc++) {
                    int idx = game_index(col + dc, row + dr);
                    if (idx >= 0) {
                        assert(b.is_mine[idx] == 0);
                    }
                }
            }
            /* And we must not have lost from the first click. */
            assert(b.status != GAME_LOST);
        }
    }
    printf("  ok: first-click safety (clicked cell + 8 neighbors)\n");
}

static void test_flood_fill(void)
{
    GameBoard b;
    game_init_default(&b);
    /* First click guarantees the clicked cell has zero neighbors (the
     * full 3x3 around it is mine-free), so flood-fill must reveal
     * strictly more than just the clicked cell. */
    game_reveal(&b, 4, 4);
    int revealed = count_revealed(&b);
    assert(revealed >= 9);
    assert(b.cells_revealed == revealed);
    /* Any revealed cell with neighbor_count == 0 must have all 8
     * in-bounds neighbors revealed too. */
    for (int row = 0; row < GAME_ROWS; row++) {
        for (int col = 0; col < GAME_COLS; col++) {
            int idx = game_index(col, row);
            if (b.state[idx] == CELL_REVEALED && b.neighbor_count[idx] == 0) {
                for (int dr = -1; dr <= 1; dr++) {
                    for (int dc = -1; dc <= 1; dc++) {
                        int nidx = game_index(col + dc, row + dr);
                        if (nidx >= 0) {
                            assert(b.state[nidx] == CELL_REVEALED);
                        }
                    }
                }
            }
        }
    }
    printf("  ok: flood-fill on zero-neighbor cells\n");
}

static void test_loss_on_mine(void)
{
    GameBoard b;
    game_init_default(&b);
    game_reveal(&b, 4, 4);  /* place mines */
    /* Find a mine and click it. */
    int mine_idx = -1;
    for (int i = 0; i < GAME_CELLS; i++) {
        if (b.is_mine[i]) { mine_idx = i; break; }
    }
    assert(mine_idx >= 0);
    int col = mine_idx % GAME_COLS;
    int row = mine_idx / GAME_COLS;
    int changed = game_reveal(&b, col, row);
    assert(changed == 1);
    assert(b.status == GAME_LOST);
    assert(b.state[mine_idx] == CELL_MINE_REVEALED);
    /* Further reveals are no-ops. */
    assert(game_reveal(&b, 0, 0) == 0);
    printf("  ok: loss when a mine is revealed\n");
}

static void test_win_when_all_safe_revealed(void)
{
    GameBoard b;
    game_init_default(&b);
    game_reveal(&b, 4, 4);  /* place mines */
    /* Force-reveal every non-mine cell. The engine should flip to WON
     * the moment cells_revealed reaches GAME_CELLS - GAME_MINES. */
    for (int row = 0; row < GAME_ROWS; row++) {
        for (int col = 0; col < GAME_COLS; col++) {
            int idx = game_index(col, row);
            if (b.is_mine[idx]) continue;
            if (b.state[idx] == CELL_REVEALED) continue;
            game_reveal(&b, col, row);
        }
    }
    assert(b.status == GAME_WON);
    assert(b.cells_revealed == GAME_CELLS - GAME_MINES);
    printf("  ok: win when all non-mine cells revealed\n");
}

static void test_flag_toggle(void)
{
    GameBoard b;
    game_init_default(&b);
    assert(game_mines_remaining(&b) == GAME_MINES);

    int changed = game_toggle_flag(&b, 0, 0);
    assert(changed == 1);
    assert(b.state[0] == CELL_FLAGGED);
    assert(game_mines_remaining(&b) == GAME_MINES - 1);

    /* Cannot reveal a flagged cell. */
    assert(game_reveal(&b, 0, 0) == 0);

    /* Toggle off. */
    changed = game_toggle_flag(&b, 0, 0);
    assert(changed == 1);
    assert(b.state[0] == CELL_HIDDEN);
    assert(game_mines_remaining(&b) == GAME_MINES);

    /* Cannot flag a revealed cell. */
    game_reveal(&b, 4, 4);
    /* find any revealed cell */
    for (int i = 0; i < GAME_CELLS; i++) {
        if (b.state[i] == CELL_REVEALED) {
            int col = i % GAME_COLS;
            int row = i / GAME_COLS;
            assert(game_toggle_flag(&b, col, row) == 0);
            break;
        }
    }
    printf("  ok: flag toggle and interactions\n");
}

static void test_post_game_noops(void)
{
    GameBoard b;
    game_init_default(&b);
    game_reveal(&b, 4, 4);
    /* Click a mine to force loss. */
    for (int i = 0; i < GAME_CELLS; i++) {
        if (b.is_mine[i]) {
            game_reveal(&b, i % GAME_COLS, i / GAME_COLS);
            break;
        }
    }
    assert(b.status == GAME_LOST);
    /* No more state changes accepted. */
    assert(game_reveal(&b, 0, 0) == 0);
    assert(game_toggle_flag(&b, 0, 0) == 0);
    printf("  ok: reveal/flag no-op after game over\n");
}

int main(void)
{
    printf("test_minesweeper:\n");
    test_init();
    test_index_bounds();
    test_mine_count_after_first_reveal();
    test_first_click_safety();
    test_flood_fill();
    test_loss_on_mine();
    test_win_when_all_safe_revealed();
    test_flag_toggle();
    test_post_game_noops();
    printf("test_minesweeper: PASS\n");
    return 0;
}
