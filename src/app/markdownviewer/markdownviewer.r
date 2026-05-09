/*
 * markdownviewer.r — Rez resources for the classic-vibe-mac Markdown Viewer.
 *
 * Creator code: 'CVMV' — "Classic Vibe Markdown Viewer".
 * Document type binding: TEXT/CVMV (for .md files tagged by build-boot-disk.sh).
 *
 * Resource IDs:
 *   128 — Apple menu, MBAR, WIND, About ALRT/DITL, scroll bar CNTL, STR#
 *   129 — File menu
 *   130 — Edit menu
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
        "About Markdown Viewer...", noIcon, noKey, noMark, plain;
        "-",                        noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "Open...",  noIcon, "O", noMark, plain;
        "Close",    noIcon, "W", noMark, plain;
        "-",        noIcon, noKey, noMark, plain;
        "Quit",     noIcon, "Q", noMark, plain;
    }
};

/* Edit menu left disabled — desk accessories grab Cut/Copy/Paste. */
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

/* 480 × 340, documentProc with grow + go-away. */
resource 'WIND' (128) {
    { 40, 40, 380, 520 },
    documentProc,
    visible,
    goAway,
    0,
    "Markdown Viewer",
    noAutoCenter
};

/* --------------------------------------------------------------- Strings */

/*
 * STR# 128 layout:
 *   1  ":Shared:"         — shared volume prefix (baked at build time)
 *   2  "README.md"        — default landing document
 *   3  "(no document)"    — placeholder title
 *   4  "Markdown Viewer"  — app name (alert headers)
 *   5  fallback text shown when :Shared: is missing
 */
resource 'STR#' (128) {
    {
        ":Shared:";
        "README.md";
        "(no document)";
        "Markdown Viewer";
        "No document found.\n\nThe host page should mount a folder of Markdown "
        "files as :Shared:. Add a README.md to src/web/public/shared/ and "
        "redeploy to populate the viewer.";
    }
};

/* --------------------------------------------------------- About alert */

resource 'DITL' (128) {
    {
        { 96, 240, 116, 300 },
        Button { enabled, "OK" };

        { 10, 70, 30, 320 },
        StaticText { disabled, "classic-vibe-mac Markdown Viewer" };

        { 35, 70, 55, 320 },
        StaticText { disabled, "A Markdown reader in C, built with Retro68." };

        { 60, 70, 80, 320 },
        StaticText { disabled, "Opens .md files from :Shared:." };
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

/* ----------------------------------------------- Finder-binding bundle */

/*
 * Application signature.  Resource type = creator code, ID 0.
 */
data 'CVMV' (0, "Owner signature") {
    $"12" "MarkdownViewer 0.1"
};

/*
 * BNDL 128 — binds ICN# + FREF entries to the creator code.
 */
data 'BNDL' (128, "MarkdownViewer binding") {
    $"43564D56"          /* 'CVMV' */
    $"0000"              /* signature resource ID = 0 */
    $"0001"              /* 2 resource types */

    $"49434E23"          /* 'ICN#' */
    $"0001"              /* 2 mappings */
    $"0000" $"0080"      /* local 0 → ICN# 128 (app) */
    $"0001" $"0081"      /* local 1 → ICN# 129 (doc) */

    $"46524546"          /* 'FREF' */
    $"0001"              /* 2 mappings */
    $"0000" $"0080"      /* local 0 → FREF 128 (app) */
    $"0001" $"0081"      /* local 1 → FREF 129 (.md docs) */
};

/* FREF 128 — the application itself. */
data 'FREF' (128, "MarkdownViewer app") {
    $"4150504C"          /* 'APPL' */
    $"0000"              /* local icon 0 */
    $"00"
};

/* FREF 129 — Markdown documents tagged TEXT/CVMV by build-boot-disk.sh. */
data 'FREF' (129, "MarkdownViewer doc") {
    $"54455854"          /* 'TEXT' */
    $"0001"              /* local icon 1 */
    $"00"
};

/*
 * ICN# 128 — app icon: "M" for Markdown inside a rounded rectangle.
 * ICN# 129 — doc icon: page with corner fold.
 */

data 'ICN#' (128, "MarkdownViewer app icon") {
    /* icon — stylised 'M' inside a rounded-rect outline */
    $"00000000" $"3FFFFFFC" $"40000002" $"40000002"
    $"40000002" $"43C003C2" $"43C003C2" $"43C003C2"
    $"43E007C2" $"43F00FC2" $"43BC1BC2" $"43BE3BC2"
    $"43830382" $"43830382" $"43830382" $"40000002"
    $"40000002" $"40000002" $"40000002" $"40000002"
    $"40000002" $"40000002" $"40000002" $"40000002"
    $"40000002" $"40000002" $"40000002" $"40000002"
    $"40000002" $"40000002" $"3FFFFFFC" $"00000000"
    /* mask */
    $"00000000" $"3FFFFFFC" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"3FFFFFFC" $"00000000"
};

data 'ICN#' (129, "MarkdownViewer doc icon") {
    /* icon — page with folded top-right corner */
    $"00000000" $"1FFE0000" $"10030000" $"10050000"
    $"10090000" $"10110000" $"10210000" $"10410000"
    $"10810000" $"11FF8000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"1FFFC000" $"00000000"
    /* mask */
    $"00000000" $"1FFE0000" $"1FFF0000" $"1FFF8000"
    $"1FFFC000" $"1FFFE000" $"1FFFF000" $"1FFFF800"
    $"1FFFFC00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"00000000"
};

/* Friendly app name in Get Info dialogs. */
data 'STR ' (0, "Application name") {
    $"0F" "Markdown Viewer"
};

/* -------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac Markdown Viewer"
};

/* -------------------------------------------------------------- SIZE */

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
    512 * 1024,
    512 * 1024
};
