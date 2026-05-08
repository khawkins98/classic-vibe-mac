/*
 * macweather.r — Rez resources for the classic-vibe-mac weather app.
 *
 * What's a Rez file: this is the source for the app's "resource fork" —
 * the parallel data stream attached to the executable that holds menus,
 * windows, dialogs, icons, strings, version info, and Finder-binding
 * metadata. Rez (Apple's resource compiler; here we use Retro68's port)
 * reads this file and emits a binary resource fork the Mac OS Resource
 * Manager can later look up by (type, ID). The reader.r file in the
 * sibling Reader app uses the same shape — see it for a slightly more
 * featureful walk-through (it owns a document type, a Find dialog, etc).
 *
 * What MacWeather has, by resource type:
 *   MENU  (128, 129, 130)  Apple, File, Edit menus
 *   MBAR  (128)            wires the three MENUs into a menu bar
 *   WIND  (128)            the main window's bounds + style
 *   DITL  (128)            About-box dialog item list (the layout)
 *   ALRT  (128)            About-box alert template (the chrome)
 *   STR   (0)              friendly app name shown by some Finder dialogs
 *   vers  (1)              user-facing version string (Get Info shows this)
 *   SIZE  (-1)             memory partition + Finder behavior flags
 *   BNDL  (128)            Finder binding bundle (icon → app wiring)
 *   FREF  (128)            Finder file reference (we register only APPL)
 *   ICN#  (128)            32x32 1-bit app icon + mask
 *   CVMW  (0)              creator-code "owner stamp" (one byte per app)
 *
 * Resource IDs:
 *   128 — Apple menu / MBAR / WIND / About ALRT/DITL
 *   129 — File menu (Refresh, Quit)
 *   130 — Edit menu
 *
 * Window: 360x240 documentProc (no grow). Big enough to show current
 * conditions plus 3 daily forecast cells. (The comment in WIND below
 * has the actual rect — the title above predates a resize.)
 *
 * Creator code: 'CVMW' — "Classic Vibe Mac Weather". Reader uses 'CVMR';
 * we pick a sibling code to keep the namespace tidy. Same Finder-binding
 * dance as reader.r (signature + BNDL + FREF + ICN# as raw `data` blobs
 * because Retro68's RIncludes don't ship Finder.r macros). MacWeather
 * doesn't own a document type, so we only register the APPL FREF.
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
        "About MacWeather...", noIcon, noKey, noMark, plain;
        "-",                    noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129) {
    129, textMenuProc;
    allEnabled, enabled;
    "File";
    {
        "Refresh", noIcon, "R",   noMark, plain;
        "-",       noIcon, noKey, noMark, plain;
        "Quit",    noIcon, "Q",   noMark, plain;
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

/* Content rect: 360 wide x 240 tall (top, left, bottom, right).
 * Positioned in the lower-right so it doesn't fully overlap with
 * Reader (which sits in the upper-left). System 7's screen is 640x480
 * by default; with Reader at {40, 40, 380, 520} we want MacWeather
 * to peek out from below. Both windows visible after both apps
 * auto-launch from Startup Items. */
resource 'WIND' (128) {
    { 220, 260, 460, 620 },
    documentProc,
    visible,
    goAway,
    0,
    "MacWeather",                /* ← try changing this — it's the title-bar text */
    noAutoCenter
};

/* --------------------------------------------------------- About alert */

