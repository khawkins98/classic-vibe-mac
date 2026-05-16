/*
 * files.r — resources for the Wasm Files demo.
 *   - WIND 128   : 380×240 documentProc with goAway
 *   - SIZE -1    : 512 KB heap (TextEdit + StandardFile dialog)
 *   - 'CVFL' (0) : signature ("Classic Vibe FiLes")
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVFL' (0, "Owner signature") { "CVFL" };

resource 'WIND' (128) {
    { 40, 40, 280, 420 },        /* 380 × 240 */
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Files — read & write TEXT",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Files") {
    $"0080"
    $"00080000"                  /* 512 KB preferred */
    $"00080000"                  /* 512 KB minimum  */
};
