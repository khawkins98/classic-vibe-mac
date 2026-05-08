/*
 * hello.c — the smallest possible classic Mac Toolbox application.
 *
 * What this app does: it opens a single window, draws "Hello, World!" in
 * the middle, and waits patiently until you choose Quit. That's it — no
 * scrolling, no controls, no documents, no preferences. About 200 lines
 * of code for the whole experience.
 *
 * Why it exists: this is the friendliest first read of "what does a
 * System 7 application actually look like?". If you've never written
 * Mac Toolbox code before, start here, then move to reader.c — that
 * file has the bigger crash course in classic-Mac concepts (Pascal
 * strings, resource forks, AppleEvents, the Memory Manager) and uses
 * almost all of them. This one keeps the surface area as tiny as the
 * Toolbox allows.
 *
 * Use this as a starting point if you want to write your own classic
 * Mac app. Copy this directory to src/app/<your-name>/, change a few
 * strings + the creator code, and you have a working skeleton you can
 * grow.
 *
 * Pattern: every classic Mac app, no matter how big, has this same
 * shape — a `main()` that initialises the Toolbox managers, builds a
 * window from a resource, then spins forever in `WaitNextEvent` until
 * the user picks Quit. There's no runtime, no framework — every paint,
 * click, and menu pick is something we explicitly handle.
 *
 * Crash course in concepts you'll see below (each re-explained inline
 * the first time it appears, and covered in much more depth in
 * reader.c):
 *   - Pascal strings:   "\pHello" — a length-prefixed byte buffer
 *                       (NOT a C-string). The Toolbox APIs want these.
 *   - Resources:        UI assets baked into the app's "resource fork"
 *                       (see hello.r). Loaded by numeric ID.
 *   - WaitNextEvent:    the System 7 main loop. Hands us mouse, key,
 *                       window-update events one at a time.
 *   - QuickDraw:        Apple's 2D drawing API. MoveTo + DrawString =
 *                       "set pen position, draw text". No retained
 *                       scene graph: you redraw on every update event.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68 (a modern GCC
 * cross-compiler that targets vintage Motorola 68000).
 */

/* Each header below corresponds to one of Apple's "managers" — the
 * classic-Mac equivalent of standard library subsystems. There's no
 * single big "mac.h"; you include exactly the managers you use. Most
 * function names are unprefixed (Apple owned the namespace), so
 * `NewWindow`, `DrawString`, etc. are real top-level symbols. */
#include <Quickdraw.h>      /* drawing primitives: MoveTo, DrawString, ... */
#include <Windows.h>        /* WindowPtr, GetNewWindow, SetPort            */
#include <Menus.h>          /* MBAR, GetMenuHandle, MenuSelect             */
#include <Events.h>         /* WaitNextEvent, EventRecord                  */
#include <Fonts.h>          /* TextFont, applFont, font IDs                */
#include <Dialogs.h>        /* Alert (used for the About box)              */
#include <TextEdit.h>       /* TEInit (Toolbox wants this even if we       */
                            /* never use a TEHandle — desk accessories     */
                            /* in the Apple menu may rely on it)           */
#include <Devices.h>        /* OpenDeskAcc — Apple-menu desk accessories   */
#include <OSUtils.h>        /* SysBeep                                     */

/* ------------------------------------------------------------------ IDs */

/* Resource IDs. On classic Mac OS, almost every UI asset (menus,
 * windows, dialogs, strings) lives in the app's "resource fork" — a
 * parallel stream of bytes attached to the same file as the
 * executable. We refer to those assets by numeric ID. The actual
 * bytes for these IDs are declared in hello.r and compiled into the
 * resource fork by Rez.
 *
 * Why the IDs start at 128: Apple convention. IDs 0..127 are reserved
 * for the system; user resources start at 128. */

enum {
    kMenuApple = 128,
    kMenuFile  = 129,
    kMenuEdit  = 130
};

enum {
    kAppleAbout = 1,        /* "About Hello Mac..." — first item in Apple menu */

    kFileQuit   = 1         /* "Quit" — only item in File menu                 */
};

enum {
    kAlertAbout = 128       /* About-box ALRT/DITL pair                        */
};

