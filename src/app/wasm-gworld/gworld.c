/*
 * gworld.c — modern offscreen double-buffer via NewGWorld (cv-mac).
 *
 * wasm-bounce showed how to hand-roll an offscreen 1-bit BitMap with
 * NewPtr + SetPortBits — pre-Color-QuickDraw, no support for depth or
 * color tables. This demo does the same flicker-free double-buffer
 * idea via the modern (System 7+) GWorld API:
 *
 *   NewGWorld(&gw, 1, &bounds, NULL, NULL, 0)   — allocate 1-bit GW
 *   GetGWorld(&saveP, &saveD); SetGWorld(gw, NULL)  — switch port
 *   ... draw into the GWorld with normal QuickDraw ...
 *   SetGWorld(saveP, saveD); LockPixels(GetGWorldPixMap(gw))
 *   CopyBits((BitMap*)*pmh, &w->portBits, ...)  — blit to window
 *   UnlockPixels(pmh); DisposeGWorld(gw); on exit
 *
 * Visually distinct from wasm-bounce: instead of one ball we bounce
 * four shapes (square, circle, diamond, triangle) with different
 * speeds and directions. The flicker-free path is the educational
 * point — try ripping out the GWorld and drawing direct to the
 * window port; you'll see every shape flash white as EraseRect
 * clears before the next frame.
 *
 * Pairs with gworld.r (WIND 128 + SIZE -1 + signature 'CVGW').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <QDOffscreen.h>   /* NewGWorld / GetGWorldPixMap / LockPixels — synth shim */
#include <Fonts.h>
#include <Windows.h>
#include <Events.h>

#define kWindowID 128
#define kSceneW 320
#define kSceneH 200
#define kShapeCount 4

QDGlobals qd;

static WindowPtr gWin = NULL;
static GWorldPtr gWorld = NULL;
static unsigned long gFrame = 0;

/* Each shape has a position + velocity in fixed-point (×16 to allow
 * sub-pixel speed without overflow worries). */
typedef struct {
    long x, y;       /* ×16 fixed-point */
    long dx, dy;
    short size;
    short kind;      /* 0=square 1=circle 2=diamond 3=triangle */
} Shape;
static Shape gShapes[kShapeCount];

static void InitShapes(void) {
    short i;
    for (i = 0; i < kShapeCount; i++) {
        gShapes[i].size = 18 + (i * 4);     /* slight size variation */
        gShapes[i].x = (40 + i * 60) << 4;   /* spread across scene */
        gShapes[i].y = (30 + i * 35) << 4;
        gShapes[i].dx = ((i + 1) * 11) << 0; /* different drift speeds */
        gShapes[i].dy = ((i + 1) * 7)  << 0;
        gShapes[i].kind = i;
    }
}

static void DrawShape(const Shape *s) {
    short cx = (short)(s->x >> 4);
    short cy = (short)(s->y >> 4);
    Rect r;
    r.left = cx - s->size / 2;
    r.top = cy - s->size / 2;
    r.right = r.left + s->size;
    r.bottom = r.top + s->size;
    switch (s->kind) {
        case 0:  FrameRect(&r);  break;
        case 1:  FrameOval(&r);  break;
        case 2: {
            /* Diamond — four lines from edge midpoints. */
            MoveTo(cx, r.top);
            LineTo(r.right - 1, cy);
            LineTo(cx, r.bottom - 1);
            LineTo(r.left, cy);
            LineTo(cx, r.top);
            break;
        }
        case 3: {
            /* Triangle pointing up. */
            MoveTo(cx, r.top);
            LineTo(r.right - 1, r.bottom - 1);
            LineTo(r.left, r.bottom - 1);
            LineTo(cx, r.top);
            break;
        }
    }
}

/* Advance one frame: clear the GWorld, redraw all shapes into it,
 * then CopyBits the whole 320×200 scene up to the window in one shot. */
