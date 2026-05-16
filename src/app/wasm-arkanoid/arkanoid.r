/*
 * arkanoid.r — wasm-arkanoid resources.
 *
 * Standard fare: WIND, MBAR + three MENUs, ALRT (about) + its DITL.
 * Plus the load-bearing "binary asset" piece for the ★★★★★ tier
 * rating: an ICN# 128 resource authored as a literal hex bitmap
 * directly in Rez source — the about-dialog icon.
 *
 * Rez source authoring an ICN# is "binary asset" in the same sense
 * "compiled C is a binary executable" — the source-side bits look
 * textual but what gets shipped in the resource fork is the raw
 * 256-byte bitmap. Later complexity tiers may swap this for a
 * pre-built .rsrc.bin handed off opaquely; this is the rung where
 * the asset still fits in source.
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "MacTypes.r"
#include "Dialogs.r"

/* ── Signature ─────────────────────────────────────────────────── */

data 'CVAR' (0, "Owner signature") {
    "CVAR"
};

/* ── Heap size override ────────────────────────────────────────── */

/* SIZE -1 — 384 KB.  Game state (5 × 10 × 1 byte bricks + a handful
 * of ints) fits in single-digit KB; the rest is libretrocrt's startup
 * needs + the Resource Manager handles for the ICN#/MBAR/DITL/etc.
 * Flag 0x0080 = 32-bit clean. */
data 'SIZE' (-1, "Wasm Arkanoid") {
    $"0080"                /* flags: 32-bit clean */
    $"00060000"            /* preferred: 384 KB */
    $"00060000"            /* minimum:   384 KB */
};

/* ── Main window ───────────────────────────────────────────────── */

resource 'WIND' (128) {
    { 40, 40, 320, 400 },     /* top, left, bottom, right (360×280) */
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Arkanoid",
    noAutoCenter
};

/* ── Menus ─────────────────────────────────────────────────────── */

resource 'MBAR' (128) {
    { 128; 129; 130 }
};

resource 'MENU' (128, "Apple") {
    128,
    textMenuProc,
    0x7ffffffd,           /* all items enabled except About-divider */
    enabled,
    apple,                /* Apple-glyph title */
    {
        "About Wasm Arkanoid…", noIcon, noKey, noMark, plain;
        "-",                    noIcon, noKey, noMark, plain;
    }
};

resource 'MENU' (129, "File") {
    129,
    textMenuProc,
    allEnabled,
    enabled,
    "File",
    {
        "Quit",                 noIcon, "Q",   noMark, plain;
    }
};

resource 'MENU' (130, "Game") {
    130,
    textMenuProc,
    allEnabled,
    enabled,
    "Game",
    {
        "New Game",             noIcon, "N",   noMark, plain;
        "Pause",                noIcon, "P",   noMark, plain;
    }
};

/* ── About alert ───────────────────────────────────────────────── */

resource 'ALRT' (128) {
    { 60, 60, 220, 380 },
    128,
    {  /* stages */
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
        OK, visible, silent;
    },
    alertPositionMainScreen
};

resource 'DITL' (128) {
    {
        /* item 1: OK button */
        { 124, 232, 144, 300 },
        Button { enabled, "OK" };

        /* item 2: title text */
        { 16, 84, 36, 304 },
        StaticText { disabled, "Wasm Arkanoid" };

        /* item 3: blurb text */
        { 44, 84, 116, 304 },
        StaticText { disabled,
            "A small brick-breaker, compiled in your browser. "
            "Multi-file C + Rez resources + a hand-drawn icon. "
            "★★★★★ tier of the cv-mac shelf. Try editing engine.c "
            "to change paddle speed, or change the brick rows in "
            "engine.h to make it harder."
        };

        /* item 4: the custom icon */
        { 16, 16, 48, 48 },
        Icon { disabled, 128 };
    }
};

/* ── Custom 32×32 icon (the binary asset) ──────────────────────── */

