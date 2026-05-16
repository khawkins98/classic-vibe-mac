/*
 * glypha3.r — minimal Rez resources for the cv-mac onboarding port.
 *
 * The upstream `GlyphaIII.68K.project.r` file in softdorothy/Glypha3
 * is 2.7 MB of decompiled resources — sprites (PICTs), sound effects
 * (snd ), menus, dialogs, custom icons (CICN), the works. That is a
 * separate-PR effort to compile through WASM-Rez (cv-mac #233's
 * next phase). For the *compilation-feasibility* milestone — proving
 * a real 6600-line period game compiles end-to-end through our
 * in-browser cc1 → as → ld pipeline — we ship just the bare minimum
 * the game needs to *try* to start without immediate trap crashes:
 *
 *   - app signature (so the Finder treats us as an APPL)
 *   - SIZE -1 (heap allocation hint)
 *   - one empty WIND 128 (the game's main window resource — without
 *     it OpenMainWindow's GetNewWindow returns NULL and Glypha
 *     crashes immediately)
 *   - a minimal MBAR 128 with the three menus Main.c expects so
 *     InitMenubar doesn't trip
 *
 * The game won't be playable in this state — no sprites, no sounds,
 * the high-score interface will be broken — but it should boot far
 * enough to show a window and respond to events. That demonstrates
 * the compilation half of #233's "stress-test the compiler" goal.
 * Wiring up the full resource fork is its own follow-up project.
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "MacTypes.r"

data 'CVGl' (0, "Owner signature") {
    "CVGl"
};

/* SIZE -1 — give Glypha plenty of heap. The game allocates offscreen
 * GWorlds for double-buffered rendering and ~17 sound buffers; 1 MB
 * is generous. Flag 0x0080 = 32-bit clean. */
data 'SIZE' (-1, "Glypha III") {
    $"0080"                /* flags: 32-bit clean */
    $"00100000"            /* preferred: 1024 KB */
    $"00100000"            /* minimum:   1024 KB */
};

/* WIND 128 — the main game window. Glypha's OpenMainWindow expects
 * window ID 1000 typically but uses GetNewWindow on a baked-in ID;
 * we'll add 1000 too just to be safe. Both are 640×480 to fit a
 * Macintosh II era full screen. */
resource 'WIND' (128) {
    { 40, 40, 480, 680 },     /* top, left, bottom, right (640×440) */
    plainDBox,                /* borderless — matches Glypha's full-screen style */
    visible,
    noGoAway,
    0,
    "Glypha III",
    noAutoCenter
};

resource 'WIND' (1000) {
    { 40, 40, 480, 680 },
    plainDBox,
    visible,
    noGoAway,
    0,
    "Glypha III",
    noAutoCenter
};

/* MBAR 128 — three menus. The IDs match what Glypha's Interface.c
 * expects (Apple=128, File=129, Game=130). Empty menus that just
 * surface their headings; the game's DoMenuChoice will only fire
 * on visible items, so this is safe. */
resource 'MBAR' (128) {
    { 128; 129; 130 }
};

resource 'MENU' (128, "Apple") {
    128,
    textMenuProc,
    0x7ffffffd,
    enabled,
    apple,
    {
        "About Glypha III…", noIcon, noKey, noMark, plain;
        "-",                  noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129, "File") {
    129,
    textMenuProc,
    allEnabled,
    enabled,
    "File",
    {
        "Quit",               noIcon, "Q",   noMark, plain;
    }
};

resource 'MENU' (130, "Game") {
    130,
    textMenuProc,
    allEnabled,
    enabled,
    "Game",
    {
        "New Game",           noIcon, "N",   noMark, plain;
        "Pause",               noIcon, "P",   noMark, plain;
    }
};
