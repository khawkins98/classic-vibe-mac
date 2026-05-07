/*
 * minesweeper.r — TEMPORARY hello-world resource fork for bisecting
 * the "unimplemented trap" bomb. The full resource fork is preserved
 * as minesweeper-full.r.bak.
 *
 * Stripped to the minimum: one WIND, one vers, one SIZE. No MBAR,
 * no MENU, no ALRT/DITL, no STR#. Any of those could carry the bug,
 * so we leave them out of this round of the bisection.
 */

#include "Processes.r"
#include "Windows.r"
#include "MacTypes.r"

/* documentProc + goAway gives us a draggable, closeable window with
 * no zoom or grow box. Content rect is 200x80 — tiny but visible. */
resource 'WIND' (128) {
    { 60, 60, 140, 260 },
    documentProc,
    visible,
    goAway,
    0,
    "Hello",
    noAutoCenter
};

resource 'vers' (1) {
    0x00, 0x01, development, 0x01,
    verUS,
    "0.0.1",
    "0.0.1, hello-world bisect"
};

/* SIZE -1 controls the Finder's "Get Info" memory partition. We bump
 * to 256K minimum (preferred 512K) so the app has plenty of headroom
 * even on a stock System 7.5.5 install. is32BitCompatible omitted —
 * we're 68K and don't want to make claims that confuse the loader. */
resource 'SIZE' (-1) {
    reserved,
    acceptSuspendResumeEvents,
    reserved,
    canBackground,
    doesActivateOnFGSwitch,
    backgroundAndForeground,
    dontGetFrontClicks,
    ignoreChildDiedEvents,
    not32BitCompatible,
    notHighLevelEventAware,
    onlyLocalHLEvents,
    notStationeryAware,
    dontUseTextEditServices,
    reserved,
    reserved,
    reserved,
    512 * 1024,
    256 * 1024
};
