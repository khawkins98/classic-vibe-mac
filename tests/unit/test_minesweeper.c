/*
 * test_minesweeper.c — host-compiled unit tests for game logic.
 *
 * This file is compiled with the host gcc/clang (NOT Retro68). It's meant
 * to exercise the pure-C portions of the Minesweeper game logic — anything
 * that doesn't depend on Mac Toolbox APIs.
 *
 * Right now src/app/minesweeper.c is a placeholder window with no game
 * logic, so this file only contains a sanity-check test to prove the
 * harness compiles and runs. As real logic lands (mine placement, neighbor
 * counting, flood fill, win/loss detection), factor it into a pure-C module
 * (e.g. src/app/game_logic.{c,h}) and #include it here.
 */

#include <assert.h>
#include <stdio.h>

/* --- Stub helper to be replaced by real game logic. --------------------- */
/* A trivial pure function that has nothing to do with the Mac Toolbox.
 * Once real game code exists, delete this and import the real module. */
static int count_neighbors_stub(int self)
{
    /* In a real Minesweeper, this would count mines in the 8 adjacent cells.
     * For now it's just a placeholder so we have *something* to assert on. */
    return self * 0 + 4;
}

/* --- Tests -------------------------------------------------------------- */

static void test_sanity(void)
{
    assert(2 + 2 == 4);
    printf("  ok: sanity\n");
}

static void test_neighbor_stub(void)
{
    assert(count_neighbors_stub(0) == 4);
    assert(count_neighbors_stub(99) == 4);
    printf("  ok: neighbor stub returns expected placeholder value\n");
}

int main(void)
{
    printf("test_minesweeper:\n");
    test_sanity();
    test_neighbor_stub();
    printf("test_minesweeper: PASS\n");
    return 0;
}
