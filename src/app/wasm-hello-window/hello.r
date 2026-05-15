/*
 * hello.r — minimal Rez resources for the Phase B mixed-build demo
 * (cv-mac #100 Phase B).
 *
 * Two resources:
 *   - WIND 128 — the window hello.c loads via GetNewWindow(128, ...)
 *   - SIZE -1 — override the 1 MB default heap (we don't need that
 *               much; 256 KB is plenty for an empty window).
 *
 * This is deliberately the smallest .r that can demonstrate the
 * mixed-build path. Hello Mac's .r has the full Finder-binding ritual
 * (BNDL, FREF, ICN#, vers, MBAR, MENUs, ALRT/DITL); we skip all of
 * that — the demo is "see a window with text, click to dismiss."
 *
 * The Resource Manager merges this fork onto the C-built MacBinary's
 * fork via spliceResourceFork — the user's resources win on (type, id)
 * collisions, so our SIZE -1 replaces the default makeRetro68DefaultSizeFork().
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

/* Signature resource. Required by the splice path's Type/Creator
 * lock-check (runBuild rejects builds where the signature line is
 * missing). 'CVWW' = Classic Vibe Wasm Window. */
data 'CVWW' (0, "Owner signature") {
    "CVWW"
};

/* Window definition. 60,60 → 240,380 = 180 tall, 320 wide, comfortable
 * room for a single line of centred text. documentProc gives the
 * standard System 7 title bar + close box; goAway makes the close box
 * functional; visible means the window shows immediately on
 * GetNewWindow (we still call ShowWindow for explicitness). */
resource 'WIND' (128) {
    { 60, 60, 240, 380 },
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Hello — Phase B",
    noAutoCenter
};

/* SIZE resource (-1) — overrides the default 1 MB heap. 256 KB
 * preferred + minimum is more than enough for a Toolbox-only app
 * that draws one string. Flag 0x0080 = "32-bit clean" (System 7+
 * required this for apps that use addresses > 24 bits, which any
 * modern app should). */
data 'SIZE' (-1, "Wasm Hello Window") {
    $"0080"                /* flags: 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum: 256 KB */
};
