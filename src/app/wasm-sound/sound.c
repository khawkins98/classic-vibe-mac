/*
 * sound.c — Sound Manager SysBeep demo (cv-mac #125).
 *
 * Fills the Sound Manager coverage gap. Uses the trivial SysBeep
 * entry-point — every classic Mac app gets it for free as an error
 * / attention tone, but no other sample in the shelf showcases it
 * as a deliberate audible affordance.
 *
 *   SysBeep(short duration)   — play the system alert tone.
 *
 * On the original 68k Mac SysBeep's `duration` argument scales the
 * tone's length in ticks. BasiliskII (like most Mac emulators) takes
 * a shortcut: SysBeep triggers a fixed-length alert sample regardless
 * of duration. So you can't make the user *hear* a longer beep just
 * by passing a larger N. To distinguish two audibly different beep
 * behaviours we instead fire SysBeep multiple times in a row.
 *
 * Two buttons:
 *   - "Beep"         — one SysBeep(10)
 *   - "Triple Beep"  — three SysBeep(10)s, ~20 ticks apart, the only
 *                       reliable way to make duration variation reach
 *                       the user under BasiliskII
 *
 * Hooking into the richer Sound Manager (SndPlay on an 'snd '
 * resource) is the next step; the toolchain support for the full
 * Sound.h linkage isn't confirmed in our wasm-retro-cc sysroot
 * yet, so we keep this sample to the always-available SysBeep trap.
 *
 * Pairs with sound.r (WIND 128 + SIZE -1 + signature 'CVSO').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Memory.h>

#define kWindowID 128

QDGlobals qd;

static WindowPtr gWin = NULL;
static Rect gShortRect, gLongRect;
static short gClickCount = 0;

static void DrawCenteredString(const Rect *r, const unsigned char *p) {
    short w = StringWidth(p);
    MoveTo(r->left + (r->right - r->left - w) / 2,
           r->top + 18);
    DrawString(p);
}

static void DrawButton(const Rect *r, const unsigned char *label) {
    FrameRoundRect(r, 8, 8);
    DrawCenteredString(r, label);
}

static void DrawCounter(void) {
    Rect counter;
    counter.left = 8;
    counter.top = gShortRect.bottom + 14;
    counter.right = gWin->portRect.right;
    counter.bottom = counter.top + 18;
    EraseRect(&counter);
    unsigned char prefix[] = { 7, 'B','e','e','p','s',':',' ' };
    MoveTo(12, counter.top + 14);
    DrawString(prefix);
    unsigned char num[16];
    NumToString(gClickCount, num);
    DrawString(num);
}

static void DrawIntro(void) {
    Rect intro;
    intro.left = 8; intro.top = 0;
    intro.right = gWin->portRect.right; intro.bottom = 36;
    EraseRect(&intro);
    unsigned char l1[] = {
        29,
        'S','o','u','n','d',' ','M','a','n','a','g','e','r',':',' ',
        'S','y','s','B','e','e','p',' ','x',' ','1',' ','o','r',' '
    };
    MoveTo(12, 18);
    DrawString(l1);
    unsigned char l2[] = { 2, 'x',' ' };
    DrawString(l2);
    unsigned char l3[] = { 1, '3' };
    DrawString(l3);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);
    TextFont(0); TextSize(12);

    gShortRect.left = 12;  gShortRect.top = 50;
    gShortRect.right = 122; gShortRect.bottom = 78;
    gLongRect.left = 132;  gLongRect.top = 50;
    gLongRect.right = 232; gLongRect.bottom = 78;

    ShowWindow(gWin);
    DrawIntro();
    /* BasiliskII (and most Mac emulators) play the system alert tone as
     * a fixed-length sample regardless of SysBeep's duration argument —
     * the duration param is honored by the original 68k Mac sound
     * driver but the emulator's hostside backend collapses to a single
     * "play the alert" event. So "Short" / "Long" via duration alone
     * sound identical. Workaround: distinguish *audibly* by firing
     * SysBeep N times back-to-back with a tick gap, which the emulator
     * does play distinctly. */
    unsigned char btnShort[] = { 4, 'B','e','e','p' };
    unsigned char btnLong[]  = { 11, 'T','r','i','p','l','e',' ','B','e','e','p' };
    DrawButton(&gShortRect, btnShort);
    DrawButton(&gLongRect, btnLong);
    DrawCounter();

    Boolean done = false;
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    Point local = ev.where;
                    GlobalToLocal(&local);
                    if (PtInRect(local, &gShortRect)) {
                        InvertRoundRect(&gShortRect, 8, 8);
                        gClickCount++;
                        SysBeep(10);
                        InvertRoundRect(&gShortRect, 8, 8);
                        DrawCounter();
                    } else if (PtInRect(local, &gLongRect)) {
                        InvertRoundRect(&gLongRect, 8, 8);
                        gClickCount++;
                        /* Three back-to-back beeps, ~20 ticks apart, so
                         * the emulator's fixed-length alert tone plays
                         * three times. Audibly distinct from a single
                         * beep — the only way to make duration-based
                         * variation reach the user. */
                        for (short i = 0; i < 3; i++) {
                            SysBeep(10);
                            unsigned long t0 = TickCount();
                            while (TickCount() - t0 < 20) { /* wait */ }
                        }
                        InvertRoundRect(&gLongRect, 8, 8);
                        DrawCounter();
                    }
                } else if (part == inGoAway && w == gWin) {
                    if (TrackGoAway(gWin, ev.where)) done = true;
                } else if (part == inDrag && w == gWin) {
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;
                    DragWindow(gWin, ev.where, &bounds);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    DrawIntro();
                    DrawButton(&gShortRect, btnShort);
                    DrawButton(&gLongRect, btnLong);
                    DrawCounter();
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
