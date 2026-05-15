/*
 * snake.r — resources for the Snake demo (cv-mac #100 Phase D).
 *
 * Minimal: a window definition + signature + SIZE override. The game
 * code in snake.c provides all menu handling via raw keyboard events
 * (Cmd-Q to quit, click to restart on game over), so we skip the
 * full MBAR + MENU + BNDL ritual.
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVSN' (0, "Owner signature") {
    "CVSN"
};

/* Window: 360 wide × 260 tall, plenty of room for the 336×224 game
 * area + score line at the top. documentProc gives the standard
 * title bar + close box; visible so GetNewWindow shows it
 * automatically. */
resource 'WIND' (128) {
    { 50, 50, 310, 410 },
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Snake",
    noAutoCenter
};

/* SIZE -1 — 384 KB heap. Snake's 24×16 grid + body buffer fit in
 * single-digit KB; the rest is libretrocrt's startup needs. Flag
 * 0x0080 = 32-bit clean. */
data 'SIZE' (-1, "Wasm Snake") {
    $"0080"                /* flags: 32-bit clean */
    $"00060000"            /* preferred: 384 KB */
    $"00060000"            /* minimum:   384 KB */
};
