/*
 * snake.c — classic Snake, in classic Mac C, compiled in your browser
 * (cv-mac #100 Phase D demo).
 *
 * Rules:
 *   - Arrow keys steer the snake. (←↑→↓)
 *   - Snake moves automatically every ~6 ticks (~100 ms on a Mac that
 *     ran at 60 Hz; we use TickCount() so wall-clock speed matches the
 *     emulator's clock).
 *   - Eat the apple (single cell) to grow by one segment and score 10.
 *   - Crash into a wall or yourself: game over.
 *   - Click to restart after game over.
 *
 * Implementation notes:
 *   - Grid: 24×16 cells × 14 px each (336×224 game area) — fits a
 *     nominal 360×260 window with comfortable margins for the score.
 *   - Snake stored as a circular array of (x,y) cells (`SNAKE_MAX`
 *     entries, way more than the user could ever fill in practice).
 *   - Apple placement: random retry until it lands on an empty cell.
 *     With a small board this is fine even when the snake fills 90%
 *     of it — average attempts stay under 20.
 *   - Timing: TickCount() returns 1/60 s ticks since boot. We poll
 *     once per WaitNextEvent and advance the snake when sleep_tick
 *     elapses. WNE's sleep parameter is `1` so we wake every tick
 *     to keep the game responsive without burning the CPU.
 *
 * Built via cv-mac #100 Phase B's mixed-build path: cc1 compiles the
 * .c, WASM-Rez compiles snake.r (window + signature), and
 * spliceResourceFork merges the two.
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Memory.h>
#include <OSUtils.h>

/* ── Grid + window geometry ──────────────────────────────────────── */

/* ← try changing CELL_PX or GRID_W / GRID_H to resize the playfield!
 * Then update the WIND 128 bounds in snake.r so the window fits the
 * new grid (GAME_LEFT * 2 + CELL_PX * GRID_W ≈ window width). */
#define CELL_PX        14
#define GRID_W         24
#define GRID_H         16
#define GAME_LEFT      12
#define GAME_TOP       28
#define SCORE_TOP      18
#define WINDOW_ID      128

#define SNAKE_MAX      ((GRID_W) * (GRID_H))

/* Tick rate. TickCount() returns 60ths of a second. 6 → 10 Hz move
 * rate, comfortable for keyboard control. */
#define MOVE_TICKS     6

/* ── Game state ──────────────────────────────────────────────────── */

typedef struct {
    short x, y;
} SnakeCell;

typedef enum { DIR_UP, DIR_DOWN, DIR_LEFT, DIR_RIGHT } Direction;

typedef struct {
    SnakeCell body[SNAKE_MAX];   /* body[0] = head, body[len-1] = tail */
    short len;
    Direction dir;
    Direction next_dir;     /* buffered input — applied at next move */
    SnakeCell apple;
    long score;
    Boolean alive;
    long next_move_tick;    /* TickCount when the snake next advances */
    unsigned long rng;      /* xorshift state */
} Game;

static Game game;
static WindowPtr win;

/* ── Tiny LCG/xorshift PRNG (we don't want to pull in <stdlib.h> qsort) */

static void seed_rng(unsigned long s) {
    /* xorshift32 — needs non-zero state. */
    game.rng = s ? s : 0xdeadbeef;
}

static unsigned long next_rand(void) {
    unsigned long x = game.rng;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    game.rng = x;
    return x;
}

/* ── Game logic ──────────────────────────────────────────────────── */

static Boolean cell_in_snake(SnakeCell c) {
    short i;
    for (i = 0; i < game.len; i++) {
        if (game.body[i].x == c.x && game.body[i].y == c.y) return true;
    }
    return false;
}

static void place_apple(void) {
    SnakeCell c;
    do {
        c.x = (short)(next_rand() % GRID_W);
        c.y = (short)(next_rand() % GRID_H);
    } while (cell_in_snake(c));
    game.apple = c;
}

