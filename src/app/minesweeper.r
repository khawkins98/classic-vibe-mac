/*
 * minesweeper.r — TEMPORARY round-2 bisection resource fork.
 *
 * Round 1 had WIND + vers + SIZE and bombed. This round drops the
 * WIND (the C code uses NewWindow with a hardcoded Rect) so we can
 * isolate whether the resource fork itself is the trigger.
 *
 * Just SIZE + vers. If this still bombs, the resource fork is not
 * the cause and we're looking at runtime/launch.
 */

#include "Processes.r"
#include "MacTypes.r"

resource 'vers' (1) {
    0x00, 0x01, development, 0x02,
    verUS,
    "0.0.2",
    "0.0.2, hello-world bisect r2"
};

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
