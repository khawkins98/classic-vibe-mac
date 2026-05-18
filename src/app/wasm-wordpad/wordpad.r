/*
 * wordpad.r — resources for the Wasm WordPad (mini word processor) demo
 * (cv-mac #125).
 *
 * Adds Font/Size/Style menus on top of Notepad's Apple/File/Edit bar:
 *   - MBAR 128        : Apple, File, Edit, Font, Size, Style
 *   - MENU 128 (Apple)
 *   - MENU 129 (File) : New, --, Quit
 *   - MENU 130 (Edit) : Undo (greyed), --, Cut/Copy/Paste/Clear
 *   - MENU 131 (Font) : Geneva, Chicago, Monaco, Courier
 *   - MENU 132 (Size) : 9, 10, 12, 14, 18, 24
 *   - MENU 133 (Style): Plain, Bold, Italic, Underline
 *   - WIND 128        : 380×280 editor window
 *   - ALRT 128 + DITL 128 : About dialog
 *   - SIZE -1         : 512 KB heap (TextEdit + scrap)
 *   - 'CVWP' (0)      : signature ("Classic Vibe WordPad")
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "Dialogs.r"
#include "MacTypes.r"

data 'CVWP' (0, "Owner signature") {
    "CVWP"
};

resource 'MBAR' (128) {
    { 128, 129, 130, 131, 132, 133 };
};

resource 'MENU' (128, "Apple") {
    128, textMenuProc, 0x7FFFFFFD, enabled, apple,
    {
        "About Wasm WordPad…", noIcon, noKey, noMark, plain;
        "-",                    noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129, "File") {
    129, textMenuProc, allEnabled, enabled, "File",
    {
        "New",  noIcon, "N",   noMark, plain;
        "-",    noIcon, noKey, noMark, plain;
        "Quit", noIcon, "Q",   noMark, plain;
    }
};

resource 'MENU' (130, "Edit") {
    130, textMenuProc, 0b1111111111111111111111111111101, enabled, "Edit",
    {
        "Undo",  noIcon, "Z",   noMark, plain;
        "-",     noIcon, noKey, noMark, plain;
        "Cut",   noIcon, "X",   noMark, plain;
        "Copy",  noIcon, "C",   noMark, plain;
        "Paste", noIcon, "V",   noMark, plain;
        "Clear", noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (131, "Font") {
    131, textMenuProc, allEnabled, enabled, "Font",
    {
        "Geneva",  noIcon, noKey, noMark, plain;
        "Chicago", noIcon, noKey, noMark, plain;
        "Monaco",  noIcon, noKey, noMark, plain;
        "Courier", noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (132, "Size") {
    132, textMenuProc, allEnabled, enabled, "Size",
    {
        "9",   noIcon, noKey, noMark, plain;
        "10",  noIcon, noKey, noMark, plain;
        "12",  noIcon, noKey, noMark, plain;
        "14",  noIcon, noKey, noMark, plain;
        "18",  noIcon, noKey, noMark, plain;
        "24",  noIcon, noKey, noMark, plain;
    }
};

/* Style menu — items get the bold/italic/underline face decorations
 * applied to their own labels (classic Mac convention so the menu
 * is self-documenting). Plain has no decoration. */
/* Face mask for each item is the byte at the end. Our cv-mac
 * Multiverse.r stub's MENU template only declares `plain` as a named
 * byte value; bold/italic/underline aren't enum'd, so we use the
 * literal face-bit values (Inside Mac: bold=1, italic=2, underline=4).
 * The label-side decoration (bold/italic/etc on the menu item text
 * itself) would come from a separate "label face" field that this
 * cv-mac stub template doesn't carry — items render in plain text.*/
resource 'MENU' (133, "Style") {
    133, textMenuProc, allEnabled, enabled, "Style",
    {
        "Plain",     noIcon, noKey, noMark, plain;
        "Bold",      noIcon, "B",   noMark, 0x01;   /* bold */
        "Italic",    noIcon, "I",   noMark, 0x02;   /* italic */
        "Underline", noIcon, "U",   noMark, 0x04;   /* underline */
    }
};

resource 'WIND' (128) {
    { 40, 40, 320, 420 },        /* 380 × 280 */
    documentProc,
    visible,
    goAway,
    0,
    "Wasm WordPad — Font / Size / Style live in the menus",
    noAutoCenter
};

/* ALRT stages array — one record per of 4 click stages, each is
 * (default-button, visibility, sound-mask). The previous
 * "{ OK, OK, OK, OK }" shorthand was missing fields per the
 * Multiverse.r ALRT template (3 fields per stage) and tripped
 * wasm-rez's assertion at ResourceDefinitions.cc:253. */
resource 'ALRT' (128) {
    { 80, 80, 240, 400 },
    128,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent
    },
    alertPositionMainScreen
};

resource 'DITL' (128) {
    {
        { 125, 240, 145, 300 },
        Button { enabled, "OK" };

        { 15, 60, 115, 300 },
        StaticText {
            disabled,
            "Wasm WordPad\n"
            "Built in your browser by classic-vibe-mac.\n"
            "Monostyle TextEdit driven by Font / Size / Style menus.\n"
            "Each change re-styles the whole document at once."
        };
    }
};

data 'SIZE' (-1, "Wasm WordPad") {
    $"0080"                /* 32-bit clean */
    $"00080000"            /* preferred: 512 KB */
    $"00080000"            /* minimum:   512 KB */
};