enum {
    kWindResID  = 128       /* The one-and-only window                         */
};

/* ------------------------------------------------------------ State */

static WindowPtr gWindow = NULL;
static Boolean   gQuit   = false;

/* ------------------------------------------------------ Drawing */

/*
 * Draw the window's contents. Called on every update event — the OS
 * sends one whenever a region of our window has been exposed and needs
 * re-drawing (drag, deminiaturize, return-from-hidden). There's no
 * automatic backing store on classic Mac OS, so the app is responsible
 * for re-drawing on demand.
 *
 * QuickDraw text rendering, for the uninitiated:
 *   TextFont(id)       — pick the font (by numeric Font Manager ID).
 *   TextSize(n)        — point size.
 *   MoveTo(x,y)        — move the pen. y is the BASELINE, not the top.
 *   DrawString(\p"..." )  — draw a Pascal string at the pen.
 *   StringWidth(\p"...")  — measure a Pascal string in the current
 *                            font/size. We use this to centre the text.
 *
 * Fun fact: there is no font name lookup. Every font has a numeric ID.
 * `applFont` is the application font (Geneva on default System 7).
 * Retro68 doesn't export friendly names like `geneva` or `monaco` —
 * see LEARNINGS.md for the toolchain quirk.
 */
static void DrawWindowContent(void)
{
    /* SetPort tells QuickDraw "send subsequent draw calls to this
     * window's GrafPort". A WindowPtr IS a GrafPort — same struct,
     * different name in the API. */
    SetPort(gWindow);

    /* Erase to white before redrawing. EraseRect uses the GrafPort's
     * background pattern, which defaults to white. Without this, dirty
     * pixels from previous draws (or whatever the OS happened to leave
     * here when it exposed the region) show through. */
    EraseRect(&gWindow->portRect);

    /* The visible string. Try changing this and clicking Build & Run
     * to see your edit in the emulator within a second or two. */
    /* ← try changing this and clicking Build & Run */
    Str255 message = "\pHello, World!";

    /* Pascal strings — the Toolbox's native string type. Layout:
     *     [length byte][byte 1][byte 2]...[byte N]
     * No NUL terminator; the length lives in byte 0. The `\p` prefix
     * on the literal above tells the compiler to emit the length byte
     * for us, so `"\pHello, World!"` is the bytes
     * { 13, 'H','e','l','l','o',',',' ','W','o','r','l','d','!' }. */

    /* Pick a font + size. applFont is Geneva on stock System 7. 24pt
     * is big enough to feel intentional in a small window. */
    TextFont(applFont);
    TextSize(24);
    TextFace(0);    /* plain — no bold/italic/underline */

    /* Centre the text horizontally and vertically.
     *
     * Rect is { top, left, bottom, right } — note the order, classic
     * Mac puts the y-coordinates on the outside.
     *
     * For vertical centring we use the midpoint and nudge up by 8px;
     * QuickDraw's `y` for DrawString is the *baseline*, not the top
     * of the glyphs, and Geneva 24 sits ~8px above its baseline. */
    short windowWidth  = gWindow->portRect.right  - gWindow->portRect.left;
    short windowHeight = gWindow->portRect.bottom - gWindow->portRect.top;
    short textWidth    = StringWidth(message);
    short x = (short)((windowWidth  - textWidth) / 2);
    short y = (short)(windowHeight / 2 + 8);

    MoveTo(x, y);
    DrawString(message);
}

/* ------------------------------------------------------ About box */

/*
 * Show the About box. `Alert(resID, NULL)` loads ALRT 128 (and the
 * matching DITL 128 — both defined in hello.r), draws it modally,
 * and blocks until the user clicks OK. The NULL is a filterProc —
 * a callback for custom event filtering inside the modal loop;
 * we don't need one.
 */
static void ShowAbout(void)
{
    (void)Alert(kAlertAbout, NULL);
}

/* ------------------------------------------------------ Menu glue */

/*
 * Dispatch a menu pick. `cmd` is the long-int that MenuSelect /
 * MenuKey returned: high word = menu ID, low word = item number.
 * Both are 1-based and refer to the IDs in hello.r.
 *
 * After every pick we call HiliteMenu(0) to un-invert the menu
 * title in the menu bar — the Toolbox highlights the title when
 * the user clicks but doesn't un-highlight it on release; that's
 * the app's job.
 */
