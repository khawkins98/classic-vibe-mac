/*
 * minesweeper.c — Mac Toolbox UI shell for Minesweeper.
 *
 * Owns the event loop, QuickDraw rendering, menu handling, and mouse
 * routing. All actual game state lives in game_logic.c, which is pure
 * C and unit-tested on the host. This file should never need to know
 * what a mine "is" beyond what game_logic.h exposes.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68.
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

#include "game_logic.h"

/* ---------------------------------------------------------------- IDs */

enum {
    kMenuApple = 128,
    kMenuFile  = 129,
    kMenuEdit  = 130
};

enum {
    kAppleAbout = 1,

    kFileNewGame = 1,
    kFileQuit    = 3
};

enum {
    kAlertAbout   = 128,
    kAlertConfirm = 129
};

enum {
    kStrLose = 1,
    kStrWin  = 2
};

/* ----------------------------------------------------- Layout constants */

/* These match the WIND 128 content rect (176 high x 144 wide). The header
 * strip occupies the top kHeaderHeight pixels; the grid fills the rest. */
#define kCellPx        16
#define kHeaderHeight  32
#define kGridLeft       0
#define kGridTop       kHeaderHeight

/* --------------------------------------------------------------- State */

static GameBoard  gBoard;
static WindowPtr  gWindow      = NULL;
static Boolean    gQuit        = false;

/* ---------------------------------------------------------- Helpers */

static void CellRect(int col, int row, Rect *r)
{
    r->left   = kGridLeft + col * kCellPx;
    r->top    = kGridTop  + row * kCellPx;
    r->right  = r->left + kCellPx;
    r->bottom = r->top  + kCellPx;
}

/* Convert a local-coords point to a (col, row). Returns true on a hit. */
static Boolean PointToCell(Point pt, int *col, int *row)
{
    if (pt.v < kGridTop) return false;
    int c = (pt.h - kGridLeft) / kCellPx;
    int r = (pt.v - kGridTop)  / kCellPx;
    if (c < 0 || c >= GAME_COLS) return false;
    if (r < 0 || r >= GAME_ROWS) return false;
    *col = c;
    *row = r;
    return true;
}

/* Draw a Pascal string from a static buffer. Pascal strings have the
 * length byte at offset 0; building them by hand on 68K is the standard
 * Toolbox idiom. */
static void DrawDigit(int n)
{
    Str255 s;
    NumToString((long)n, s);
    DrawString(s);
}

/* ----------------------------------------------------------- Drawing */

static void DrawHeader(void)
{
    Rect hdr;
    SetRect(&hdr, 0, 0, GAME_COLS * kCellPx, kHeaderHeight);
    EraseRect(&hdr);
    FrameRect(&hdr);

    /* Mine counter on the left. */
    MoveTo(6, 20);
    DrawString("\pMines: ");
    DrawDigit(game_mines_remaining(&gBoard));

    /* Status indicator on the right. */
    MoveTo(90, 20);
    if (gBoard.status == GAME_WON)        DrawString("\pWIN");
    else if (gBoard.status == GAME_LOST)  DrawString("\pBOOM");
    else                                  DrawString("\p:)");
}

static void DrawCell(int col, int row)
{
    Rect r;
    CellRect(col, row, &r);

    int idx = game_index(col, row);
    CellState st = gBoard.state[idx];

    if (st == CELL_HIDDEN || st == CELL_FLAGGED) {
        /* Raised, unrevealed look. */
        PaintRect(&r);
        EraseRect(&r);
        FrameRect(&r);
        if (st == CELL_FLAGGED) {
            MoveTo(r.left + 5, r.top + 12);
            DrawString("\pF");
        }
        return;
    }

    /* Revealed: sunken look — frame + light interior. */
    EraseRect(&r);
    FrameRect(&r);

    if (st == CELL_MINE_REVEALED) {
        MoveTo(r.left + 4, r.top + 12);
        DrawString("\p*");
        return;
    }

    /* Numeric reveal. Zero shows blank (matches classic Minesweeper). */
    int count = gBoard.neighbor_count[idx];
    if (count > 0) {
        MoveTo(r.left + 5, r.top + 12);
        DrawDigit(count);
    }
}

static void DrawBoard(void)
{
    DrawHeader();
    for (int row = 0; row < GAME_ROWS; row++) {
        for (int col = 0; col < GAME_COLS; col++) {
            DrawCell(col, row);
        }
    }
}

static void InvalidateCell(int col, int row)
{
    Rect r;
    CellRect(col, row, &r);
    InvalRect(&r);
}

static void InvalidateHeader(void)
{
    Rect r;
    SetRect(&r, 0, 0, GAME_COLS * kCellPx, kHeaderHeight);
    InvalRect(&r);
}

/* ------------------------------------------------------- Game actions */

