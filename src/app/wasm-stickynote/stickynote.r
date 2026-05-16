/*
 * stickynote.r — resources for the Wasm Sticky Note demo (cv-mac #125).
 *
 * Small, drag-anywhere note window with a close box:
 *   - WIND 128    : 220×140 noGrowDocProc window, visible + goAway
 *   - SIZE -1     : 256 KB heap (TextEdit + a small RGB scratch is plenty)
 *   - 'CVSN' (0)  : signature ("Classic Vibe Sticky Note")
 *
 * Why noGrowDocProc and not dBoxProc:
 *   dBoxProc would give us the classic borderless dialog frame (very
 *   sticky-note), but it strips the title bar — so we can't drag and
 *   the close box vanishes. noGrowDocProc keeps drag + close while
 *   still feeling small. The yellow paper effect comes from
 *   RGBBackColor + EraseRect inside the update handler.
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVSN' (0, "Owner signature") {
    "CVSN"
};

resource 'WIND' (128) {
    { 50, 60, 190, 280 },        /* top, left, bottom, right -> 220 wide × 140 tall */
    noGrowDocProc,
    visible,
    goAway,
    0,
    "Sticky Note",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Sticky Note") {
    $"0080"                       /* 32-bit clean */
    $"00040000"                   /* preferred: 256 KB */
    $"00040000"                   /* minimum:   256 KB */
};
