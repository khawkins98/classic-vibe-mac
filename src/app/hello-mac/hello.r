/*
 * hello.r — Rez resources for Hello Mac, the smallest possible classic
 * Mac Toolbox application.
 *
 * Compiled by Retro68's Rez. Resource IDs:
 *   128 — Apple menu / MBAR / WIND / About ALRT/DITL /
 *         STR# (UI strings) / signature 'CVHM' / BNDL / FREF / ICN# /
 *         vers / SIZE
 *   129 — File menu
 *   130 — Edit menu
 *
 * Every resource here matches the on-disk wire format the Resource
 * Manager expects. For longer-form explanations of each resource type
 * (BNDL, FREF, ICN# layouts, signature ritual), see the comments in
 * src/app/reader/reader.r — that file documents the Finder-binding
 * dance in depth.
 *
 * Window: 320x180 documentProc, no grow box. Big enough to host a
 * centred "Hello, World!" with a comfortable margin; small enough to
 * sit unobtrusively on a System 7 default 640x480 desktop.
 */

#include "Processes.r"
#include "Menus.r"
#include "Windows.r"
#include "Dialogs.r"
#include "MacTypes.r"
/* Controls.r and Finder.r are not part of Retro68's RIncludes — the
 * multiversal Rez headers focus on programmatic interfaces and don't
 * ship resource-type definitions for CNTL, BNDL, FREF, or ICN#. We
 * don't use any controls; the Finder-binding resources below are
 * emitted as raw `data` blobs in the on-disk wire format. Same
 * pattern reader.r uses — see its comments for the byte layouts. */

/*
 * Creator code: 'CVHM' — "Classic Vibe Hello Mac". Uppercase to stay
 * clear of Apple's reserved lowercase/digit-only space; not registered
 * with Apple's historical creator-code DB but unlikely to collide
 * with any classic-era shipped app. Once chosen, we live with it
 * forever.
 *
 * Standard Finder-binding ritual:
 *   - signature resource (type='CVHM', ID=0)  → registers the creator
 *   - BNDL 128                                → binds signature + FREF + ICN#
 *   - FREF 128 ('APPL', local 0)              → the app itself
 *   - ICN# 128                                → app icon
 *   - STR  0                                  → friendly app name
 *
 * Hello Mac doesn't own any document type, so there's only one FREF
 * and one ICN# (Reader has two of each — one for itself, one for HTML
 * docs).
 */

/* ------------------------------------------------------------------ Menus */

resource 'MENU' (128) {
    128, textMenuProc;
    allEnabled, enabled;
    apple;
    {
        "About Hello Mac...", noIcon, noKey, noMark, plain;
        "-",                  noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "Quit",  noIcon, "Q", noMark, plain;
    }
};

/* Edit menu: items left disabled at the menu level (the `0` in the
 * second slot, vs. `allEnabled`), so System 7 desk accessories can
 * still grab Cut/Copy/Paste via SystemEdit but Hello Mac itself
 * doesn't pretend to support them. */
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

/* Content rect: 320 wide x 180 tall (top, left, bottom, right).
 * Position 60,60 puts it near the top-left of a 640x480 screen with
 * room for the menu bar above. documentProc is the standard
 * title-bar + close-box variant, no grow box (Hello Mac has nothing
 * to resize toward). */
resource 'WIND' (128) {
    { 60, 60, 240, 380 },
    documentProc,
    visible,
    goAway,
    0,
    "Hello Mac",
    noAutoCenter
};

/* ----------------------------------------------------------- Strings */

/*
 * STR# 128: not strictly required for an app this simple, but useful
 * for translators and as a discoverable place to edit the visible
 * window title. The C side doesn't load these (it uses a Pascal
 * literal directly in DrawWindowContent); they're documented here
 * mostly for symmetry with reader.r and for future translators.
 */
resource 'STR#' (128) {
    {
        "Hello Mac";          /* short app name */
        "Hello, World!";      /* the visible string (also hard-coded in hello.c) */
    }
};

/* --------------------------------------------------------- About alert */

/*
 * About box: an ALRT (alert template) + matching DITL (dialog item
 * list). DITL 128 holds the OK button and three lines of static text;
 * ALRT 128 wraps it with a position + sound config.
 */
