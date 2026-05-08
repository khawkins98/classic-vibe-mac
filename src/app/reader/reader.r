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
#include "MacTypes.r"
/* Controls.r and Finder.r are not part of Retro68's RIncludes — the
 * multiversal Rez headers focus on programmatic interfaces and don't
 * ship resource-type definitions for CNTL, BNDL, FREF, or ICN#. The
 * scroll bar is built at runtime via NewControl(); the Finder-binding
 * resources below are emitted as raw `data` blobs in the on-disk wire
 * format the Resource Manager expects. This is the same byte layout
 * MPW Rez produces from the Apple-shipped Types.r macros — we just
 * write it longhand. See the comment on each resource for the layout. */

/*
 * Creator code: 'CVMR' — "Classic Vibe Mac Reader". Uppercase to stay clear
 * of Apple's reserved lowercase/digit-only space; not registered with Apple's
 * historical creator-code DB but unlikely to collide with any classic-era
 * shipped app. Once chosen, we live with it forever — the creator code is
 * the Finder's way of binding HTML documents on the boot disk back to
 * Reader, so changing it would orphan every doc on existing disks.
 *
 * Standard Finder-binding ritual:
 *   - signature resource (type='CVMR', ID=0)  → registers the app's creator
 *   - BNDL 128                                → binds signature + FREFs + ICN#
 *   - FREF 128 ('APPL', local 0)              → the app itself
 *   - FREF 129 ('TEXT', local 1)              → HTML files (we mark them TEXT)
 *   - ICN# 128, 129                           → app + document icons
 *   - STR  0                                  → friendly app name in dialogs
 */

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
        "Reload",      noIcon, "R", noMark, plain;
        "Back",        noIcon, "[", noMark, plain;
        "Open URL...", noIcon, "L", noMark, plain;
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

/* ----------------------------------------------------------- Strings */

/*
 * STR# 128 layout:
 *   1  ":Shared:"           — path prefix to the extfs share (baked content)
 *   2  "index.html"         — default landing doc
 *   3  "(no document)"      — placeholder window title
 *   4  "Reader"             — short app name (alert headers, etc.)
 *   5  fallback HTML body shown when :Shared: is missing or empty
 *   6  ":Unix:"             — extfs runtime volume prefix (JS→Mac live data)
 *   7  "(fetched URL)"      — window title for URL-fetched documents
 */