static void DoMenuCommand(long cmd)
{
    short menuID   = (short)(cmd >> 16);
    short menuItem = (short)(cmd & 0xFFFF);

    if (menuID == kMenuApple) {
        if (menuItem == kAppleAbout) {
            ShowAbout();
        } else {
            /* Any other Apple-menu item is a desk accessory the user
             * has installed (Calculator, Note Pad, etc.). System 7
             * launches them via OpenDeskAcc with the item's name as a
             * Pascal string. AppendResMenu in main() populates these
             * items from the system's 'DRVR' resources. */
            Str255 daName;
            GetMenuItemText(GetMenuHandle(kMenuApple), menuItem, daName);
            (void)OpenDeskAcc(daName);
        }
    } else if (menuID == kMenuFile) {
        if (menuItem == kFileQuit) {
            /* Don't quit immediately — set a sentinel and let the
             * event loop fall out naturally. Cleaner than longjmp'ing
             * out of a menu handler. */
            gQuit = true;
        }
    } else if (menuID == kMenuEdit) {
        /* Edit menu items are mostly disabled (see hello.r) but we
         * route them to SystemEdit so any active desk accessory
         * (e.g. Note Pad) gets a chance to handle Cut/Copy/Paste. */
        (void)SystemEdit(menuItem - 1);
    }

    HiliteMenu(0);
}

/* ------------------------------------------------------ Events */

/*
 * Repaint handler. BeginUpdate / EndUpdate bracket the drawing;
 * between them, the GrafPort's visRgn is set to just the freshly-
 * exposed region, so DrawWindowContent only paints what it needs to.
 * Without the bracket, drawing would run over the entire content
 * rect even when only a sliver was uncovered.
 */
static void DoUpdate(WindowPtr w)
{
    SetPort(w);
    BeginUpdate(w);
    DrawWindowContent();
    EndUpdate(w);
}

/*
 * Mouse-down handler. FindWindow tells us *where* the click landed
 * (menu bar, drag region, close box, content, etc.) — we react to
 * each region differently. This is the standard System 7 idiom; you
 * see this same switch in every Toolbox app.
 */
static void DoMouseDown(EventRecord *e)
{
    WindowPtr win;
    short part = FindWindow(e->where, &win);
    switch (part) {
        case inMenuBar:
            /* MenuSelect runs the modal menu-tracking loop and
             * returns the selected (menuID, item) packed into a long.
             * Returns 0 if the user released outside any item. */
            DoMenuCommand(MenuSelect(e->where));
            break;
        case inSysWindow:
            /* Click in a desk accessory window — let the system
             * handle it. */
            SystemClick(e, win);
            break;
        case inDrag:
            /* Drag the window. `qd.screenBits.bounds` is the entire
             * screen rect — the OS clamps the drag inside it. */
            DragWindow(win, e->where, &qd.screenBits.bounds);
            break;
        case inGoAway:
            /* Click in the close box. TrackGoAway returns true if
             * the user released *inside* the box (mac convention:
             * dragging out and releasing means "never mind"). */
            if (TrackGoAway(win, e->where)) gQuit = true;
            break;
        case inContent:
            /* Click in the content area. If the window isn't
             * frontmost, bring it to the front; otherwise nothing —
             * Hello Mac has nothing to click on inside the window. */
            if (win != FrontWindow()) SelectWindow(win);
            break;
    }
}

/*
 * Key-down handler. We only care about Cmd-key shortcuts (e.g.
 * Cmd-Q for Quit). MenuKey returns the same packed (menuID, item)
 * long that MenuSelect produces — so the same DoMenuCommand
 * dispatch works for both mouse and keyboard.
 *
 * `charCodeMask` extracts the ASCII character from the event's
 * `message` field; the upper bits hold the virtual-key code, which
 * we don't need.
 */
static void DoKeyDown(EventRecord *e)
{
    if (e->modifiers & cmdKey) {
        char key = (char)(e->message & charCodeMask);
        DoMenuCommand(MenuKey(key));
    }
    /* No other keys are handled — Hello Mac is read-only. */
}

