/*
 * patterns.r — resources for Wasm Patterns (cv-mac #125).
 *
 *   - 'CVPT' signature ("Classic Vibe PaTterns")
 *   - WIND 128         — 320 × 320 gallery window
 *   - SIZE -1          — 256 KB (pure QuickDraw; no TextEdit / audio)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVPT' (0, "Owner signature") {
    "CVPT"
};

/* 50,50 → 370,370 = 320 × 320, fits the 4×3 swatch grid + title +
 * labels comfortably. */
resource 'WIND' (128) {
    { 50, 50, 370, 370 },
    documentProc,
    visible,
    goAway,
    0,
    "QuickDraw Patterns",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Patterns") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
