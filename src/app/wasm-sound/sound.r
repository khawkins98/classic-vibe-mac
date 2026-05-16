/*
 * sound.r — resources for Wasm Sound (cv-mac #125).
 *
 *   - 'CVSO' signature ("Classic Vibe SOund")
 *   - WIND 128         — main window with the two beep buttons
 *   - SIZE -1          — 256 KB (no TextEdit, no scrap; pure SysBeep)
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

data 'CVSO' (0, "Owner signature") {
    "CVSO"
};

resource 'WIND' (128) {
    { 60, 60, 200, 320 },
    documentProc,
    visible,
    goAway,
    0,
    "Sound",
    noAutoCenter
};

data 'SIZE' (-1, "Wasm Sound") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
