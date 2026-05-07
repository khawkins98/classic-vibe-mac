/*
 * game_logic.h — pure-C Minesweeper engine.
 *
 * No Mac Toolbox calls live in this module; it's compiled both by Retro68
 * (linked into the Toolbox UI shell) and by the host C compiler (driven
 * by the unit tests in tests/unit/). Keep it that way — anything that
 * touches QuickDraw, the Window Manager, etc. belongs in minesweeper.c.
 */

#ifndef GAME_LOGIC_H
#define GAME_LOGIC_H

/* Beginner board. Hardcoded for the POC; difficulty selection is a
 * stretch goal. 9x9 with 10 mines matches classic Mac/Windows defaults. */
#define GAME_COLS  9
#define GAME_ROWS  9
#define GAME_MINES 10
#define GAME_CELLS (GAME_COLS * GAME_ROWS)

typedef enum {
    CELL_HIDDEN = 0,
    CELL_REVEALED,
    CELL_FLAGGED,
    CELL_MINE_REVEALED   /* the mine the player clicked to lose */
} CellState;

typedef enum {
    GAME_PLAYING = 0,
    GAME_WON,
    GAME_LOST
} GameStatus;

typedef struct {
    /* True if a mine is at this index. Only valid after first reveal. */
    unsigned char is_mine[GAME_CELLS];
    /* Number of mines in the 8 neighbors. Filled in with mines. */
    unsigned char neighbor_count[GAME_CELLS];
    CellState     state[GAME_CELLS];
    GameStatus    status;
    int           mines_placed;        /* zero until first click */
    int           cells_revealed;
    int           flags_placed;
    unsigned long rng_seed;            /* xorshift state */
} GameBoard;

/* Default seed used by game_init_default. Tests rely on this being
 * deterministic. Toolbox UI may overwrite board->rng_seed with TickCount()
 * before the first reveal for non-deterministic real games. */
#define GAME_DEFAULT_SEED 0x1234ABCDUL

/* Initialize an empty board. No mines are placed yet — placement is
 * deferred until the first reveal so we can guarantee first-click safety. */
void game_init(GameBoard *b, unsigned long seed);
void game_init_default(GameBoard *b);

/* Index helpers. Bounds-safe: returns -1 if out of range. */
int  game_index(int col, int row);

/* Reveal the cell at (col, row).
 *  - On the very first reveal, places mines (excluding the clicked cell
 *    and its 8 neighbors) before doing the reveal.
 *  - If the cell is a mine, marks it CELL_MINE_REVEALED and sets status
 *    to GAME_LOST.
 *  - If the cell has zero neighbor mines, flood-fills neighbors.
 *  - Updates win status if all non-mine cells are now revealed.
 * No-op (returns 0) if cell is already revealed/flagged or game is over.
 * Returns 1 if the board changed. */
int  game_reveal(GameBoard *b, int col, int row);

/* Toggle a flag on a hidden cell. No-op on revealed cells or when the
 * game is over. Returns 1 if the board changed. */
int  game_toggle_flag(GameBoard *b, int col, int row);

/* Number of unflagged mines remaining (for the mine counter display).
 * Can go negative if the player over-flags; the UI may clamp. */
int  game_mines_remaining(const GameBoard *b);

#endif /* GAME_LOGIC_H */
