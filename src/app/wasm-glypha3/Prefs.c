//============================================================================
//----------------------------------------------------------------------------
//                                  Prefs.c
//----------------------------------------------------------------------------
//============================================================================
//
// cv-mac onboarding stub (2026-05-16). The original Prefs.c was a 523-line
// System 6 / 7 dual-path preferences reader/writer that touched:
//   - Gestalt + FindFolder (Folder Manager — not in wasm-cc1 sysroot)
//   - FSpCreate / FSpOpenDF (Standard File / FSSpec API)
//   - Pascal-string array initializers with `\p` literals (Retro68's
//     stricter unsigned-char-vs-char type check rejects)
//
// For the playground demo we don't need persistence — the game runs
// fresh each launch. Stubbed to:
//   - LoadPrefs always reports "no saved prefs", which makes Main.c
//     fall through its existing default-initialisation branch.
//   - SavePrefs is a no-op that pretends to succeed.
//
// High scores reset on each launch (acceptable for a demo); volume
// preference is read from the current system volume at startup, not
// persisted. The original Prefs.c is preserved at
// `Prefs.c.upstream` in this directory if anyone wants to port the
// real implementation to a future cv-mac that ships FindFolder
// equivalents.

#include "Externs.h"


/* External entry points kept identical to Externs.h's prototypes so
 * no other Glypha source needs to change. */

Boolean LoadPrefs (prefsInfo *thePrefs, short prefVersion);
Boolean SavePrefs (prefsInfo *thePrefs, short prefVersion);


//--------------------------------------------------------------  LoadPrefs
//
// Always reports "no saved preferences" — Main.c's caller responds by
// initialising every field to its compiled-in default.

Boolean LoadPrefs (prefsInfo *thePrefs, short prefVersion)
{
    (void)thePrefs;
    (void)prefVersion;
    return FALSE;
}


//--------------------------------------------------------------  SavePrefs
//
// No-op that pretends to succeed. Prefs aren't persisted across
// launches in the playground.

Boolean SavePrefs (prefsInfo *thePrefs, short prefVersion)
{
    (void)thePrefs;
    (void)prefVersion;
    return TRUE;
}