static void NewGame(void)
{
    /* Re-seed from TickCount so successive games differ; tests always
     * use game_init_default for reproducibility. */
    game_init(&gBoard, (unsigned long)TickCount());
    if (gWindow) {
        SetPort(gWindow);
        InvalRect(&gWindow->portRect);
    }
}

/* Show a "you (won|lost), New Game?" alert. Returns true if the player
 * picked New Game. */
static Boolean AskNewGame(short stringIndex)
{
    Str255 msg;
    GetIndString(msg, 128, stringIndex);
    ParamText(msg, "\p", "\p", "\p");
    short hit = Alert(kAlertConfirm, NULL);
    return (hit == 1);
}

static void HandleClick(Point local, Boolean isOptionClick)
{
    int col, row;
    if (!PointToCell(local, &col, &row)) return;
    if (gBoard.status != GAME_PLAYING) return;

    int changed;
    if (isOptionClick) {
        changed = game_toggle_flag(&gBoard, col, row);
    } else {
        changed = game_reveal(&gBoard, col, row);
    }
    if (!changed) return;

    /* Conservative repaint — flood-fills can touch many cells, so just
     * invalidate the whole grid. Cheap on a 9x9. */
    Rect all;
    SetRect(&all, 0, 0, GAME_COLS * kCellPx,
                       kHeaderHeight + GAME_ROWS * kCellPx);
    InvalRect(&all);

    if (gBoard.status == GAME_LOST) {
        if (AskNewGame(kStrLose)) NewGame();
    } else if (gBoard.status == GAME_WON) {
        if (AskNewGame(kStrWin)) NewGame();
    }
}

/* ---------------------------------------------------------- Menu glue */

static void ShowAbout(void)
{
    (void)Alert(kAlertAbout, NULL);
}

static void DoMenuCommand(long cmd)
{
    short menuID   = (short)(cmd >> 16);
    short menuItem = (short)(cmd & 0xFFFF);

    if (menuID == kMenuApple) {
        if (menuItem == kAppleAbout) {
            ShowAbout();
        } else {
            Str255 daName;
            GetMenuItemText(GetMenuHandle(kMenuApple), menuItem, daName);
            (void)OpenDeskAcc(daName);
        }
    } else if (menuID == kMenuFile) {
        switch (menuItem) {
            case kFileNewGame: NewGame();   break;
            case kFileQuit:    gQuit = true; break;
        }
    } else if (menuID == kMenuEdit) {
        /* Forward to DA if one is frontmost; otherwise no-op. */
        (void)SystemEdit(menuItem - 1);
    }
    HiliteMenu(0);
}

/* ----------------------------------------------------------- Events */

static void DoUpdate(WindowPtr w)
{
    SetPort(w);
    BeginUpdate(w);
    DrawBoard();
    EndUpdate(w);
}

static void DoMouseDown(EventRecord *e)
{
    WindowPtr win;
    short part = FindWindow(e->where, &win);
    switch (part) {
        case inMenuBar:
            DoMenuCommand(MenuSelect(e->where));
            break;
        case inSysWindow:
            SystemClick(e, win);
            break;
        case inDrag:
            DragWindow(win, e->where, &qd.screenBits.bounds);
            break;
        case inGoAway:
            if (TrackGoAway(win, e->where)) gQuit = true;
            break;
        case inContent: {
            if (win != FrontWindow()) {
                SelectWindow(win);
            } else {
                Point local = e->where;
                SetPort(win);
                GlobalToLocal(&local);
                HandleClick(local, (e->modifiers & optionKey) != 0);
            }
            break;
        }
    }
}

static void DoKeyDown(EventRecord *e)
{
    char key = (char)(e->message & charCodeMask);
    if (e->modifiers & cmdKey) {
        DoMenuCommand(MenuKey(key));
    }
}

/* ----------------------------------------------------------- main */

int main(void)
{
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();

    Handle mbar = GetNewMBar(128);
    SetMenuBar(mbar);
    AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
    DrawMenuBar();

    gWindow = GetNewWindow(128, NULL, (WindowPtr)-1L);
    SetPort(gWindow);
    /* applFont (=1) resolves to whatever the user has set as the
     * application font, which is Geneva on a default System 7
     * install. Retro68's Fonts.h doesn't define the older 'geneva'
     * symbol, so we go through applFont. */
    TextFont(applFont);
    TextSize(9);

    NewGame();

    while (!gQuit) {
        EventRecord e;
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown:  DoMouseDown(&e);              break;
                case keyDown:    DoKeyDown(&e);                break;
                case autoKey:    DoKeyDown(&e);                break;
                case updateEvt:  DoUpdate((WindowPtr)e.message); break;
                case activateEvt: /* nothing to do */          break;
            }
        }
    }

    return 0;
}
