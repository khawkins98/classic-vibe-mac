/*
 * textedit.r — resource fork for the TextEdit demo (cv-mac #125).
 *
 * Three resources:
 *   - signature 'CVTE'   — required by the splice path's lock check
 *   - WIND 128           — the editor window
 *   - SIZE -1            — 512 KB heap (TextEdit allocates handles for
 *                          its TEHandle + scrap, so we go a little
 *                          above wasm-hello-window's 256 KB)
 *
 * Same shape as wasm-hello-window/hello.r — see that file's comments
 * for the merge / type-creator semantics.
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

/* Signature resource. 'CVTE' = Classic Vibe TextEdit. */
data 'CVTE' (0, "Owner signature") {
    "CVTE"
};

/* Window definition. 50,40 → 320,520 = 270 tall, 480 wide, so there's
 * plenty of room for a paragraph or two of text. documentProc + goAway
 * give us the standard System 7 chrome + close box; visible flag makes
 * GetNewWindow show it immediately. */
resource 'WIND' (128) {
    { 50, 40, 320, 520 },
    documentProc,
    visible,
    goAway,
    0,
    "TextEdit — try typing",
    noAutoCenter
};

/* SIZE -1 — heap budget. TextEdit + its scrap + a single small window
 * stays comfortably under 256 KB, but we bump to 512 KB to leave
 * headroom for paste/select scratch buffers as the user types. */
data 'SIZE' (-1, "Wasm TextEdit") {
    $"0080"                /* flags: 32-bit clean */
    $"00080000"            /* preferred: 512 KB */
    $"00080000"            /* minimum: 512 KB */
};