static void Step(void) {
    Shape *s;
    short i;
    /* Update positions and bounce off scene edges. */
    for (i = 0, s = gShapes; i < kShapeCount; i++, s++) {
        s->x += s->dx;
        s->y += s->dy;
        short cx = (short)(s->x >> 4);
        short cy = (short)(s->y >> 4);
        short half = s->size / 2;
        if (cx - half < 0)         { s->dx = -s->dx; s->x = (long)half << 4; }
        if (cx + half > kSceneW)   { s->dx = -s->dx; s->x = (long)(kSceneW - half) << 4; }
        if (cy - half < 0)         { s->dy = -s->dy; s->y = (long)half << 4; }
        if (cy + half > kSceneH)   { s->dy = -s->dy; s->y = (long)(kSceneH - half) << 4; }
    }
    gFrame++;

    /* Switch port to the GWorld, paint the scene, restore. */
    GrafPtr  savePort;
    GDHandle saveDev;
    GetGWorld((CGrafPtr*)&savePort, &saveDev);
    SetGWorld((CGrafPtr)gWorld, NULL);

    Rect scene; scene.left = 0; scene.top = 0;
    scene.right = kSceneW; scene.bottom = kSceneH;
    EraseRect(&scene);

    /* Light grey backdrop so the white shape interiors read against it. */
    FillRect(&scene, &qd.ltGray);

    for (i = 0; i < kShapeCount; i++) DrawShape(&gShapes[i]);

    /* Frame counter in the bottom-right corner. */
    TextFont(0);
    TextSize(9);
    unsigned char buf[16];
    NumToString((long)gFrame, buf);
    MoveTo(scene.right - 60, scene.bottom - 4);
    DrawString(buf);

    SetGWorld((CGrafPtr)savePort, saveDev);

    /* Blit GWorld pixmap to the window. LockPixels keeps the pixmap
     * baseAddr stable across the CopyBits — required because GWorlds
     * are relocatable handles. CopyBits is happy with PixMap* via
     * the BitMap* cast (their first few fields overlap exactly). */
    PixMapHandle pmh = GetGWorldPixMap(gWorld);
    LockPixels(pmh);
    Rect destRect = scene;
    /* Centre the scene horizontally if the window is wider; offset to
     * leave a 4-px top margin. */
    short xOff = (gWin->portRect.right - kSceneW) / 2;
    if (xOff < 0) xOff = 0;
    OffsetRect(&destRect, xOff, 4);
    CopyBits(
        (BitMap*)*pmh,
        &gWin->portBits,
        &scene,
        &destRect,
        srcCopy,
        NULL
    );
    UnlockPixels(pmh);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitCursor();

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);
    ShowWindow(gWin);

    /* Allocate the offscreen GWorld up front and reuse every frame.
     * depth=1 is 1-bit monochrome — same as wasm-bounce's hand-rolled
     * BitMap. Depth could be 8 (indexed) or 16/32 (direct) here; the
     * 1-bit choice matches a vintage 9" Macintosh + keeps memory tiny. */
    Rect bounds; bounds.left = 0; bounds.top = 0;
    bounds.right = kSceneW; bounds.bottom = kSceneH;
    QDErr err = NewGWorld(&gWorld, 1, &bounds, NULL, NULL, 0);
    if (err != noErr || !gWorld) { SysBeep(10); return 1; }

    InitShapes();

    Boolean done = 0;
    while (!done) {
        EventRecord ev;
        /* 1-tick timeout so the animation runs at ~60Hz; idle ticks
         * drive the Step() each cycle. */
        WaitNextEvent(everyEvent, &ev, 1, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inGoAway && w == gWin && TrackGoAway(w, ev.where)) done = 1;
                else if (part == inDrag && w == gWin) {
                    Rect b = qd.screenBits.bounds;
                    b.top += 20;
                    DragWindow(w, ev.where, &b);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    EraseRect(&gWin->portRect);
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                Step();
                break;
        }
    }
    if (gWorld) DisposeGWorld(gWorld);
    return 0;
}
