/*
 * scrollwin.r — resources for Wasm ScrollWin (cv-mac #125).
 *
 *   - 'CVSW' signature ("Classic Vibe ScrollWin")
 *   - WIND 128         — 300 × 280 list window with go-away box
 *   - SIZE -1          — 256 KB (no TextEdit, no scrap, no audio)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVSW' (0, "Owner signature") {
    "CVSW"
};

resource 'WIND' (128) {
    { 50, 60, 330, 360 },
    documentProc,
    visible,
    goAway,
    0,
    "Scrolling List",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm ScrollWin") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