resource 'STR#' (128) {
    {
        ":Shared:";
        "index.html";
        "(no document)";
        "Reader";  /* ← try changing this to your name and clicking Build & Run */
        "<h1>No content found</h1>"
        "<p>The host page is supposed to mount a folder of HTML files "
        "as a Mac volume named <b>Shared</b>, with at least an "
        "<b>index.html</b> at the top level.</p>"
        "<p>If you are seeing this, the JS host has not yet wired the "
        "extfs share, or the share is empty. Add HTML files to "
        "<i>src/web/public/shared/</i> in the repo, redeploy, and "
        "Reader will pick them up on the next launch.</p>";
        ":Unix:";
        "(fetched URL)";
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

/* ------------------------------------------------------- Open URL dialog */

/*
 * DITL 131 — URL input dialog item list.
 *   Item 1: OK button   (default)
 *   Item 2: Cancel      (cancel item)
 *   Item 3: EditText    (URL input field)
 *   Item 4: StaticText  (hint label)
 *
 * Dialog rect: {80, 60, 175, 500} = 420 wide x 95 tall, centred-ish.
 * The edit field is wide enough for a typical URL; the hint text below it
 * reminds the user of the supported wiki: and gh: shortcuts.
 */
resource 'DITL' (131) {
    {
        /* 1 — OK (default) */
        { 60, 330, 80, 430 },
        Button { enabled, "Open" };

        /* 2 — Cancel */
        { 60, 220, 80, 320 },
        Button { enabled, "Cancel" };

        /* 3 — URL edit field (255-char max; Reader truncates at 254) */
        { 10, 10, 28, 430 },
        EditText { enabled, "" };

        /* 4 — hint static text */
        { 34, 10, 52, 430 },
        StaticText { disabled,
            "wiki:Article  gh:user/repo/path  https://..." };
    }
};

resource 'DLOG' (131) {
    { 80, 60, 175, 500 },
    movableDBoxProc,
    visible,
    goAway,
    0,
    131,
    "Open URL",
    noAutoCenter
};

/* ----------------------------------------------- Finder-binding bundle */

/*
 * Application signature. The Finder treats a resource of type equal to the
 * creator code as the app's "owner" stamp. Inside Macintosh: More Macintosh
 * Toolbox p. 7-58 calls for a single zero-byte resource; conventionally
 * this slot holds the version string, but a `$"00"` byte is also accepted.
 * We use the Pascal-style version string so it shows up in Get Info dialogs
 * that read 'CVMR' 0 as a Pascal string. Resource ID is 0.
 */
data 'CVMR' (0, "Owner signature") {
    /* Pascal string "Reader 0.1" — len byte then chars. */
    $"0A" "Reader 0.1"
};

/*
 * Bundle (BNDL). Wire layout per Inside Macintosh: More Macintosh Toolbox
 * p. 7-58 (and matched by the bytes MPW Rez emits from the Types.r BNDL
 * macro):
 *
 *     [4]  signature creator         ('CVMR')
 *     [2]  signature resource ID     (0x0000)
 *     [2]  number of resource types - 1  (we have 2 → 0x0001)
 *     for each type:
 *         [4]  resource type           ('ICN#' or 'FREF')
 *         [2]  number of IDs - 1       (we have 2 → 0x0001)
 *         for each ID:
 *             [2]  local ID             (bundle-relative; matches FREF.localID)
 *             [2]  actual resource ID   (the real ICN#/FREF resID on disk)
 *
 * Local IDs 0 and 1 here are bundle-relative tokens — they tie the FREF
 * entries to the matching ICN# entries. They have nothing to do with the
 * resource IDs (128, 129) we use on disk.
 */
data 'BNDL' (128, "Reader binding") {
    $"43564D52"          /* signature: 'CVMR' */
    $"0000"              /* signature resource ID = 0 */
    $"0001"              /* type count - 1 (= 2 types) */

    $"49434E23"          /* type 'ICN#' */
    $"0001"              /* mapping count - 1 (= 2 mappings) */
    $"0000" $"0080"      /* local 0 → ICN# 128 (app icon) */
    $"0001" $"0081"      /* local 1 → ICN# 129 (document icon) */

    $"46524546"          /* type 'FREF' */
    $"0001"              /* mapping count - 1 (= 2 mappings) */
    $"0000" $"0080"      /* local 0 → FREF 128 (the app) */
    $"0001" $"0081"      /* local 1 → FREF 129 (HTML docs) */
};

/*
 * FREF (file reference). Wire layout:
 *     [4]  file type
 *     [2]  local icon ID (matches a BNDL ICN# mapping)
 *     [1+] Pascal-string filename (empty here — used only for stationery)
 */

/* FREF 128 — Reader itself: type 'APPL', local icon 0. */
data 'FREF' (128, "Reader app") {
    $"4150504C"          /* 'APPL' */
    $"0000"              /* local icon ID = 0 */
    $"00"                /* empty filename */
};

/* FREF 129 — HTML documents we own: type 'TEXT', local icon 1. We tag the
 * .html files TEXT/CVMR via hattrib in scripts/build-boot-disk.sh. Using
 * TEXT (rather than 'HTML') keeps the docs readable by SimpleText if the
 * user hauls one onto a different app — but Finder double-click routes to
 * us because we're the registered creator for that type/creator pair. */
data 'FREF' (129, "Reader HTML doc") {
    $"54455854"          /* 'TEXT' */
    $"0001"              /* local icon ID = 1 */
    $"00"                /* empty filename */
};

/*
 * ICN# (icon list). 32x32 1-bit icon followed by 32x32 1-bit mask, 128
 * bytes each = 256 bytes total. Each row is 4 bytes (32 pixels), bit 7 of
 * byte 0 = leftmost pixel, 1 = black. Goal here is just to give the Finder
 * something distinct to draw — placeholders, not Susan Kare territory.
 *
 * 128: a stylised "R" inside a rounded outline (app icon).
 * 129: a page-with-corner-fold (document icon).
 */

data 'ICN#' (128, "Reader app icon") {
    /* icon — 32 rows of 4 bytes */
    $"00000000" $"3FFFFFFC" $"40000002" $"40000002"
    $"4007F002" $"4007F002" $"40060C02" $"40060C02"
    $"40060C02" $"40060C02" $"40060C02" $"40060C02"
    $"4007F002" $"4007F002" $"40063002" $"40061802"
    $"40060C02" $"40060602" $"40060302" $"40000002"
    $"40000002" $"40000002" $"40000002" $"40000002"
    $"40000002" $"40000002" $"40000002" $"40000002"
    $"40000002" $"40000002" $"3FFFFFFC" $"00000000"
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

data 'ICN#' (129, "Reader HTML doc icon") {
    /* icon — page with folded top-right corner */
    $"00000000" $"1FFE0000" $"10030000" $"10050000"
    $"10090000" $"10110000" $"10210000" $"10410000"
    $"10810000" $"11FF8000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"10000000" $"10000000"
    $"10000000" $"10000000" $"1FFFC000" $"00000000"
    /* mask — filled page silhouette (taller and wider than the outline) */
    $"00000000" $"1FFE0000" $"1FFF0000" $"1FFF8000"
    $"1FFFC000" $"1FFFE000" $"1FFFF000" $"1FFFF800"
    $"1FFFFC00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"1FFFFE00"
    $"1FFFFE00" $"1FFFFE00" $"1FFFFE00" $"00000000"
};

/*
 * Friendly app name — STR 0 (the trailing space is the actual 4-char
 * resource type "STR "; not a typo). Some Finder dialogs read this in
 * preference to the filename. Wire format: Pascal string.
 */
data 'STR ' (0, "Application name") {
    $"06" "Reader"
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
    512 * 1024,
    512 * 1024
};
