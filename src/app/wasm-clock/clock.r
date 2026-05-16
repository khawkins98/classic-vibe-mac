/*
 * clock.r — resources for the Wasm Clock demo (cv-mac #125).
 *
 * Compact analog desk clock with a digital readout below:
 *   - WIND 128   : 184×210 noGrowDocProc window with goAway box
 *   - SIZE -1    : 256 KB heap (no TextEdit, no scrap — tiny app)
 *   - 'CVCK' (0) : signature ("Classic Vibe ClocK")
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVCK' (0, "Owner signature") {
    "CVCK"
};

resource 'WIND' (128) {
    { 60, 80, 270, 264 },        /* top, left, bottom, right -> 184 wide × 210 tall */
    noGrowDocProc,
    visible,
    goAway,
    0,
    "Clock",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Clock") {
    $"0080"                       /* 32-bit clean */
    $"00040000"                   /* preferred: 256 KB */
    $"00040000"                   /* minimum:   256 KB */
};