static void reset_game(void) {
    short i;
    game.len = 4;
    /* Start near center, moving right. */
    for (i = 0; i < game.len; i++) {
        game.body[i].x = (short)(GRID_W / 2 - i);
        game.body[i].y = (short)(GRID_H / 2);
    }
    game.dir = DIR_RIGHT;
    game.next_dir = DIR_RIGHT;
    game.score = 0;
    game.alive = true;
    game.next_move_tick = TickCount() + MOVE_TICKS;
    seed_rng((unsigned long)TickCount() * 2654435761UL);
    place_apple();
}

static void advance_snake(void) {
    SnakeCell new_head;
    short i;
    Boolean ate;

    /* Apply buffered direction unless it's a 180° reversal. */
    if (!((game.dir == DIR_UP && game.next_dir == DIR_DOWN) ||
          (game.dir == DIR_DOWN && game.next_dir == DIR_UP) ||
          (game.dir == DIR_LEFT && game.next_dir == DIR_RIGHT) ||
          (game.dir == DIR_RIGHT && game.next_dir == DIR_LEFT))) {
        game.dir = game.next_dir;
    }

    new_head = game.body[0];
    switch (game.dir) {
        case DIR_UP:    new_head.y--; break;
        case DIR_DOWN:  new_head.y++; break;
        case DIR_LEFT:  new_head.x--; break;
        case DIR_RIGHT: new_head.x++; break;
    }

    /* Wall collision. */
    if (new_head.x < 0 || new_head.x >= GRID_W ||
        new_head.y < 0 || new_head.y >= GRID_H) {
        game.alive = false;
        return;
    }

    /* Self collision (skip the tail — it will move out of the way). */
    for (i = 0; i < game.len - 1; i++) {
        if (game.body[i].x == new_head.x && game.body[i].y == new_head.y) {
            game.alive = false;
            return;
        }
    }

    ate = (new_head.x == game.apple.x && new_head.y == game.apple.y);

    /* Shift body down. Don't shift if we just ate — let the body grow. */
    if (!ate) {
        for (i = game.len - 1; i > 0; i--) {
            game.body[i] = game.body[i - 1];
        }
    } else {
        if (game.len < SNAKE_MAX) {
            for (i = game.len; i > 0; i--) {
                game.body[i] = game.body[i - 1];
            }
            game.len++;
        }
        game.score += 10;
        place_apple();
    }
    game.body[0] = new_head;
}

/* ── Drawing ─────────────────────────────────────────────────────── */

static void cell_rect(SnakeCell c, Rect *r) {
    r->left   = GAME_LEFT + c.x * CELL_PX;
    r->top    = GAME_TOP  + c.y * CELL_PX;
    r->right  = r->left + CELL_PX - 1;
    r->bottom = r->top + CELL_PX - 1;
}

static void draw_board(void) {
    Rect frame;
    Rect cell;
    short i;

    /* Border around the game area. */
    frame.left   = GAME_LEFT - 2;
    frame.top    = GAME_TOP - 2;
    frame.right  = GAME_LEFT + GRID_W * CELL_PX + 1;
    frame.bottom = GAME_TOP + GRID_H * CELL_PX + 1;
    FrameRect(&frame);

    /* Apple — filled square. */
    cell_rect(game.apple, &cell);
    PaintRect(&cell);

    /* Snake — frame the head, fill the body. */
    for (i = 0; i < game.len; i++) {
        cell_rect(game.body[i], &cell);
        if (i == 0) {
            PaintRect(&cell);
        } else {
            FrameRect(&cell);
            /* Inner pixel of body for visibility. */
            InsetRect(&cell, 3, 3);
            PaintRect(&cell);
        }
    }
}

static const unsigned char *pascalize(const char *cstr, unsigned char *buf, short buf_size) {
    short n = 0;
    while (cstr[n] && n < buf_size - 1) {
        buf[n + 1] = (unsigned char)cstr[n];
        n++;
    }
    buf[0] = (unsigned char)n;
    return buf;
}

