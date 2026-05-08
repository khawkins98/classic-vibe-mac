/*
 * pixelpad.c — Classic Mac 1-bit pixel editor for classic-vibe-mac.
 *
 * What this is:
 *   A System 7 app that lets the user draw on a 64×64 1-bit canvas,
 *   then saves the bitmap as raw bytes to :Unix:__drawing.bin. The
 *   JS host (src/web/src/drawing-watcher.ts) polls that file and
 *   renders the drawing alongside the Mac window in real time.
 *
 * Canvas encoding:
 *   static unsigned char gPixels[512]  — 64 rows × 8 bytes/row.
 *   Each byte holds 8 pixels, MSB-first: bit 7 of byte 0 = pixel (0,0).
 *   Bit value 1 = black; 0 = white. This matches QuickDraw's 1-bit
 *   rowBytes=8 BitMap convention and the JS decoder in drawing-watcher.ts.
 *
 * Window layout (local coordinates, content area):
 *   Palette column  {top=4, left=4,  bottom=268, right=36}  — tool buttons
 *   Canvas display  {top=4, left=44, bottom=260, right=300}  — 256×256 px
 *   Each canvas pixel = 4×4 screen pixels (4× zoom, 64×4=256).
 *
 * File I/O pattern (identical to reader.c — see LEARNINGS.md):
 *   :Unix: is BasiliskII's live extfs mount; JS can read/write it.
 *   HDelete → HCreate → HOpen(fsWrPerm) → FSWrite → FSClose.
 *   On startup we try HOpen(fsRdPerm) to restore a previous drawing.
 *
 * For new developers — what "Classic Toolbox shell" means:
 *   There is no OS event loop provided for us. `main()` initialises the
 *   Toolbox managers, opens a window, and spins forever in WaitNextEvent.
 *   Every repaint, click, and menu pick is handled explicitly by us.
 *   Think of it as writing a tiny window manager in one C file.
 *   QuickDraw, the Resource Manager, the File Manager, and the Menu
 *   Manager are the "stdlib" of Classic Mac programming.
 *
 * Cross-references:
 *   reader.c       — URL bar + HTML viewer app (same shell shape)
 *   macweather.c   — weather display app (same shell shape)
 *   shared-poller.ts     — JS side of the URL fetch flow
 *   drawing-watcher.ts   — JS side that renders gPixels in the browser
 */

#include <Quickdraw.h>
#include <Windows.h>
#include <Menus.h>
#include <Events.h>
#include <Fonts.h>
#include <Dialogs.h>
#include <TextEdit.h>
#include <TextUtils.h>
#include <Devices.h>
#include <OSUtils.h>
#include <Resources.h>
#include <Files.h>

/* ---------------------------------------------------------------- Layout */

/* Canvas display rect (local coords).
 * Each of the 64×64 logical pixels maps to a 4×4 screen square. */
#define kCanvasTop    4
#define kCanvasLeft   44
#define kCanvasBottom 260      /* kCanvasTop  + 64*4 = 4  + 256 = 260 */
#define kCanvasRight  300      /* kCanvasLeft + 64*4 = 44 + 256 = 300 */
#define kCanvasPixSz  4        /* zoom factor: 1 logical pixel = 4×4 screen px */
#define kCanvasW      64
#define kCanvasH      64

/* Tool palette: a thin column left of the canvas. */
#define kPaletteLeft  4
#define kPaletteRight 36

/* Individual tool button rects (top, left, bottom, right). */
#define kPencilTop    4
#define kPencilBottom 36
#define kEraserTop    42
#define kEraserBottom 74

/* ----------------------------------------------------------------- Tools */

#define kToolPencil 0
#define kToolEraser 1

/* -------------------------------------------------------------- Menu IDs */

#define kMenuApple  128
#define kMenuFile   129
#define kMenuEdit   130

/* Apple menu */
#define kAppleAbout 1

/* File menu items */
#define kFileSave   1
#define kFileClear  2
/* item 3 is the separator */
#define kFileQuit   4

/* ----------------------------------------------------------------- State */

/* The canvas: 64×64 1-bit bitmap, rowBytes=8, MSB-first.
 * 0 = white, 1 = black. Initialised to all-white (all zeros). */
static unsigned char gPixels[512];

static WindowPtr  gWindow      = NULL;
static int        gCurrentTool = kToolPencil;
static Boolean    gDirty       = false;
static Boolean    gQuit        = false;

