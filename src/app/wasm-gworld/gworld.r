/*
 * gworld.r — resources for the Wasm GWorld demo.
 *   - WIND 128   : 340×220 documentProc with goAway
 *   - SIZE -1    : 512 KB heap (GWorld + redraw scratch)
 *   - 'CVGW' (0) : signature ("Classic Vibe GWorld")
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVGW' (0, "Owner signature") { "CVGW" };

resource 'WIND' (128) {
    { 50, 60, 270, 400 },        /* 340 × 220 */
    documentProc,
    visible,
    goAway,
    0,
    "GWorld double-buffer",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm GWorld") {
    $"0080"
    $"00080000"
    $"00080000"
};