/* ------------------------------------------------------ main */

int main(void)
{
    /*
     * The classic-Mac-app boot sequence. Every System 7 application
     * opens with this incantation, in this order. Each call wakes up
     * one of the Toolbox managers — none of them have implicit init.
     *
     * Memory Manager primer: the Mac heap is divided into "master
     * pointer" blocks, and every Handle (a pointer-to-pointer that
     * the OS can relocate to compact the heap) needs a master
     * pointer. The OS allocates them in batches; if you exhaust the
     * initial pool mid-app, the heap fragments. MoreMasters
     * preallocates an extra batch. Calling it 3x is cargo-culted
     * from Inside Macintosh sample code — it gives us 3*64 = 192
     * master pointers up front, plenty for a one-window app.
     *
     * MaxApplZone expands the application heap to its max size right
     * at launch so it doesn't grow incrementally (which can also
     * fragment).
     */
    MaxApplZone();
    MoreMasters(); MoreMasters(); MoreMasters();
    InitGraf(&qd.thePort);   /* QuickDraw — wakes up the global GrafPort */
    InitFonts();             /* Font Manager — needed before any TextFont */
    InitWindows();           /* Window Manager                            */
    InitMenus();             /* Menu Manager                              */
    TEInit();                /* TextEdit (used by Apple-menu DAs)         */
    InitDialogs(NULL);       /* Dialog Manager (Alert/Modal dialogs)      */
    InitCursor();            /* Sets cursor to standard arrow             */

    /*
     * Build the menu bar from MBAR 128 in hello.r. GetNewMBar reads
     * the MBAR resource (a list of menu IDs), loads each MENU
     * resource into a MenuHandle, and wires them together into a
     * MenuList. SetMenuBar tells the Menu Manager "use this list".
     * AppendResMenu appends every installed desk accessory ('DRVR'
     * resource) into the Apple menu — that's how Calculator, Note
     * Pad, etc. show up there. DrawMenuBar paints it.
     */
    Handle mbar = GetNewMBar(128);
    SetMenuBar(mbar);
    AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
    DrawMenuBar();

    /*
     * Open the window from WIND 128 in hello.r. GetNewWindow loads
     * the WIND resource, allocates a WindowRecord, and shows the
     * window on screen. Args:
     *   resID    — the WIND resource ID (128)
     *   storage  — NULL means "Toolbox, please allocate the
     *              WindowRecord for me" (recommended for app-managed
     *              windows; you'd pass your own buffer for a
     *              dialog-style stack-allocated window).
     *   behind   — (WindowPtr)-1L means "frontmost". A real WindowPtr
     *              would put it behind that window in the z-order.
     */
    gWindow = GetNewWindow(kWindResID, NULL, (WindowPtr)-1L);
    if (!gWindow) {
        SysBeep(20);   /* Couldn't even open the window. Bail. */
        return 1;
    }

    /* Make sure subsequent draws go to our window, and pre-set the
     * default text style so the first paint doesn't briefly flash
     * the system font. */
    SetPort(gWindow);
    TextFont(applFont);
    TextSize(12);

    /*
     * The main event loop. WaitNextEvent is the System 7 main loop
     * primitive: it parks the app until something interesting
     * happens (mouse, key, window-update), or until `sleep`
     * (in 1/60s ticks) expires — whichever comes first.
     *
     * sleep=30 means "yield CPU for up to half a second if nothing
     * is pending". On a multi-app cooperative system like System 7,
     * yielding generously is good citizenship — it lets background
     * apps and desk accessories breathe.
     *
     * The `everyEvent` mask tells WaitNextEvent we're interested in
     * every kind of event. (You can mask off categories you don't
     * care about; we want them all.)
     */
    while (!gQuit) {
        EventRecord e;
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown:   DoMouseDown(&e);                 break;
                case keyDown:     DoKeyDown(&e);                   break;
                case autoKey:     DoKeyDown(&e);                   break;
                case updateEvt:   DoUpdate((WindowPtr)e.message);  break;
                case activateEvt: /* nothing — single-window app  */ break;
            }
        }
    }

    return 0;
}
