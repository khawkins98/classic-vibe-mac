/*
 * minesweeper.r — Rez resources for the Mac OS Minesweeper app.
 *
 * Compiled by Retro68's Rez. Resource IDs follow Apple's convention:
 *   128 — main MBAR / WIND / Apple menu
 *   129 — File menu
 *   130 — Edit menu
 *   128 — About box ALRT/DITL
 *
 * The window is sized for a 9x9 board at 16px per cell (144px) plus a
 * 32px header strip for the mine counter on the left and a status string
 * on the right. Total content area: 144 wide x 176 tall.
 */

#include "Processes.r"
#include "Menus.r"
#include "Windows.r"
#include "Dialogs.r"
#include "MacTypes.r"

/* ---------------------------------------------------------------- Menus */

resource 'MENU' (128) {
    128, textMenuProc;
    allEnabled, enabled;
    apple;
    {
        "About Minesweeper...", noIcon, noKey, noMark, plain;
        "-",                    noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "New Game", noIcon, "N", noMark, plain;
        "-",        noIcon, noKey, noMark, plain;
        "Quit",     noIcon, "Q", noMark, plain;
    }
};

/* Edit menu items are mostly stubs; we leave them disabled by default
 * so System 7 desk accessories can still grab Cut/Copy/Paste. */
resource 'MENU' (130) {
    130, textMenuProc;
    0, enabled;
    "Edit";
    {
        "Undo",  noIcon, "Z", noMark, plain;
        "-",     noIcon, noKey, noMark, plain;
        "Cut",   noIcon, "X", noMark, plain;
        "Copy",  noIcon, "C", noMark, plain;
        "Paste", noIcon, "V", noMark, plain;
        "Clear", noIcon, noKey, noMark, plain;
    }
};

resource 'MBAR' (128) {
    { 128, 129, 130 };
};

/* --------------------------------------------------------------- Window */

/* Content rect: 176 tall x 144 wide. (top, left, bottom, right).
 * documentProc gives a draggable, closeable, non-growable window. */
resource 'WIND' (128) {
    { 60, 60, 236, 204 },
    documentProc,
    visible,
    goAway,
    0,
    "Minesweeper",
    noAutoCenter
};

/* --------------------------------------------------------------- Strings */

resource 'STR#' (128) {
    {
        "You hit a mine. Try again?";    /* 1: lose */
        "You won! Play again?";          /* 2: win */
    }
};

/* ----------------------------------------------------------- About alert */

resource 'DITL' (128) {
    {
        { 80, 240, 100, 300 },
        Button { enabled, "OK" };

        { 10, 70, 30, 310 },
        StaticText { disabled, "classic-vibe-mac Minesweeper" };

        { 35, 70, 55, 310 },
        StaticText { disabled, "Built with Retro68. 2026." };

        { 60, 70, 76, 310 },
        StaticText { disabled, "9x9 board, 10 mines." };
    }
};

resource 'ALRT' (128) {
    { 60, 60, 180, 380 },
    128,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

/* --------------------------- Confirmation alert (lose / win → New Game?) */

resource 'DITL' (129) {
    {
        { 60, 200, 80, 270 },
        Button { enabled, "New Game" };

        { 60, 110, 80, 180 },
        Button { enabled, "Cancel" };

        { 10, 70, 50, 290 },
        StaticText { disabled, "^0" };
    }
};

resource 'ALRT' (129) {
    { 60, 60, 160, 360 },
    129,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

/* ------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac"
};

/* --------------------------------------------------------- SIZE / Finder */

resource 'SIZE' (-1) {
    reserved,
    acceptSuspendResumeEvents,
    reserved,
    canBackground,
    doesActivateOnFGSwitch,
    backgroundAndForeground,
    dontGetFrontClicks,
    ignoreChildDiedEvents,
    is32BitCompatible,
    isHighLevelEventAware,
    onlyLocalHLEvents,
    notStationeryAware,
    dontUseTextEditServices,
    reserved,
    reserved,
    reserved,
    100 * 1024,
    100 * 1024
};