static void draw_score(void) {
    unsigned char buf[64];
    unsigned char pbuf[32];
    short n = 0;
    long s = game.score;
    char digits[16];
    short i;

    /* Write "Score: <n>" into buf as Pascal string. */
    {
        const char *label = "Score: ";
        pascalize(label, pbuf, sizeof(pbuf));
        for (i = 0; i < pbuf[0]; i++) buf[1 + n++] = pbuf[1 + i];
    }
    /* Format score digits manually (no stdlib). */
    if (s == 0) {
        buf[1 + n++] = '0';
    } else {
        short d = 0;
        while (s > 0 && d < 15) {
            digits[d++] = (char)('0' + (s % 10));
            s /= 10;
        }
        while (d > 0) {
            buf[1 + n++] = (unsigned char)digits[--d];
        }
    }
    buf[0] = (unsigned char)n;

    /* Erase old score by painting the line in white (text mode replace
     * already handles it; this works because the score line lives on
     * white space above the game area). */
    {
        Rect line = { SCORE_TOP - 12, GAME_LEFT, SCORE_TOP + 2,
                      GAME_LEFT + GRID_W * CELL_PX };
        EraseRect(&line);
    }
    MoveTo(GAME_LEFT, SCORE_TOP);
    DrawString(buf);
}

static void draw_game_over(void) {
    unsigned char buf[64];
    Rect overlay;
    overlay.left   = GAME_LEFT + 40;
    overlay.top    = GAME_TOP + GRID_H * CELL_PX / 2 - 18;
    overlay.right  = GAME_LEFT + GRID_W * CELL_PX - 40;
    overlay.bottom = overlay.top + 36;
    EraseRect(&overlay);
    FrameRect(&overlay);
    MoveTo(overlay.left + 8, overlay.top + 14);
    pascalize("Game over!", buf, sizeof(buf));
    DrawString(buf);
    MoveTo(overlay.left + 8, overlay.top + 28);
    pascalize("Click to restart.", buf, sizeof(buf));
    DrawString(buf);
}

static void redraw_all(void) {
    Rect bounds = win->portRect;
    EraseRect(&bounds);
    draw_score();
    draw_board();
    if (!game.alive) draw_game_over();
}

/* ── Input ───────────────────────────────────────────────────────── */

static void handle_key(EventRecord *ev) {
    /* Mac arrow keys live in ev->message's low 8 bits, mapped per the
     * Inside Macintosh "Toolbox: Events" table:
     *   left  = 0x1c    up    = 0x1e
     *   right = 0x1d    down  = 0x1f
     * (Char code stays at 0x1c..0x1f; key code differs but we don't
     * inspect the high byte.) */
    char ch = (char)(ev->message & 0xff);
    if (!game.alive) return;
    switch (ch) {
        case 0x1c: game.next_dir = DIR_LEFT;  break;
        case 0x1d: game.next_dir = DIR_RIGHT; break;
        case 0x1e: game.next_dir = DIR_UP;    break;
        case 0x1f: game.next_dir = DIR_DOWN;  break;
    }
}

/* ── Main ────────────────────────────────────────────────────────── */

QDGlobals qd;

int main(void) {
    EventRecord ev;
    long now;

    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    FlushEvents(everyEvent, 0);
    InitCursor();

    win = GetNewWindow(WINDOW_ID, NULL, (WindowPtr)(-1));
    if (!win) {
        SysBeep(10);
        return 1;
    }
    SetPort((GrafPtr)win);
    ShowWindow(win);

    reset_game();
    redraw_all();

    for (;;) {
        WaitNextEvent(everyEvent, &ev, 1, NULL);

        if (game.alive) {
            now = TickCount();
            if (now >= game.next_move_tick) {
                advance_snake();
                game.next_move_tick = now + MOVE_TICKS;
                redraw_all();
            }
        }

        switch (ev.what) {
            case keyDown:
            case autoKey:
                /* Cmd-. or Cmd-Q quits. */
                if ((ev.modifiers & cmdKey) &&
                    ((char)(ev.message & 0xff) == 'q' ||
                     (char)(ev.message & 0xff) == 'Q' ||
                     (char)(ev.message & 0xff) == '.')) {
                    return 0;
                }
                handle_key(&ev);
                break;
            case mouseDown:
                if (FindWindow(ev.where, &win) == inGoAway) return 0;
                if (!game.alive) {
                    reset_game();
                    redraw_all();
                }
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == win) {
                    BeginUpdate(win);
                    redraw_all();
                    EndUpdate(win);
                }
                break;
        }
    }
    return 0;
}