resource 'DITL' (128) {
    {
        { 80, 130, 100, 190 },
        Button { enabled, "OK" };

        { 10, 70, 30, 280 },
        StaticText { disabled, "Hello Mac" };

        { 35, 70, 55, 280 },
        StaticText { disabled, "The smallest possible classic Mac app." };

        { 60, 70, 80, 280 },
        StaticText { disabled, "Built with Retro68. classic-vibe-mac." };
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

/* ----------------------------------------------- Finder-binding bundle */

/*
 * Application signature. The Finder treats a resource of type equal
 * to the creator code as the app's "owner" stamp. Resource ID is 0;
 * we use a Pascal version string so the bytes show up in any tool
 * that reads 'CVHM' 0 as a Pascal string.
 */
data 'CVHM' (0, "Owner signature") {
    /* Pascal string "Hello Mac 0.1" — len byte then chars. */
    $"0D" "Hello Mac 0.1"
};

/*
 * Bundle (BNDL). Wire layout (matched to MPW Rez output for the
 * Types.r BNDL macro):
 *
 *     [4]  signature creator         ('CVHM')
 *     [2]  signature resource ID     (0x0000)
 *     [2]  number of resource types - 1  (we have 2 → 0x0001)
 *     for each type:
 *         [4]  resource type           ('ICN#' or 'FREF')
 *         [2]  number of IDs - 1       (we have 1 → 0x0000)
 *         for each ID:
 *             [2]  local ID
 *             [2]  actual resource ID on disk
 *
 * Hello Mac binds only itself (no document types), so each type has
 * exactly one mapping (count - 1 = 0).
 */
data 'BNDL' (128, "Hello Mac binding") {
    $"4356484D"          /* signature: 'CVHM' */
    $"0000"              /* signature resource ID = 0 */
    $"0001"              /* type count - 1 (= 2 types) */

    $"49434E23"          /* type 'ICN#' */
    $"0000"              /* mapping count - 1 (= 1 mapping) */
    $"0000" $"0080"      /* local 0 → ICN# 128 (app icon) */

    $"46524546"          /* type 'FREF' */
    $"0000"              /* mapping count - 1 (= 1 mapping) */
    $"0000" $"0080"      /* local 0 → FREF 128 (the app) */
};

/*
 * FREF (file reference). Wire layout:
 *     [4]  file type
 *     [2]  local icon ID (matches a BNDL ICN# mapping)
 *     [1+] Pascal-string filename (empty here — used only for stationery)
 */

/* FREF 128 — Hello Mac itself: type 'APPL', local icon 0. */
data 'FREF' (128, "Hello Mac app") {
    $"4150504C"          /* 'APPL' */
    $"0000"              /* local icon ID = 0 */
    $"00"                /* empty filename */
};

/*
 * ICN# (icon list). 32x32 1-bit icon followed by 32x32 1-bit mask,
 * 128 bytes each = 256 bytes total. Each row is 4 bytes (32 pixels),
 * bit 7 of byte 0 = leftmost pixel, 1 = black. The icon is a
 * stylised "H" inside a rounded rectangle — placeholder, not Susan
 * Kare territory.
 */
data 'ICN#' (128, "Hello Mac app icon") {
    /* icon — 32 rows of 4 bytes. Outer outline + a centred "H". */
    $"00000000" $"3FFFFFFC" $"40000002" $"40000002"
    $"40000002" $"4000C002" $"4000C002" $"4000C002"
    $"4000C002" $"4000C002" $"4000C002" $"4000C002"
    $"4001E002" $"4003F002" $"4007F802" $"400FFC02"
    $"401FFE02" $"401FFE02" $"400FFC02" $"4007F802"
    $"4003F002" $"4001E002" $"4000C002" $"4000C002"
    $"4000C002" $"4000C002" $"4000C002" $"4000C002"
    $"4000C002" $"40000002" $"3FFFFFFC" $"00000000"
    /* mask — solid 30x30 square covering the icon area */
    $"00000000" $"3FFFFFFC" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE" $"7FFFFFFE"
    $"7FFFFFFE" $"7FFFFFFE" $"3FFFFFFC" $"00000000"
};

/*
 * Friendly app name — STR 0 (the trailing space is the actual 4-char
 * resource type "STR ", not a typo). Some Finder dialogs read this
 * in preference to the filename. Wire format: Pascal string.
 */
data 'STR ' (0, "Application name") {
    $"09" "Hello Mac"
};

/* --------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac Hello Mac"
};

/* ---------------------------------------------------------- SIZE / Finder */

/*
 * Hello Mac is a one-window, no-document app — 64K each is plenty.
 * (Reader bumps this to 256K because it holds an HTML buffer and a
 * layout strpool; we don't.)
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
    isHighLevelEventAware,
    onlyLocalHLEvents,
    notStationeryAware,
    dontUseTextEditServices,
    reserved,
    reserved,
    reserved,
    64 * 1024,
    64 * 1024
};
