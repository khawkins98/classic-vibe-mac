/*
 * pixelpad.r — Rez resources for the classic-vibe-mac pixel editor.
 *
 * What this file does: defines every user-visible piece of chrome the
 * Mac OS Resource Manager needs to launch PixelPad — menus, a window,
 * an About alert, Finder-binding metadata, the memory-partition spec,
 * and the app icon. Rez (Apple's resource compiler, here Retro68's port)
 * compiles this into the binary resource fork of PixelPad.bin.
 *
 * Resources by type:
 *   MENU  (128, 129, 130)  Apple, File, Edit menus
 *   MBAR  (128)            wires all three MENUs into the menu bar
 *   WIND  (128)            main window position + style
 *   DITL  (128)            About-box item layout
 *   ALRT  (128)            About-box alert chrome
 *   STR   (0)              app name for Finder dialogs
 *   vers  (1)              version string (shows in Get Info)
 *   SIZE  (-1)             memory partition + Finder behaviour flags
 *   BNDL  (128)            Finder binding bundle
 *   FREF  (128)            Finder file-reference (APPL only)
 *   ICN#  (128)            32×32 1-bit app icon + mask
 *   CVPP  (0)              creator-code owner stamp
 *
 * Creator code: 'CVPP' — Classic Vibe Pixel Pad. Siblings use:
 *   'CVMR' = Reader, 'CVMW' = MacWeather, 'CVHM' = HelloMac.
 *
 * Window: 330 wide × 275 tall. Content layout:
 *   palette: left strip {4,4,268,36} — pencil + eraser tool buttons
 *   canvas:  {4,44,260,300} — 256×256 display of the 64×64 1-bit bitmap
 *   Zoomed 4× so each canvas pixel = a 4×4 screen rectangle.
 */

#include "Processes.r"
#include "Menus.r"
#include "Windows.r"
#include "Dialogs.r"
#include "MacTypes.r"

/* ------------------------------------------------------------------ Menus */

resource 'MENU' (128) {
    128, textMenuProc;
    allEnabled, enabled;
    apple;
    {
        "About Pixel Pad...", noIcon, noKey, noMark, plain;
        "-",                  noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "Save",         noIcon, "S",   noMark, plain;
        "Clear Canvas", noIcon, noKey, noMark, plain;
        "-",            noIcon, noKey, noMark, plain;
        "Quit",         noIcon, "Q",   noMark, plain;
    }
};

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

/* ----------------------------------------------------------------- Window */

/*
 * Content rect: 330 wide × 275 tall (screen pos top=100, left=50).
 * Sized to hold: left palette column (36 px) + 8 px gap + 256 px canvas
 * = 300 px total drawing area, plus 30 px right margin.
 * Canvas top=4, bottom=260 (256 px), leaving 15 px bottom margin.
 *
 * Placed in the upper-left, near Reader but slightly offset so both
 * are visible on the 640×480 emulated screen.
 */
resource 'WIND' (128) {
    { 100, 50, 375, 380 },
    documentProc,
    visible,
    goAway,
    0,
    "Pixel Pad",
    noAutoCenter
};

/* --------------------------------------------------------- About alert */

resource 'DITL' (128) {
    {
        { 100, 200, 120, 260 },
        Button { enabled, "OK" };

        { 10, 60, 30, 310 },
        StaticText { disabled, "Pixel Pad" };

        { 35, 60, 55, 310 },
        StaticText { disabled, "classic-vibe-mac, 2026." };

        { 60, 60, 80, 310 },
        StaticText { disabled, "Draw pixels. Host sees them live." };
    }
};

resource 'ALRT' (128) {
    { 70, 60, 220, 400 },
    128,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

/* ----------------------------------------------- Finder-binding bundle */

data 'CVPP' (0, "Owner signature") {
    $"09" "PixelPad 0.1"
};

/*
 * BNDL 128: wire ICN# 128 → app icon; FREF 128 → APPL entry.
 * Layout: Inside Macintosh, More Macintosh Toolbox p. 7-58.
 */
data 'BNDL' (128, "PixelPad binding") {
    $"43565050"          /* signature 'CVPP' */
    $"0000"              /* signature resource ID = 0 */
    $"0001"              /* type count − 1 (two entries) */

    $"49434E23"          /* type 'ICN#' */
    $"0000"              /* mapping count − 1 (one mapping) */
    $"0000" $"0080"      /* local 0 → ICN# 128 */

    $"46524546"          /* type 'FREF' */
    $"0000"              /* mapping count − 1 */
    $"0000" $"0080"      /* local 0 → FREF 128 */
};

data 'FREF' (128, "PixelPad app") {
    $"4150504C"          /* 'APPL' */
    $"0000"              /* local icon 0 */
    $"00"                /* empty filename */
};

/*
 * ICN# 128 — app icon + mask.
 *
 * Design: a 4×4 checkerboard of 8×8 cells — simple visual shorthand
 * for "pixel grid". Each cell is a solid 8×8 black or white square,
 * alternating like a chess board. Reads clearly at both 32×32 and
 * the 16×16 small Finder icon.
 *
 * Bit encoding: each row = 4 bytes (32 bits), bit 7 of byte 0 =
 * leftmost pixel; 1 = black (icon) or opaque (mask).
 *
 * Rows  0–7:  FF00FF00 (black|white|black|white per 8-px column)
 * Rows  8–15: 00FF00FF (white|black|white|black)
 * Rows 16–23: FF00FF00
 * Rows 24–31: 00FF00FF
 * Mask: all 1s (fully opaque).
 */
data 'ICN#' (128, "PixelPad app icon") {
    /* icon rows 0–7 */
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    /* icon rows 8–15 */
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    /* icon rows 16–23 */
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    $"FF00FF00"
    /* icon rows 24–31 */
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    $"00FF00FF"
    /* mask rows 0–31 (fully opaque) */
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
    $"FFFFFFFF"
};

/* Friendly app name */
data 'STR ' (0, "Application name") {
    $"09" "Pixel Pad"
};

/* --------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac Pixel Pad"
};

/* --------------------------------------------------------------- SIZE */

/*
 * Memory budget: 256 KB preferred / 256 KB minimum.
 *   gPixels[]   = 512 bytes
 *   QuickDraw   ≈ 10 KB heap
 *   Menu/window resources + heap overhead ≈ 50 KB
 *   256 KB is comfortable headroom.
 */
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
    notHighLevelEventAware,
    onlyLocalHLEvents,
    notStationeryAware,
    dontUseTextEditServices,
    reserved,
    reserved,
    reserved,
    256 * 1024,
    256 * 1024
};
