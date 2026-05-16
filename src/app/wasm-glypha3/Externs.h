
//============================================================================
//----------------------------------------------------------------------------
//									Externs.h
//----------------------------------------------------------------------------
//============================================================================

/* cv-mac onboarding patch (2026-05-16): Glypha 3 was originally built
 * with CodeWarrior, which auto-included a "MacHeaders" precompiled
 * prefix that gave every .c file access to Mac Toolbox types globally.
 * Retro68's GCC doesn't have that — each translation unit needs the
 * headers explicitly. Adding them once here in Externs.h reaches
 * every consumer transparently.
 *
 * Also define TRUE/FALSE locally: the Retro68 sysroot ships C99
 * `true`/`false` (lowercase, _Bool style) but not the uppercase
 * macros classic Mac code uses pervasively. */
#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Sound.h>
#include <Resources.h>
#include <ToolUtils.h>
#include <Files.h>
#include <Devices.h>
#include <Memory.h>
#include <OSUtils.h>
#include <Errors.h>
/* Folders.h + GestaltEqu.h aren't in the wasm-cc1 sysroot; the
 * former isn't used by Glypha at all (no FindFolder calls), and
 * the latter was renamed Gestalt.h in modern Universal Headers. */
#include <Gestalt.h>
#include <Palettes.h>
#include <QDOffscreen.h>

#ifndef TRUE
#define TRUE  1
#endif
#ifndef FALSE
#define FALSE 0
#endif

/* ── cv-mac Universal-Headers compatibility shim ─────────────────────
 *
 * The Retro68 sysroot we vendor ships a consolidated subset of the
 * Universal Headers. Some older Toolbox API surfaces Glypha touches
 * are either renamed or missing entirely; we restore them here so
 * the unmodified game source compiles cleanly.
 *
 * Each definition is the canonical value from Apple's documentation
 * (Inside Macintosh: Operating System Utilities, Sound Manager,
 * Files), not invention. */

/* KeyMap — 4-long array for the current keyboard state. The
 * Events.h in our sysroot doesn't typedef it; GetKeys() in the
 * sysroot expects this exact shape (4 × u32). */
#ifndef _KeyMap_defined
typedef unsigned long KeyMap[4];
#define _KeyMap_defined
#endif

/* ToolTrap — selector value for NGetTrapAddress's TrapType arg.
 * Glypha's CodeWarrior-era source uses `ToolTrap` (and would use
 * `OSTrap`) as the selectors, matching the symbol names in classic
 * MacHeaders. The Universal Headers in our sysroot spell the same
 * enum members `kToolboxTrapType` (= 1) / `kOSTrapType` (= 0), so
 * we alias.
 *
 * Cautionary tale: an earlier shim defined `ToolTrap 0xA800` — that
 * value IS a Trap Manager constant (the Toolbox-trap range mask) and
 * the symbol shows up under that meaning in some period docs, but
 * `TrapType` is `signed char` (SInt8): passing 0xA800 (= 43008) as a
 * TrapType truncates to 0 (i.e. OSTrap), and every TrapExists() call
 * for a Toolbox trap returns the wrong answer. The truncation isn't
 * even a warning if you don't compile with `-Wconversion`. Inside
 * Mac documents both meanings; only the enum form is type-correct.
 *
 * cf. classic-vibe-mac LEARNINGS "2026-05-16 — Universal-Headers
 * compatibility shim block" for the wider pattern. */
#ifndef ToolTrap
#define ToolTrap kToolboxTrapType
#endif
#ifndef OSTrap
#define OSTrap kOSTrapType
#endif

/* Sound Manager init bits — initMono / initNoInterp aren't in our
 * sysroot's Sound.h. Values are from Inside Mac: Sound (1991). */
#ifndef initMono
#define initMono       0x0080
#endif
#ifndef initStereo
#define initStereo     0x00C0
#endif
#ifndef initNoInterp
#define initNoInterp   0x0004
#endif
#ifndef initNoDrop
#define initNoDrop     0x0008
#endif

/* Sound Manager UPP / proc-info constants for the callback path.
 * uppSndCallbackProcInfo is the procInfo bit pattern for the
 * SndCallback dispatcher; the value below is what Sound.h
 * defines on a full Universal Headers install. */
#ifndef uppSndCallbackProcInfo
#define uppSndCallbackProcInfo 0x000003C0
#endif

/* Folder Manager constants — Prefs.c references these via Gestalt
 * even though it never actually calls FindFolder. We don't include
 * Folders.h (not in sysroot) so define the constants locally just
 * for the Gestalt-availability probe. */
