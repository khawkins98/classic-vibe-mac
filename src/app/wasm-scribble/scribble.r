/*
 * scribble.r — resources for Wasm Scribble (cv-mac #125).
 *
 *   - 'CVSC' signature ("Classic Vibe Scribble")
 *   - WIND 128         — 300 × 220 window with go-away box
 *   - SIZE -1          — 256 KB (no TextEdit, no scrap)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVSC' (0, "Owner signature") {
    "CVSC"
};

/* 60,40 → 280,340 = 220 tall × 300 wide. Tall enough that the Clear
 * button + hint don't crowd the drawing area below. */
resource 'WIND' (128) {
    { 60, 40, 280, 340 },
    documentProc,
    visible,
    goAway,
    0,
    "Scribble",
    noAutoCenter
};

/* 256 KB heap — no TextEdit / scrap / audio. */
data 'SIZE' (-1, "Wasm Scribble") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