/* ---------------------------------------------------------------- Helpers */

/*
 * BuildUnixPath — prepend ":Unix:" to a Pascal filename.
 * :Unix: is BasiliskII's extfs live-mount. Files written here are
 * immediately visible to the JS host via the Emscripten filesystem.
 */
static void BuildUnixPath(StringPtr out, ConstStr255Param filename)
{
    /* Pascal string literal for the prefix. */
    const unsigned char prefix[] = "\p:Unix:";
    BlockMoveData(prefix, out, prefix[0] + 1);
    /* Append filename (PStrCat-equivalent via BlockMoveData). */
    unsigned char prefLen = out[0];
    unsigned char fnLen   = filename[0];
    if ((int)prefLen + fnLen > 255) fnLen = (unsigned char)(255 - prefLen);
    BlockMoveData(filename + 1, out + 1 + prefLen, fnLen);
    out[0] = prefLen + fnLen;
}

/* ------------------------------------------------------------- Pixel ops */

/*
 * SetCanvasPixel — set/clear bit (cx, cy) in gPixels.
 * IMPORTANT: always bounds-check before modifying the array —
 * there is no hardware guard page in a 68k heap.
 */
static void SetCanvasPixel(int cx, int cy, int color)
{
    if (cx < 0 || cx >= kCanvasW || cy < 0 || cy >= kCanvasH) return;
    int byteIdx = cy * 8 + cx / 8;
    int bitPos  = 7 - (cx % 8);   /* MSB-first: leftmost pixel = bit 7 */
    if (color) {
        gPixels[byteIdx] |=  (unsigned char)(1 << bitPos);
    } else {
        gPixels[byteIdx] &= (unsigned char)~(1 << bitPos);
    }
}

/*
 * DrawPixelAt — paint/erase the 4×4 screen square for canvas pixel (cx,cy).
 * Call this DURING the drag loop for live feedback; CopyBits-based full
 * repaints only fire during update events (not inside Button() tight loops).
 * Assumes SetPort(gWindow) has already been called.
 */
static void DrawPixelAt(int cx, int cy, int color)
{
    Rect r;
    r.top    = (short)(kCanvasTop    + cy * kCanvasPixSz);
    r.left   = (short)(kCanvasLeft   + cx * kCanvasPixSz);
    r.bottom = (short)(kCanvasTop    + (cy + 1) * kCanvasPixSz);
    r.right  = (short)(kCanvasLeft   + (cx + 1) * kCanvasPixSz);
    if (color) {
        PaintRect(&r);
    } else {
        EraseRect(&r);
    }
}

/* -------------------------------------------------------------- Drawing */

/*
 * DrawCanvas — full repaint via CopyBits.
 * Stretches the 64×64 gPixels BitMap into the 256×256 canvas display rect.
 * CopyBits handles the 4× zoom; this is the correct approach for update
 * events where we need to repaint the whole canvas from scratch.
 */
static void DrawCanvas(void)
{
    BitMap srcBM;
    Rect   srcR, dstR;

    srcBM.baseAddr = (Ptr)gPixels;
    srcBM.rowBytes = 8;
    SetRect(&srcBM.bounds, 0, 0, (short)kCanvasW, (short)kCanvasH);

    SetRect(&srcR, 0, 0, (short)kCanvasW, (short)kCanvasH);
    SetRect(&dstR, kCanvasTop, kCanvasLeft, kCanvasBottom, kCanvasRight);

    CopyBits(&srcBM, &((GrafPtr)gWindow)->portBits, &srcR, &dstR,
             srcCopy, NULL);
}

/*
 * DrawPalette — paint the tool palette column.
 * Selected tool button appears inverted (black bg); inactive is framed.
 */
static void DrawPalette(void)
{
    Rect r;

    /* Pencil button */
    SetRect(&r, kPencilTop, kPaletteLeft, kPencilBottom, kPaletteRight);
    EraseRect(&r);
    FrameRect(&r);
    if (gCurrentTool == kToolPencil) {
        InvertRect(&r);
    }
    /* Draw "P" label. Position baseline for 9pt text inside the button. */
    MoveTo((short)(kPaletteLeft + 10), (short)(kPencilTop + 22));
    DrawChar('P');

    /* Eraser button */
    SetRect(&r, kEraserTop, kPaletteLeft, kEraserBottom, kPaletteRight);
    EraseRect(&r);
    FrameRect(&r);
    if (gCurrentTool == kToolEraser) {
        InvertRect(&r);
    }
    MoveTo((short)(kPaletteLeft + 10), (short)(kEraserTop + 22));
    DrawChar('E');
}

