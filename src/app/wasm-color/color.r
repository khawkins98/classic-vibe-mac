/*
 * color.r — resources for Wasm Color (cv-mac #125).
 *
 *   - 'CVCR' signature ("Classic Vibe ColoR")
 *   - WIND 128         — 300 × 180 window
 *   - SIZE -1          — 256 KB (pure QuickDraw)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVCR' (0, "Owner signature") {
    "CVCR"
};

resource 'WIND' (128) {
    { 50, 50, 230, 350 },
    documentProc,
    visible,
    goAway,
    0,
    "Color QuickDraw",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Color") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
