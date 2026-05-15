/*
 * notepad.r — resources for the Wasm Notepad demo (cv-mac #125).
 *
 * Adds a real Mac menu bar to the textedit foundation:
 *   - MBAR 128                : the bar; references three MENUs below
 *   - MENU 128 (Apple)        : "" mark + About; AppendResMenu appends DAs
 *   - MENU 129 (File)         : New, --, Quit
 *   - MENU 130 (Edit)         : Undo (greyed), --, Cut/Copy/Paste/Clear
 *   - WIND 128                : the editor window
 *   - ALRT 128 + DITL 128     : about-this-app one-button dialog
 *   - SIZE -1                 : 512 KB heap (TextEdit + scrap headroom)
 *   - 'CVNP' (0)              : signature ("Classic Vibe NotePad")
 *
 * The Apple menu's "" text is the special character (Char 20) the
 * MacRoman codepage maps to the rainbow apple glyph; Rez parses the
 * bare quote sequence and the system uses it as the menu title.
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "Dialogs.r"
#include "MacTypes.r"

data 'CVNP' (0, "Owner signature") {
    "CVNP"
};

/* Menu bar resource: a list of MENU IDs the system installs in order. */
resource 'MBAR' (128) {
    { 128, 129, 130 };
};

/* Apple menu. The "\$14" (0x14) character is the Mac OS apple glyph in
 * MacRoman; that's what triggers the rainbow rendering on the menubar. */
resource 'MENU' (128, "Apple") {
    128,
    textMenuProc,
    0x7FFFFFFD,         /* enable Apple + About; system fills DA enables */
    enabled,
    apple,
    {
        "About Wasm Notepad…", noIcon, noKey, noMark, plain;
        "-",                   noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129, "File") {
    129,
    textMenuProc,
    allEnabled,
    enabled,
    "File",
    {
        "New",   noIcon, "N", noMark, plain;
        "-",     noIcon, noKey, noMark, plain;
        "Quit",  noIcon, "Q", noMark, plain;
    }
};

resource 'MENU' (130, "Edit") {
    130,
    textMenuProc,
    0b1111111111111111111111111111101, /* Undo disabled (bit 1 = 0) */
    enabled,
    "Edit",
    {
        "Undo",    noIcon, "Z", noMark, plain;
        "-",       noIcon, noKey, noMark, plain;
        "Cut",     noIcon, "X", noMark, plain;
        "Copy",    noIcon, "C", noMark, plain;
        "Paste",   noIcon, "V", noMark, plain;
        "Clear",   noIcon, noKey, noMark, plain;
    }
};

/* Window — placed below the menu bar (top=40) with 320×420 inside area. */
resource 'WIND' (128) {
    { 40, 40, 360, 540 },
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Notepad — try the menus",
    noAutoCenter
};

/* About box: a one-button modal with a short message. */
resource 'ALRT' (128) {
    { 80, 80, 220, 380 },
    128,                 /* DITL id */
    { OK, OK, OK, OK },  /* stop-style on all stages */
    alertPositionMainScreen
};

resource 'DITL' (128) {
    {
        { 105, 220, 125, 280 },
        Button { enabled, "OK" };

        { 15, 60, 95, 280 },
        StaticText {
            disabled,
            "Wasm Notepad\n"
            "Built in your browser by classic-vibe-mac.\n"
            "Use the File and Edit menus to drive TextEdit."
        };
    }
};

data 'SIZE' (-1, "Wasm Notepad") {
    $"0080"                /* 32-bit clean */
    $"00080000"            /* preferred: 512 KB */
    $"00080000"            /* minimum:   512 KB */
};
