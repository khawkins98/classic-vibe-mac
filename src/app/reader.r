/*
 * reader.r — Rez resources for the classic-vibe-mac HTML viewer ("Reader").
 *
 * Compiled by Retro68's Rez. Resource IDs:
 *   128 — Apple menu / MBAR / WIND / About ALRT/DITL / scrollbar CNTL /
 *         STR# (UI strings + fallback HTML)
 *   129 — File menu
 *   130 — Edit menu / "note" alert
 *   131 — View menu
 *
 * Window: 480x340 documentProc with grow box. Big enough to read a few
 * paragraphs without horizontal cramp; small enough to fit at System 7
 * default 640x480.
 */

#include "Processes.r"
#include "Menus.r"
#include "Windows.r"
#include "Dialogs.r"
#include "Controls.r"
#include "MacTypes.r"

/* ------------------------------------------------------------------ Menus */

resource 'MENU' (128) {
    128, textMenuProc;
    allEnabled, enabled;
    apple;
    {
        "About Reader...", noIcon, noKey, noMark, plain;
        "-",               noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "Open...",  noIcon, "O",   noMark, plain;
        "Close",    noIcon, "W",   noMark, plain;
        "-",        noIcon, noKey, noMark, plain;
        "Quit",     noIcon, "Q",   noMark, plain;
    }
};

/* Edit menu items left disabled so System 7 desk accessories can still
 * grab Cut/Copy/Paste via SystemEdit. */
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

resource 'MENU' (131) {
    131, textMenuProc;
    allEnabled, enabled;
    "View";
    {
        "Reload",   noIcon, "R", noMark, plain;
        "Back",     noIcon, "[", noMark, plain;
    }
};

resource 'MBAR' (128) {
    { 128, 129, 130, 131 };
};

/* ----------------------------------------------------------------- Window */

/* Content rect: 480 wide x 340 tall (top, left, bottom, right). */
resource 'WIND' (128) {
    { 40, 40, 380, 520 },
    documentProc,
    visible,
    goAway,
    0,
    "Reader",
    noAutoCenter
};

/* ----------------------------------------------------------- Scroll bar */

/* Placeholder — the actual bounds are set at runtime by ConfigureScrollBar
 * based on the window's current size. We still define a CNTL so resources
 * are loadable if a future NewControl uses GetNewControl instead. */
resource 'CNTL' (128) {
    { 0, 0, 100, 16 },
    0, visible, 0, 0,
    scrollBarProc, 0,
    ""
};

/* ----------------------------------------------------------- Strings */

/*
 * STR# 128 layout:
 *   1  ":Shared:"           — path prefix to the extfs share
 *   2  "index.html"         — default landing doc
 *   3  "(no document)"      — placeholder window title
 *   4  "Reader"             — short app name (alert headers, etc.)
 *   5  fallback HTML body shown when :Shared: is missing or empty
 */
resource 'STR#' (128) {
    {
        ":Shared:";
        "index.html";
        "(no document)";
        "Reader";
        "<h1>No content found</h1>"
        "<p>The host page is supposed to mount a folder of HTML files "
        "as a Mac volume named <b>Shared</b>, with at least an "
        "<b>index.html</b> at the top level.</p>"
        "<p>If you are seeing this, the JS host has not yet wired the "
        "extfs share, or the share is empty. Add HTML files to "
        "<i>src/web/public/shared/</i> in the repo, redeploy, and "
        "Reader will pick them up on the next launch.</p>";
    }
};

/* --------------------------------------------------------- About alert */

resource 'DITL' (128) {
    {
        { 96, 240, 116, 300 },
        Button { enabled, "OK" };

        { 10, 70, 30, 320 },
        StaticText { disabled, "classic-vibe-mac Reader" };

        { 35, 70, 55, 320 },
        StaticText { disabled, "An HTML viewer in C, built with Retro68." };

        { 60, 70, 80, 320 },
        StaticText { disabled, "Reads :Shared: files mounted from the host page." };
    }
};

resource 'ALRT' (128) {
    { 60, 60, 200, 400 },
    128,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

/* --------------------------------------------------------- Note alert */

resource 'DITL' (130) {
    {
        { 60, 220, 80, 290 },
        Button { enabled, "OK" };

        { 10, 70, 50, 300 },
        StaticText { disabled, "^0" };
    }
};

resource 'ALRT' (130) {
    { 60, 60, 160, 380 },
    130,
    {
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

/* --------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac Reader"
};

/* ---------------------------------------------------------- SIZE / Finder */

/* Reader needs a bit more memory than Minesweeper because it holds the
 * raw HTML buffer + the layout strpool + the DrawOp array. 256K each is
 * comfortable headroom. */
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
    256 * 1024,
    256 * 1024
};