#ifndef gestaltFindFolderPresent
#define gestaltFindFolderPresent 0
#endif
#ifndef kOnSystemDisk
#define kOnSystemDisk           (-32768)
#endif
#ifndef kCreateFolder
#define kCreateFolder           1
#endif
#ifndef kDontCreateFolder
#define kDontCreateFolder       0
#endif

/* Geneva — classic Mac OS font ID (3). Our sysroot's Fonts.h
 * doesn't define the lowercase `geneva` constant the old Toolbox
 * headers shipped. */
#ifndef geneva
#define geneva 3
#endif

/* Legacy Toolbox name aliases. The Universal Headers in our wasm-cc1
 * sysroot use the modern (System 7.5+) names for these calls; Glypha
 * uses the older System 7 names. Map old → new so libInterface.a's
 * exports resolve. */
#define SetItem          SetMenuItemText
#define GetItem          GetMenuItemText
#define SelIText         SelectDialogItemText
#define DisposDialog     DisposeDialog
#define GetIText         GetDialogItemText
#define SetIText         SetDialogItemText
#define AddResMenu       AppendResMenu
#define DisposPtr        DisposePtr
#define DisposHandle     DisposeHandle
#define DisposWindow     DisposeWindow
#define DisposMenu       DisposeMenu
#define DisposRgn        DisposeRgn
#define GetDItem         GetDialogItem
#define SetDItem         SetDialogItem
#define ParamText        ParamText      /* unchanged */
#define NewCWindow       NewCWindow     /* unchanged */

/* System volume controls — Glypha calls SetSoundVol/GetSoundVol to
 * snapshot+restore the global system volume around play. Modern Sound
 * Manager uses GetDefaultOutputVolume / SetDefaultOutputVolume on a
 * long. We don't need this behaviour for the demo — silently stub
 * them so Main.c's "remember the user's pre-game volume" code links.
 * The game won't change the global volume, which is fine for a
 * browser demo (the user controls volume via the page anyway). */
#define SetSoundVol(level) ((void)(level))
#define GetSoundVol(plevel) (*(plevel) = 7)

/* CFM RoutineDescriptor macros — for cross-architecture (68k vs
 * PPC) universal proc pointers. On a pure-68K build there's no
 * need; a direct function pointer works. Define BUILD_ROUTINE_DESCRIPTOR
 * to expand to the function name itself so the existing initializer
 * compiles. (RoutineDescriptor *type* is already typedef'd in the
 * sysroot's MixedMode.h, so we don't redefine it.) */
#ifndef BUILD_ROUTINE_DESCRIPTOR
#define BUILD_ROUTINE_DESCRIPTOR(procInfo, proc) ((RoutineDescriptor){0})
#endif

#define	kPutInFront			(WindowPtr)-1L
#define	kNormalUpdates		TRUE

#define kHelpKeyASCII				0x05
#define kPageUpKeyASCII				0x0B
#define kPageDownKeyASCII			0x0C
#define	kUpArrowKeyASCII			0x1E
#define kDownArrowKeyASCII			0x1F


#define kDownArrowKeyMap			122		// key map offset for down arrow
#define kRightArrowKeyMap			123		// key map offset for right arrow
#define kLeftArrowKeyMap			124		// key map offset for left arrow

#define kAKeyMap					7
#define	kEKeyMap					9
#define	kPKeyMap					36
#define	kQKeyMap					11
#define kSKeyMap					6
#define kColonMap					0x2E
#define kQuoteMap					0x20
#define	kCommandKeyMap				48
#define	kEscKeyMap					50
#define kSpaceBarMap				54

#define kBirdSound					1
#define kBirdPriority					80
#define kBonusSound					2
#define kBonusPriority					85
#define kBoom1Sound					3
#define kBoom1Priority					115
#define kBoom2Sound					4
#define kBoom2Priority					110
#define kSplashSound				5
#define kSplashPriority					75
#define kFlapSound					6
#define kFlapPriority					70
#define kGrateSound					8
#define kGratePriority					40
#define kLightningSound				9
#define kLightningPriority				100
#define kMusicSound					10
#define kMusicPriority					120
#define kScreechSound				12
#define kScreechPriority				50
#define kSpawnSound					13
#define kSpawnPriority					90
#define kWalkSound					14
#define kWalkPriority					30
#define kFlap2Sound					15
#define kFlap2Priority					20
#define kScrape2Sound				16
#define kScrape2Priority				10

#define kLavaHeight					456
#define kRoofHeight					2
#define kGravity					4

