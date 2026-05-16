/*
 * console.r — resources for the Debug Console demo.
 *
 *   - 'CVDC' signature ("Classic Vibe Debug Console")
 *   - SIZE -1   — 256 KB; the demo allocates nothing of consequence
 *   - the window is built at runtime via NewWindow, no WIND resource
 *     needed
 */

#include "Processes.r"
#include "MacTypes.r"

data 'CVDC' (0, "Owner signature") {
    "CVDC"
};

data 'SIZE' (-1, "cvm Debug Console") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
