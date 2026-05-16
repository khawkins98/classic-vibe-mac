/*
 * multiwin.c — three windows, one event loop (cv-mac #125 follow-on).
 *
 * Every other sample on the shelf opens a single window. This one
 * opens three at launch and demonstrates the Toolbox's front-window
 * dispatch model:
 *
 *   - FrontWindow() returns the foremost window pointer; clicks in any
 *     other window's content area route to its window manager record's
 *     SelectWindow() handler (raise) BEFORE any app-level routing.
 *   - Each window's refCon stores its own colour pattern index so the
 *     update handler knows what to draw without a per-window struct
 *     lookup. (refCon is the classic Mac "stash a long here" affordance
 *     that lives in the WindowRecord — pre-WindowList iteration era.)
 *   - DragWindow + TrackGoAway work per-window. Closing any window
 *     leaves the others running; closing the last one exits.
 *
 * No menus, no TextEdit, no scrap. Pure Window Manager + QuickDraw,
 * the minimum credible "real Mac app" — opens, lives in the
 * background, responds to events from multiple targets.
 *
 * Pairs with multiwin.r (WIND 128 + SIZE -1 + signature 'CVMW').
 * One WIND template — we GetNewWindow three times against it and
 * offset each clone's position by hand so they don't sit on top of
 * each other.
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Events.h>

#define kWindowID 128
#define kWindowCount 3

QDGlobals qd;

/* Track how many windows are still on screen. Last close exits. */
static short gLive = 0;

/* Return a pointer to one of QuickDraw's three built-in grey patterns
 * (ltGray, gray, dkGray) keyed by the window index. We use QDGlobals
 * rather than GetIndPattern because the in-browser libInterface ships
 * only a partial trap surface and GetIndPattern isn't currently in
 * it — see src/app/README.md "In-browser sysroot quirks". The QD
 * globals are populated by InitGraf and always available. */
static const Pattern *PatternForWindow(short idx) {
    switch (idx % 3) {
        case 0:  return &qd.ltGray;
        case 1:  return &qd.gray;
        default: return &qd.dkGray;
    }
}

static void DrawWin(WindowPtr w) {
    /* Erase + repaint the whole port. The refCon-stashed index picks
     * which built-in pattern fills the window. */
    short idx = (short)GetWRefCon(w);
    Rect r = w->portRect;
    EraseRect(&r);
    FillRect(&r, PatternForWindow(idx));

    /* Caption — Pascal-string Window<N> centred. */
    TextFont(0);
    TextSize(12);
    /* GetWTitle would do this without us building the string — but
     * building it here shows how to derive a per-window string from
     * the refCon, useful when the window's title changes at runtime. */
    unsigned char label[] = {
        8, 'W','i','n','d','o','w',' ','?'
    };
    label[9] = '1' + (idx % 3);
    short w_ = StringWidth(label);
    MoveTo((r.right - r.left - w_) / 2, 20);
    DrawString(label);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitCursor();

    /* Create three windows from the same WIND template, offsetting
     * each from the last so they stagger across the screen. */
    for (short i = 0; i < kWindowCount; i++) {
        WindowPtr w = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
        if (!w) { SysBeep(10); continue; }
        SetWRefCon(w, (long)i);
        /* Stagger 20 px down-right from the WIND template's position. */
        MoveWindow(w, 40 + i * 24, 50 + i * 24, false);
        ShowWindow(w);
        gLive++;
    }
    if (gLive == 0) return 1;

    /* Standard event loop. FindWindow's `WindowPtr*` out-param is the
     * window the click hit (or NULL for inDesk / inMenuBar parts).
     * SelectWindow brings a back window forward; the OS sends the
     * activate/deactivate events that come with it. */
    while (gLive > 0) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                switch (part) {
                    case inContent:
                        if (w != FrontWindow()) {
                            /* Click on a back window: raise it, don't
                             * treat as a content click. Classic Mac
                             * "select then click" pattern. */
                            SelectWindow(w);
                        }
                        /* Otherwise no-op — this sample has no content
                         * actions. SelectWindow naturally triggers an
                         * update event so the just-raised window gets
                         * a chance to redraw. */
                        break;
                    case inDrag: {
                        Rect bounds = qd.screenBits.bounds;
                        bounds.top += 20;
                        DragWindow(w, ev.where, &bounds);
                        break;
                    }
                    case inGoAway:
                        if (TrackGoAway(w, ev.where)) {
                            HideWindow(w);
                            DisposeWindow(w);
                            gLive--;
                        }
                        break;
                }
                break;
            }
            case updateEvt: {
                WindowPtr w = (WindowPtr)ev.message;
                BeginUpdate(w);
                SetPort((GrafPtr)w);
                DrawWin(w);
                EndUpdate(w);
                break;
            }
            case activateEvt:
                /* Optional — could thicken the titlebar of the
                 * activated window. We rely on the system's default
                 * activate styling (the titlebar's stripes vs blank
                 * pattern), which is exactly what classic Mac apps
                 * did. */
                break;
        }
    }
    return 0;
}
