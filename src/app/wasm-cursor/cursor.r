/*
 * cursor.r — resources for the Wasm Cursor demo.
 *   - WIND 128   : 220×180 documentProc with goAway
 *   - SIZE -1    : 256 KB heap
 *   - 'CVCR' (0) : signature ("Classic Vibe CursoR")
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVCR' (0, "Owner signature") { "CVCR" };

resource 'WIND' (128) {
    { 50, 60, 230, 280 },        /* 220 × 180 */
    documentProc,
    visible,
    goAway,
    0,
    "Cursor demo",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Cursor") {
    $"0080"
    $"00040000"
    $"00040000"
};