resource 'DITL' (128) {
    {
        { 110, 240, 130, 300 },
        Button { enabled, "OK" };

        { 10, 70, 30, 320 },
        StaticText { disabled, "MacWeather" };

        { 35, 70, 55, 320 },
        StaticText { disabled, "classic-vibe-mac, 2026." };

        { 60, 70, 80, 320 },
        StaticText { disabled, "Reads Unix:weather.json from the host." };

        { 85, 70, 105, 320 },
        StaticText { disabled, "Data: api.open-meteo.com" };
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

/* ----------------------------------------------- Finder-binding bundle */

/* Application signature. The Finder treats a resource of type equal to the
 * creator code as the app's "owner" stamp. Pascal-style version string. */
data 'CVMW' (0, "Owner signature") {
    $"0E" "MacWeather 0.1"
};

/* Bundle (BNDL). Wire layout per Inside Macintosh: More Macintosh Toolbox
 * p. 7-58. We register one type (APPL) — MacWeather doesn't own any
 * document file types. */
data 'BNDL' (128, "MacWeather binding") {
    $"43564D57"          /* signature: 'CVMW' */
    $"0000"              /* signature resource ID = 0 */
    $"0001"              /* type count - 1 (= 2 types) */

    $"49434E23"          /* type 'ICN#' */
    $"0000"              /* mapping count - 1 (= 1 mapping) */
    $"0000" $"0080"      /* local 0 → ICN# 128 (app icon) */

    $"46524546"          /* type 'FREF' */
    $"0000"              /* mapping count - 1 (= 1 mapping) */
    $"0000" $"0080"      /* local 0 → FREF 128 (the app) */
};

/* FREF 128 — MacWeather itself: type 'APPL', local icon 0. */
data 'FREF' (128, "MacWeather app") {
    $"4150504C"          /* 'APPL' */
    $"0000"              /* local icon ID = 0 */
    $"00"                /* empty filename */
};

/*
 * ICN# 128 — app icon. 32x32 1-bit icon + 32x32 1-bit mask.
 *
 * Iconography: a sun in the upper-left with a cloud overlapping the
 * lower-right. Crude on purpose — Susan Kare territory it is not, but it
 * reads as "weather" at 32x32 and resolves cleanly at the 16x16 small
 * Finder size too.
 *
 * Each row is 4 bytes (32 pixels). Bit 7 of byte 0 = leftmost pixel,
 * 1 = black on the icon and 1 = opaque on the mask.
 */
data 'ICN#' (128, "MacWeather app icon") {
    /* icon — 32 rows of 4 bytes */
    $"00000000"  /*  0 */
    $"03800000"  /*  1: small sun core
                       --..--..--..--..--..--..--..--..  */
    $"04400000"  /*  2 */
    $"FBE00000"  /*  3: sun rays bar across */
    $"04400000"  /*  4 */
    $"03800000"  /*  5 */
    $"00000000"  /*  6 */
    $"00000000"  /*  7 */
    $"00000000"  /*  8 */
    $"00000000"  /*  9 */
    $"00000000"  /* 10 */
    $"0007F000"  /* 11: cloud top                                    */
    $"001FFC00"  /* 12 */
    $"003FFE00"  /* 13 */
    $"007FFF00"  /* 14 */
    $"00FFFF80"  /* 15 */
    $"01FFFFC0"  /* 16 */
    $"03FFFFE0"  /* 17 */
    $"07FFFFF0"  /* 18 */
    $"0FFFFFF8"  /* 19 */
    $"1FFFFFFC"  /* 20 */
    $"1FFFFFFC"  /* 21 */
    $"0FFFFFF8"  /* 22 */
    $"07FFFFF0"  /* 23 */
    $"03FFFFE0"  /* 24 */
    $"00000000"  /* 25 */
    $"00000000"  /* 26 */
    $"00000000"  /* 27 */
    $"00000000"  /* 28 */
    $"00000000"  /* 29 */
    $"00000000"  /* 30 */
    $"00000000"  /* 31 */
    /* mask — bounds the cloud + sun area */
    $"00000000"
    $"03800000"
    $"07C00000"
    $"FFE00000"
    $"07C00000"
    $"03800000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"0007F000"
    $"001FFC00"
    $"003FFE00"
    $"007FFF00"
    $"00FFFF80"
    $"01FFFFC0"
    $"03FFFFE0"
    $"07FFFFF0"
    $"0FFFFFF8"
    $"1FFFFFFC"
    $"1FFFFFFC"
    $"0FFFFFF8"
    $"07FFFFF0"
    $"03FFFFE0"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
    $"00000000"
};

/*
 * Friendly app name — STR 0 (the trailing space in 'STR ' is the actual
 * 4-char resource type, not a typo). Some Finder dialogs read this in
 * preference to the filename. Wire format: Pascal string.
 */
data 'STR ' (0, "Application name") {
    $"0A" "MacWeather"
};

/* --------------------------------------------------------------- Version */

resource 'vers' (1) {
    0x01, 0x00, development, 0x01,
    verUS,
    "0.1",
    "0.1, 2026 classic-vibe-mac MacWeather"
};

/* ---------------------------------------------------------- SIZE / Finder */

/*
 * MacWeather's memory budget needs to cover:
 *   - 8 KB JSON buffer
 *   - WeatherData struct (small)
 *   - QuickDraw glyph drawing state
 *   - heap headroom for menu/window resources
 *
 * 1 MB partition is comfortable; the Process Manager refuses to launch
 * with anything below ~256 KB on System 7.
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
    1024 * 1024,
    1024 * 1024
};
