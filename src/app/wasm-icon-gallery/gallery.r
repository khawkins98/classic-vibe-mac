/*
 * gallery.r — resources for wasm-icon-gallery.
 *
 * Standard fare: WIND, MBAR + two MENUs, ALRT for About + its
 * DITL. No custom icon (the demo's whole point is that icons
 * live in the EXTERNAL icons.rsrc file shipped alongside this app
 * by the splice infrastructure).
 *
 * The app's own resource fork is intentionally minimal — every
 * visible icon comes from icons.rsrc via OpenResFile +
 * GetResource at runtime. That's what makes this the 6-star
 * demo: the binary asset isn't compiled into the app, it ships
 * alongside as a separately-loaded file.
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "MacTypes.r"
#include "Dialogs.r"

data 'CVIG' (0, "Owner signature") {
    "CVIG"
};

data 'SIZE' (-1, "Wasm Icon Gallery") {
    $"0080"                /* flags: 32-bit clean */
    $"00060000"            /* preferred: 384 KB */
    $"00060000"            /* minimum:   384 KB */
};

resource 'WIND' (128) {
    { 40, 40, 320, 400 },     /* top, left, bottom, right (360×280) */
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Icon Gallery",
    noAutoCenter
};

resource 'MBAR' (128) {
    { 128; 129 }
};

resource 'MENU' (128, "Apple") {
    128,
    textMenuProc,
    0x7ffffffd,
    enabled,
    apple,
    {
        "About Wasm Icon Gallery…", noIcon, noKey, noMark, plain;
        "-",                          noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129, "File") {
    129,
    textMenuProc,
    allEnabled,
    enabled,
    "File",
    {
        "Quit",                       noIcon, "Q",   noMark, plain;
    }
};

resource 'ALRT' (128) {
    { 60, 60, 220, 400 },
    128,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

resource 'DITL' (128) {
    {
        /* OK button */
        { 124, 252, 144, 320 },
        Button { enabled, "OK" };

        /* Title */
        { 16, 16, 36, 320 },
        StaticText { disabled, "Wasm Icon Gallery" };

        /* Blurb */
        { 44, 16, 116, 320 },
        StaticText { disabled,
            "Six icons loaded from icons.rsrc — a separate binary "
            "resource file shipped alongside this app. The asset is "
            "generated offline by build-icon-gallery-rsrc.mjs and "
            "spliced onto the disk by the cv-mac build pipeline. "
            "6-star tier of the cv-mac shelf."
        };
    }
};
