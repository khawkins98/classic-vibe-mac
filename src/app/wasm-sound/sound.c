/*
 * sound.c — Sound Manager SysBeep demo (cv-mac #125).
 *
 * Fills the Sound Manager coverage gap. Uses the trivial SysBeep
 * entry-point — every classic Mac app gets it for free as an error
 * / attention tone, but no other sample in the shelf showcases it
 * as a deliberate audible affordance.
 *
 *   SysBeep(short duration)   — play the system alert tone for
 *                                `duration` ticks (60 ticks = 1 sec)
 *
 * Two buttons:
 *   - "Short Beep" plays SysBeep at 5 ticks per click, growing 5
 *     ticks each press (5, 10, 15, …) until it wraps at 60.
 *   - "Long Beep"  plays SysBeep(60) — a solid 1-second tone.
 *
 * Hooking into the richer Sound Manager (SndPlay on an 'snd '
 * resource) is the next step; the toolchain support for the full
 * Sound.h linkage isn't confirmed in our wasm-retro-cc sysroot
 * yet, so we keep this sample to the always-available SysBeep
 * trap. SysBeep alone is part of the Sound Manager — the simplest
 * and oldest entry-point in it.
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
        30,
        'S','o','u','n','d',' ','M','a','n','a','g','e','r',':',' ',
        'S','y','s','B','e','e','p',' ','d','u','r','a','t','i','o'
    };
    MoveTo(12, 18);
    DrawString(l1);
    unsigned char l2[] = { 3, 'n','.','.' };
    DrawString(l2);
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
    unsigned char btnShort[] = { 10, 'S','h','o','r','t',' ','B','e','e','p' };
    unsigned char btnLong[]  = {  9, 'L','o','n','g',' ','B','e','e','p' };
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
                        short dur = ((gClickCount % 12) + 1) * 5;
                        SysBeep(dur);
                        InvertRoundRect(&gShortRect, 8, 8);
                        DrawCounter();
                    } else if (PtInRect(local, &gLongRect)) {
                        InvertRoundRect(&gLongRect, 8, 8);
                        gClickCount++;
                        SysBeep(60);
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
