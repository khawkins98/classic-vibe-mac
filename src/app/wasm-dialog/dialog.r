/*
 * dialog.r — resources for Wasm Dialog (cv-mac #125).
 *
 *   - 'CVDL' signature ("Classic Vibe DiaLog")
 *   - WIND 128  — main window with the intro + button
 *   - DLOG 128  — modal greeting dialog
 *   - DITL 128  — items: OK, Cancel, prompt text, edit field
 *   - SIZE -1   — 256 KB (Dialog Manager + TextEdit core; modest)
 */

#include "Processes.r"
#include "Windows.r"
#include "Dialogs.r"
#include "MacTypes.r"

data 'CVDL' (0, "Owner signature") {
    "CVDL"
};

resource 'WIND' (128) {
    { 60, 60, 240, 380 },
    documentProc,
    visible,
    goAway,
    0,
    "Dialog Demo",
    noAutoCenter
};

resource 'DLOG' (128, "greet") {
    { 100, 120, 240, 440 },  /* 140 tall × 320 wide */
    dBoxProc,                /* boxed modal dialog with no titlebar — classic */
    invisible,               /* GetNewDialog calls ShowWindow */
    noGoAway,
    0,
    128,                     /* DITL id */
    "",
    alertPositionMainScreen
};

resource 'DITL' (128, "greet items") {
    {
        /* item 1: default OK button. dBoxProc dialogs auto-frame the
         * default item with the heavy border. */
        { 105, 240, 130, 305 }, Button { enabled, "OK" };
        /* item 2: Cancel button. */
        { 105, 165, 130, 230 }, Button { enabled, "Cancel" };
        /* item 3: prompt text. */
        { 14, 14, 34, 306 }, StaticText {
            disabled,
            "What's your name?"
        };
        /* item 4: editable text field (~30 chars at default font). */
        { 50, 14, 70, 306 }, EditText {
            enabled,
            ""
        };
    }
};

data 'SIZE' (-1, "Wasm Dialog") {
    $"0080"                /* 32-bit clean */
    $"00040000"            /* preferred: 256 KB */
    $"00040000"            /* minimum:   256 KB */
};