/* Draw canvas border frame */
static void DrawCanvasBorder(void)
{
    Rect border;
    SetRect(&border, kCanvasTop - 1, kCanvasLeft - 1,
            kCanvasBottom + 1, kCanvasRight + 1);
    FrameRect(&border);
}

/* Full window redraw */
static void DoUpdate(void)
{
    BeginUpdate(gWindow);
    SetPort(gWindow);
    EraseRect(&gWindow->portRect);
    DrawCanvas();
    DrawCanvasBorder();
    DrawPalette();
    EndUpdate(gWindow);
}

/* ----------------------------------------------------------------- File I/O */

/*
 * LoadDrawing — try to read :Unix:__drawing.bin at startup.
 * If the file doesn't exist (first run) we silently stay blank.
 * Reads exactly 512 bytes; partial reads are discarded (blank canvas).
 */
static void LoadDrawing(void)
{
    Str255 path;
    short  refNum;
    long   count;

    BuildUnixPath(path, "\p__drawing.bin");
    if (HOpen(0, 0, path, fsRdPerm, &refNum) != noErr) return;

    count = 512;
    if (FSRead(refNum, &count, gPixels) != noErr || count != 512) {
        /* Partial or corrupt read — reset to blank. */
        int i;
        for (i = 0; i < 512; i++) gPixels[i] = 0;
    }
    FSClose(refNum);
}

/*
 * SaveDrawing — write gPixels (512 bytes, MSB-first) to :Unix:__drawing.bin.
 * Uses the canonical classic-Mac write pattern from LEARNINGS.md:
 *   HDelete (ignore ENOENT) → HCreate → HOpen(fsWrPerm) → FSWrite → FSClose.
 *
 * The JS drawing-watcher reads this file and renders a live preview
 * alongside the Mac window in the browser page.
 */
static void SaveDrawing(void)
{
    Str255 path;
    short  refNum;
    long   count;
    OSErr  err;

    BuildUnixPath(path, "\p__drawing.bin");

    HDelete(0, 0, path);                           /* delete old file (ignore ENOENT) */
    err = HCreate(0, 0, path, 'CVPP', 'PXLB');    /* 'PXLB' = Pixel Lab / binary */
    if (err != noErr && err != dupFNErr) return;

    err = HOpen(0, 0, path, fsWrPerm, &refNum);
    if (err != noErr) return;

    count = 512;
    FSWrite(refNum, &count, gPixels);
    FSClose(refNum);
    gDirty = false;
}

/* ------------------------------------------------------------- Canvas ops */

/*
 * ClearCanvas — zero all pixels and schedule a full repaint.
 * Called from File > Clear Canvas.
 */
static void ClearCanvas(void)
{
    int i;
    for (i = 0; i < 512; i++) gPixels[i] = 0;
    SetPort(gWindow);
    InvalRect(&gWindow->portRect);
    gDirty = true;
}

/* -------------------------------------------------------------- Events */

static void DoMenuCommand(long menuResult)
{
    short menuID   = HiWord(menuResult);
    short menuItem = LoWord(menuResult);

    switch (menuID) {
        case kMenuApple:
            if (menuItem == kAppleAbout) {
                Alert(128, NULL);
            } else {
                Str255 deskName;
                GetMenuItemText(GetMenuHandle(kMenuApple), menuItem, deskName);
                OpenDeskAcc(deskName);
            }
            break;

        case kMenuFile:
            switch (menuItem) {
                case kFileSave:  SaveDrawing(); break;
                case kFileClear: ClearCanvas(); break;
                case kFileQuit:  gQuit = true;  break;
            }
            break;

        case kMenuEdit:
            /* Pass standard edit commands to system (desk accessories, etc.) */
            SystemEdit(menuItem - 1);
            break;
    }

    HiliteMenu(0);
}

/*
 * HandleMouseDown — dispatch content-area clicks.
 * Clicks in the canvas start a drag-draw loop.
 * Clicks in the palette switch the active tool.
 *
 * GetMouse() returns LOCAL coordinates when called after SetPort(gWindow),
 * so we use it inside the drag loop. event.where is GLOBAL and needs
 * GlobalToLocal() for the initial hit-test.
 */
