/*
 * calc.r — resources for Wasm Calculator (cv-mac #125).
 *
 *   - 'CVCA' signature ("Classic Vibe Calculator")
 *   - WIND 128         — 220 × 230 window with go-away box
 *   - SIZE -1          — 256 KB is plenty (no TextEdit, no scrap)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVCA' (0, "Owner signature") {
    "CVCA"
};

/* 50,80 → 280,300 = 220 wide × 230 tall, comfortably sized to fit the
 * 4×4 button grid + display panel laid out in calc.c. */
resource 'WIND' (128) {
    { 50, 80, 280, 300 },
    documentProc,
    visible,
    goAway,
    0,
    "Calculator",
    noAutoCenter
};

/* 256 KB heap — no TextEdit allocations, no scrap, no audio. The
 * default Retro68 size fork's 1 MB is overkill. */
data 'SIZE' (-1, "Wasm Calculator") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
