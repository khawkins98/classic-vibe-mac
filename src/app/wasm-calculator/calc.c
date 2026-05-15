/*
 * calc.c — Tiny 4-function calculator for the cv-mac sample shelf
 * (cv-mac #125).
 *
 * Different ladder rung from textedit / notepad: instead of TextEdit
 * + scrap, this demonstrates hand-drawn buttons on a QuickDraw canvas,
 * hit-testing via PtInRect, real-time number rendering via NumToString,
 * and the simplest possible Toolbox event loop.
 *
 * Layout (matches the .r WIND 128 — 220 wide × 230 tall):
 *
 *   ┌──────────────────────────────────────┐
 *   │  ┌──────────────────────────────┐    │
 *   │  │ 12345                        │    │  ← display panel
 *   │  └──────────────────────────────┘    │
 *   │  [ 7 ] [ 8 ] [ 9 ] [ / ]              │
 *   │  [ 4 ] [ 5 ] [ 6 ] [ * ]              │
 *   │  [ 1 ] [ 2 ] [ 3 ] [ - ]              │
 *   │  [ 0 ] [ C ] [ = ] [ + ]              │
 *   └──────────────────────────────────────┘
 *
 * No menus, no scrap, no extras — just buttons, hit detection, and
 * a status register. Click close-box to quit. Build & Run in the
 * playground; same Path B (in-browser C + WASM-Rez) as Snake.
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

#define BTN_W 45
#define BTN_H 30
#define BTN_GAP 5
#define GRID_LEFT 12
#define GRID_TOP 60
#define DISP_TOP 12
#define DISP_LEFT 12
#define DISP_BOT 42
#define DISP_RIGHT 208

QDGlobals qd;

/* 16-entry button grid, row-major (4 rows × 4 cols). Each cell is a
 * single character — digits, operators, C(lear), =. Mapped 1:1 to a
 * rect computed on draw + hit. */
static const char BTN_LABELS[16] = {
    '7','8','9','/',
    '4','5','6','*',
    '1','2','3','-',
    '0','C','=','+'
};

static long gAcc = 0;       /* accumulator */
static long gCur = 0;       /* current entered value */
static char gOp  = 0;       /* pending operator: 0/+/-/*/ */
static Boolean gEntering = false;
static Boolean gJustEvaluated = false;
static WindowPtr gWin = NULL;

static void ButtonRect(short i, Rect *r) {
    short col = i % 4;
    short row = i / 4;
    r->left   = GRID_LEFT + col * (BTN_W + BTN_GAP);
    r->top    = GRID_TOP  + row * (BTN_H + BTN_GAP);
    r->right  = r->left + BTN_W;
    r->bottom = r->top  + BTN_H;
}

static void DrawButton(short i) {
    Rect r;
    ButtonRect(i, &r);
    /* Classic Mac platinum button: filled white with 1px black frame
     * and a 1px grey shadow on bottom/right. Crude but recognisable. */
    EraseRect(&r);
    FrameRoundRect(&r, 8, 8);
    /* Centre the single-char label. */
    char ch = BTN_LABELS[i];
    unsigned char pstr[2] = { 1, (unsigned char)ch };
    short txtW = StringWidth(pstr);
    MoveTo(r.left + (BTN_W - txtW) / 2, r.top + 20);
    DrawString(pstr);
}

static void DrawDisplay(void) {
    Rect d;
    d.top = DISP_TOP; d.left = DISP_LEFT;
    d.bottom = DISP_BOT; d.right = DISP_RIGHT;
    EraseRect(&d);
    FrameRect(&d);
    /* Sunken inset look — 1px shadow on top/left. */
    MoveTo(d.left, d.top);
    LineTo(d.right - 1, d.top);
    /* Format the number. NumToString writes a Pascal string. */
    long n = gEntering ? gCur : gAcc;
    unsigned char buf[16];
    NumToString(n, buf);
    short txtW = StringWidth(buf);
    /* Right-align with a 6 px gutter. */
    MoveTo(d.right - 6 - txtW, d.bottom - 8);
    DrawString(buf);
}

static void Redraw(void) {
    Rect full = gWin->portRect;
    EraseRect(&full);
    DrawDisplay();
    for (short i = 0; i < 16; i++) DrawButton(i);
}

static void EvalPending(void) {
    if (gOp == '+') gAcc = gAcc + gCur;
    else if (gOp == '-') gAcc = gAcc - gCur;
    else if (gOp == '*') gAcc = gAcc * gCur;
    else if (gOp == '/' && gCur != 0) gAcc = gAcc / gCur;
    else gAcc = gCur; /* no pending op: just adopt cur */
}

static void OnDigit(char d) {
    if (gJustEvaluated) {
        gAcc = 0; gOp = 0; gJustEvaluated = false; gEntering = false;
    }
    if (!gEntering) { gCur = 0; gEntering = true; }
    if (gCur >= 0) gCur = gCur * 10 + (d - '0');
    else           gCur = gCur * 10 - (d - '0');
}

static void OnOperator(char op) {
    if (gEntering) {
        EvalPending();
        gEntering = false;
    }
    gOp = op;
    gJustEvaluated = false;
}

static void OnEquals(void) {
    if (gEntering) {
        EvalPending();
        gEntering = false;
    }
    gJustEvaluated = true;
    gOp = 0;
}

static void OnClear(void) {
    gAcc = 0; gCur = 0; gOp = 0;
    gEntering = false; gJustEvaluated = false;
}

static void HandleClick(Point local) {
    Rect r;
    for (short i = 0; i < 16; i++) {
        ButtonRect(i, &r);
        if (PtInRect(local, &r)) {
            char c = BTN_LABELS[i];
            /* Inverted flash to acknowledge the press. */
            InvertRoundRect(&r, 8, 8);
            unsigned long ticks = TickCount();
            while (TickCount() - ticks < 6) { /* ~100 ms */ }
            InvertRoundRect(&r, 8, 8);

            if (c >= '0' && c <= '9') OnDigit(c);
            else if (c == 'C') OnClear();
            else if (c == '=') OnEquals();
            else OnOperator(c);
            DrawDisplay();
            return;
        }
    }
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
    TextFont(0);   /* system (Chicago) */
    TextSize(12);
    ShowWindow(gWin);
    Redraw();

    Boolean done = false;
    while (!done) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr clickWin;
                short part = FindWindow(ev.where, &clickWin);
                if (part == inContent && clickWin == gWin) {
                    Point local = ev.where;
                    GlobalToLocal(&local);
                    HandleClick(local);
                } else if (part == inGoAway && clickWin == gWin) {
                    if (TrackGoAway(gWin, ev.where)) done = true;
                } else if (part == inDrag && clickWin == gWin) {
                    Rect bounds = qd.screenBits.bounds;
                    bounds.top += 20;
                    DragWindow(gWin, ev.where, &bounds);
                }
                break;
            }
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    Redraw();
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
