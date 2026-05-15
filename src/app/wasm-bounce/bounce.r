/*
 * bounce.r — resources for Wasm Bounce (cv-mac #125).
 *
 *   - 'CVBO' signature ("Classic Vibe Bounce")
 *   - WIND 128         — 260 × 220 window with go-away box
 *   - SIZE -1          — 512 KB (the 240×180 1-bit offscreen buffer
 *                        is ~5 KB; bump the budget to comfortably
 *                        accommodate the GrafPort + clipRgn machinery)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVBO' (0, "Owner signature") {
    "CVBO"
};

resource 'WIND' (128) {
    { 50, 80, 270, 340 },
    documentProc,
    visible,
    goAway,
    0,
    "Bounce",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Bounce") {
    $"0080"                /* 32-bit clean */
    $"00080000"            /* preferred: 512 KB */
    $"00080000"            /* minimum:   512 KB */
};