/*
 * ICN# 128 — 32×32 1-bit icon + 32×32 1-bit mask, 256 bytes total.
 *
 * Design: a stylised brick-and-ball graphic. Top half is a row of
 * bricks (alternating dark/light cells); bottom half is a paddle
 * with a ball above it. Reads as "Arkanoid" at glance even though
 * the resolution is tiny.
 *
 * Each row is 32 bits = 4 bytes. Row 0 is the top of the icon.
 * The mask is the silhouette: every pixel of the bounding rectangle
 * is set so the Finder doesn't punch transparent holes in the icon.
 */
resource 'ICN#' (128, "Wasm Arkanoid app icon") {
    {
        /* ── Icon (32 rows × 4 bytes) ─────────────────────────── */
        $"00000000"      /*  0: blank */
        $"00000000"      /*  1: blank */
        $"00000000"      /*  2: blank */
        $"7FFFFFFE"      /*  3: top edge of brick wall */
        $"4007E00E"      /*  4: top brick row, alternating */
        $"7C0FF01E"      /*  5: */
        $"4007E00E"      /*  6: */
        $"7FFFFFFE"      /*  7: brick row divider */
        $"4FF807FE"      /*  8: second brick row */
        $"4FF807FE"      /*  9: */
        $"4FF807FE"      /* 10: */
        $"7FFFFFFE"      /* 11: brick row divider */
        $"4007FE0E"      /* 12: third brick row */
        $"4007FE0E"      /* 13: */
        $"4007FE0E"      /* 14: */
        $"7FFFFFFE"      /* 15: brick row divider */
        $"00000000"      /* 16: gap between bricks and ball */
        $"00000000"      /* 17: */
        $"03C00000"      /* 18: ball (5×5 oval, upper-left of paddle) */
        $"07E00000"      /* 19: */
        $"07E00000"      /* 20: */
        $"03C00000"      /* 21: */
        $"00000000"      /* 22: gap */
        $"00000000"      /* 23: */
        $"00FFFE00"      /* 24: paddle top edge */
        $"01FFFF00"      /* 25: paddle body */
        $"01FFFF00"      /* 26: paddle body */
        $"00FFFE00"      /* 27: paddle bottom edge */
        $"00000000"      /* 28: blank */
        $"00000000"      /* 29: blank */
        $"00000000"      /* 30: blank */
        $"00000000"      /* 31: blank */

        /* ── Mask (32 rows × 4 bytes) — silhouette ───────────── */
        $"00000000"      /*  0 */
        $"00000000"      /*  1 */
        $"00000000"      /*  2 */
        $"7FFFFFFE"      /*  3 */
        $"7FFFFFFE"      /*  4 */
        $"7FFFFFFE"      /*  5 */
        $"7FFFFFFE"      /*  6 */
        $"7FFFFFFE"      /*  7 */
        $"7FFFFFFE"      /*  8 */
        $"7FFFFFFE"      /*  9 */
        $"7FFFFFFE"      /* 10 */
        $"7FFFFFFE"      /* 11 */
        $"7FFFFFFE"      /* 12 */
        $"7FFFFFFE"      /* 13 */
        $"7FFFFFFE"      /* 14 */
        $"7FFFFFFE"      /* 15 */
        $"00000000"      /* 16 */
        $"00000000"      /* 17 */
        $"03C00000"      /* 18: ball mask */
        $"07E00000"      /* 19 */
        $"07E00000"      /* 20 */
        $"03C00000"      /* 21 */
        $"00000000"      /* 22 */
        $"00000000"      /* 23 */
        $"00FFFE00"      /* 24: paddle mask */
        $"01FFFF00"      /* 25 */
        $"01FFFF00"      /* 26 */
        $"00FFFE00"      /* 27 */
        $"00000000"      /* 28 */
        $"00000000"      /* 29 */
        $"00000000"      /* 30 */
        $"00000000"      /* 31 */
    }
};
