/*
 * mdpad.r — resources for the Wasm Markdown editor (cv-mac, post-#256).
 *
 * Split-pane editor: source TextEdit on the left, live-rendered
 * preview on the right. Wider than the existing wordpad/notepad
 * window because it shows two panes side-by-side.
 *
 *   MBAR 128 + MENU 128–130 : Apple, File, Edit (no Font/Size/Style —
 *                              the preview chooses font per Markdown
 *                              element automatically)
 *   WIND 128                 : 600 × 380 split-pane editor
 *   ALRT 128 + DITL 128      : About
 *   SIZE -1                  : 1 MB heap (TextEdit + scrap + preview
 *                              re-render needs little; comfortable hint)
 *   'CVMD' (0)               : signature ("Classic Vibe Markdown")
 */

#include "Processes.r"
#include "Windows.r"
#include "Menus.r"
#include "Dialogs.r"
#include "MacTypes.r"

data 'CVMD' (0, "Owner signature") {
    "CVMD"
};

resource 'MBAR' (128) {
    { 128, 129, 130 };
};

resource 'MENU' (128, "Apple") {
    128, textMenuProc, 0x7FFFFFFD, enabled, apple,
    {
        "About Wasm Markdown...", noIcon, noKey, noMark, plain;
        "-",                          noIcon, noKey, noMark, plain;
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

resource 'WIND' (128) {
    { 40, 30, 420, 630 },        /* 600 × 380 */
    documentProc,
    visible,
    goAway,
    0,
    "Wasm Markdown - type left, preview right",
    noAutoCenter
};

/* ALRT 128's stages array — one record per of 4 stages (1 click = stage
 * advance). Each record is (default-button, visibility, sound-mask). The
 * default Mac alert behaviour wants OK as default + visible + silent for
 * every stage; previous "{ OK, OK, OK, OK }" shorthand was missing fields
 * and tripped wasm-rez's assertion at ResourceDefinitions.cc:253. */
resource 'ALRT' (128) {
    { 80, 80, 250, 420 },
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
        { 135, 260, 155, 320 },
        Button { enabled, "OK" };

        { 15, 60, 125, 320 },
        StaticText {
            disabled,
            "Wasm Markdown\n"
            "Built in your browser by classic-vibe-mac.\n\n"
            "Split-pane editor: type Markdown on the left, see "
            "rendered output on the right. Headings, bold, italic, "
            "inline code, bullet/numbered lists, fenced code blocks."
        };
    }
};

data 'SIZE' (-1, "Wasm Markdown") {
    $"0080"                /* 32-bit clean */
    $"00100000"            /* preferred: 1024 KB */
    $"00100000"            /* minimum:   1024 KB */
};