static void HandleMouseDown(EventRecord *evt)
{
    Point     pt     = evt->where;
    WindowPtr window;
    short     part   = FindWindow(pt, &window);

    switch (part) {
        case inMenuBar:
            DoMenuCommand(MenuSelect(pt));
            break;

        case inSysWindow:
            SystemClick(evt, window);
            break;

        case inContent:
            if (window != gWindow) {
                SelectWindow(window);
                break;
            }
            /* Convert global → local before hit-testing or drawing. */
            SetPort(gWindow);
            GlobalToLocal(&pt);

            if (pt.h >= kCanvasLeft && pt.h < kCanvasRight &&
                pt.v >= kCanvasTop  && pt.v < kCanvasBottom)
            {
                /* Canvas click — enter drag-draw loop.
                 * We draw directly in the loop (DrawPixelAt) for live
                 * feedback. Update events don't fire inside Button() loops
                 * on classic Mac, so InvalRect alone is insufficient. */
                int color = (gCurrentTool == kToolPencil) ? 1 : 0;
                do {
                    int cx = (pt.h - kCanvasLeft) / kCanvasPixSz;
                    int cy = (pt.v - kCanvasTop)  / kCanvasPixSz;
                    if (cx >= 0 && cx < kCanvasW && cy >= 0 && cy < kCanvasH) {
                        SetCanvasPixel(cx, cy, color);
                        DrawPixelAt(cx, cy, color);
                        gDirty = true;
                    }
                    GetMouse(&pt);
                } while (Button());
            }
            else if (pt.h >= kPaletteLeft && pt.h < kPaletteRight) {
                /* Palette click — switch tool and redraw palette. */
                if (pt.v >= kPencilTop && pt.v < kPencilBottom) {
                    gCurrentTool = kToolPencil;
                } else if (pt.v >= kEraserTop && pt.v < kEraserBottom) {
                    gCurrentTool = kToolEraser;
                }
                DrawPalette();
            }
            break;

        case inDrag: {
            /* Allow dragging anywhere on screen within the desktop bounds. */
            Rect bounds = qd.screenBits.bounds;
            DragWindow(window, pt, &bounds);
            break;
        }

        case inGoAway:
            if (TrackGoAway(window, pt)) {
                gQuit = true;
            }
            break;

        default:
            break;
    }
}

static void HandleKeyDown(EventRecord *evt)
{
    if (evt->modifiers & cmdKey) {
        DoMenuCommand(MenuKey((char)(evt->message & charCodeMask)));
    }
}

/* ------------------------------------------------------------- Init */

static void InitToolbox(void)
{
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();
    FlushEvents(everyEvent, 0);
}

static void SetupMenus(void)
{
    Handle  mbar = GetNewMBar(128);
    SetMenuBar(mbar);
    AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
    DrawMenuBar();
}

/* -------------------------------------------------------------- Main */

int main(void)
{
    EventRecord evt;

    InitToolbox();

    /* Zero the canvas (all-white). */
    {
        int i;
        for (i = 0; i < 512; i++) gPixels[i] = 0;
    }

    /* Try to restore a previous drawing from the host. */
    LoadDrawing();

    gWindow = GetNewWindow(128, NULL, (WindowPtr)-1L);
    if (!gWindow) return 1;

    SetPort(gWindow);
    TextFont(applFont);
    TextSize(9);

    SetupMenus();

    /* Force initial repaint. */
    InvalRect(&gWindow->portRect);

    while (!gQuit) {
        /* 30 ticks ≈ 0.5 s sleep during idle — low CPU use. */
        (void)WaitNextEvent(everyEvent, &evt, 30L, NULL);

        switch (evt.what) {
            case updateEvt:
                if ((WindowPtr)evt.message == gWindow) {
                    DoUpdate();
                }
                break;

            case mouseDown:
                HandleMouseDown(&evt);
                break;

            case keyDown:
            case autoKey:
                HandleKeyDown(&evt);
                break;

            case activateEvt:
                if ((WindowPtr)evt.message == gWindow) {
                    if (evt.modifiers & activeFlag) {
                        SetPort(gWindow);
                    }
                }
                break;

            case osEvt:
                /* Suspend/resume — redraw on resume. */
                if ((evt.message >> 24) == suspendResumeMessage) {
                    if (evt.message & resumeFlag) {
                        InvalRect(&gWindow->portRect);
                    }
                }
                break;

            case nullEvent:
                /* Nothing to do on idle. Auto-save could go here if desired. */
                break;
        }
    }

    return 0;
}