#define kIdle						-1	// enemy & player mode
#define kFlying						0	// enemy & player mode
#define kWalking					1	// enemy & player mode
#define kSinking					2	// player mode
#define kSpawning					3	// enemy mode
#define kFalling					4	// enemy mode & player mode
#define kEggTimer					5	// enemy mode
#define kDeadAndGone				6	// enemy mode
#define kBones						7	// player mode
#define kLurking					10	// hand mode
#define kOutGrabeth					11	// hand mode
#define kClutching					12	// hand mode
#define kWaiting					15	// eye mode
#define kStalking					16	// eye mode


#define kInitNumLives				5
#define kMaxEnemies					8
#define kDontFlapVel				8

#define kOwl						0
#define kWolf						1
#define kJackal						2


//--------------------------------------------------------------  Structs


typedef struct
{
	Rect		dest, wasDest, wrap;
	short		h, v;
	short		wasH, wasV;
	short		hVel, vVel;
	short		srcNum, mode;
	short		frame;
	Boolean		facingRight, flapping;
	Boolean		walking, wrapping;
	Boolean		clutched;
} playerType;

typedef struct
{
	Rect		dest, wasDest;
	short		h, v;
	short		wasH, wasV;
	short		hVel, vVel;
	short		srcNum, mode;
	short		kind, frame;
	short		heightSmell, targetAlt;
	short		flapImpulse, pass;
	short		maxHVel, maxVVel;
	Boolean		facingRight;
} enemyType;

typedef struct
{
	Rect		dest;
	short		mode;
} handInfo;

typedef struct
{
	Rect		dest;
	short		mode, opening;
	short		srcNum, frame;
	Boolean		killed, entering;
} eyeInfo;

typedef struct
{
	short		prefVersion, filler;
	Str255		highName;
	Str15		highNames[10];
	long		highScores[10];
	short		highLevel[10];
	short		wasVolume;
} prefsInfo;

//--------------------------------------------------------------  Prototypes


void GenerateEnemies (void);			// Enemies.c
void MoveEnemies (void);
void InitHandLocation (void);
void HandleHand (void);
void InitEye (void);
void KillOffEye (void);
void HandleEye (void);
void CheckPlayerEnemyCollision (void);

void DrawPlatforms (short);				// Graphics.c
void ScrollHelp (short);
void OpenHelp (void);
void CloseWall (void);
void OpenHighScores (void);
void UpdateLivesNumbers (void);
void UpdateScoreNumbers (void);
void UpdateLevelNumbers (void);
void GenerateLightning (short h, short v);
void FlashObelisks (Boolean);
void StrikeLightning (void);
void DumpBackToWorkMap (void);
void DumpMainToWorkMap (void);
void AddToUpdateRects (Rect *);
void DrawTorches (void);
void CopyAllRects (void);
void DrawFrame (void);

void MenusReflectMode (void);			// Interface.c
void DoMenuChoice (long);
void HandleEvent (void);

void InitNewGame (void);				// Play.c
void PlayGame (void);

Boolean SavePrefs (prefsInfo *, short);	// Prefs.c
Boolean LoadPrefs (prefsInfo *, short);

void ToolBoxInit (void);				// SetUpTakeDown.c
void CheckEnvirons (void);
void OpenMainWindow (void);
void InitMenubar (void);
void InitVariables (void);
void ShutItDown (void);

void PlayExternalSound (short, short);	// Sound.c
void InitSound (void);
void KillSound (void);

short RandomInt (short);				// Utilities.c
void RedAlert (StringPtr);
void FindOurDevice (void);
void LoadGraphic (short);
void CreateOffScreenPixMap (Rect *, CGrafPtr *);
void CreateOffScreenBitMap (Rect *, GrafPtr *);
void ZeroRectCorner (Rect *);
void FlashShort (short);
void LogNextTick (long);
void WaitForNextTick (void);
Boolean TrapExists (short);
Boolean DoWeHaveGestalt (void);
void CenterAlert (short);
short RectWide (Rect *);
short RectTall (Rect *);
void CenterRectInRect (Rect *, Rect *);
void PasStringCopy (StringPtr, StringPtr);
void CenterDialog (short);
void DrawDefaultButton (DialogPtr);
void PasStringCopyNum (StringPtr, StringPtr, short);
void GetDialogString (DialogPtr, short, StringPtr);
void SetDialogString (DialogPtr, short, StringPtr);
void SetDialogNumToStr (DialogPtr, short, long );
void GetDialogNumFromStr (DialogPtr, short, long *);
void DisableControl (DialogPtr, short);


#ifdef powerc
	extern pascal void SetSoundVol(short level);		// for old Sound Manager
	extern pascal void GetSoundVol(short *level)
	THREEWORDINLINE(0x4218, 0x10B8, 0x0260);
#endif


