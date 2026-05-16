/*
 * multiwin.r — resources for the Wasm Multi-Window demo.
 *
 * One WIND template — we GetNewWindow three times against it and
 * stagger each clone via MoveWindow at runtime so they don't pile up.
 *   - WIND 128   : 200×120 documentProc with goAway box
 *   - SIZE -1    : 256 KB heap (no TextEdit, no scrap — tiny app)
 *   - 'CVMW' (0) : signature ("Classic Vibe MultiWin")
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVMW' (0, "Owner signature") {
    "CVMW"
};

resource 'WIND' (128) {
    { 40, 40, 160, 240 },       /* top, left, bottom, right -> 200 wide × 120 tall */
    documentProc,
    visible,
    goAway,
    0,
    "Window",                    /* refined per-clone by DrawWin via refCon */
    noAutoCenter
};

data 'SIZE' (-1, "Wasm MultiWin") {
    $"0080"                      /* 32-bit clean */
    $"00040000"                  /* preferred: 256 KB */
    $"00040000"                  /* minimum:   256 KB */
};
