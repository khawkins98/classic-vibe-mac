/*
 * dialog.c — ModalDialog with an editable text field (cv-mac #125).
 *
 * Fills the "Modal dialogs with editable fields" coverage gap. Different
 * Toolbox surface from the existing samples — no other one exercises
 * the Dialog Manager beyond a one-button ALRT (Notepad's About).
 *
 *   - DLOG / DITL with multiple item types (StaticText, EditText,
 *     two Buttons)
 *   - GetNewDialog + ModalDialog with a filterProc-less modal loop
 *   - GetDialogItem + GetIText to read the user's typed answer
 *   - DisposeDialog cleanup
 *
 * The main window shows a "Type your name…" prompt. Clicking the
 * "Greet me…" button (drawn QuickDraw-style) opens DLOG 128. The
 * dialog has:
 *   item 1: OK button
 *   item 2: Cancel button
 *   item 3: StaticText prompt ("What's your name?")
 *   item 4: EditText field (~30 chars)
 *
 * On OK, we read item 4's text and draw "Hello, <name>!" back into
 * the main window. On Cancel, we draw a quiet "(no name)".
 *
 * Pairs with dialog.r (WIND 128 + DLOG 128 + DITL 128 + SIZE -1 +
 * signature 'CVDL').
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
#define kDialogID 128

#define kOK     1
#define kCancel 2
#define kPrompt 3
#define kField  4

QDGlobals qd;

static WindowPtr gWin = NULL;
static Rect gButtonRect;

/* The last answer, kept so the update handler can redraw it when the
 * window is uncovered (e.g. by the dialog we just closed). */
static Str255 gAnswer;
static enum { kNoAnswerYet, kAnswered, kCancelled } gAnswerState = kNoAnswerYet;

static void DrawButton(const Rect *r, const unsigned char *labelP) {
    FrameRoundRect(r, 8, 8);
    short txtW = StringWidth(labelP);
    MoveTo(r->left + (r->right - r->left - txtW) / 2,
           r->top + 18);
    DrawString(labelP);
}

static void DrawIntro(void) {
    Rect intro;
    intro.left = 8; intro.top = 0;
    intro.right = gWin->portRect.right; intro.bottom = 80;
    EraseRect(&intro);
    unsigned char l1[] = {
        31,
        'M','o','d','a','l',' ','D','i','a','l','o','g',' ','w','i','t','h',
        ' ','a','n',' ','e','d','i','t',' ','f','i','e','l','d'
    };
    MoveTo(12, 16);
    DrawString(l1);
    unsigned char l2[] = {
        34,
        'C','l','i','c','k',' ','t','h','e',' ','b','u','t','t','o','n',' ',
        't','o',' ','o','p','e','n',' ','D','L','O','G',' ','1','2','8','.'
    };
    MoveTo(12, 32);
    DrawString(l2);
}

static void DrawAnswer(const unsigned char *answerPstr, Boolean cancelled) {
    /* The result line lives below the button. */
    Rect resultArea;
    resultArea.left = 8;
    resultArea.top = gButtonRect.bottom + 8;
    resultArea.right = gWin->portRect.right;
    resultArea.bottom = resultArea.top + 24;
    EraseRect(&resultArea);
    MoveTo(12, resultArea.top + 14);
    if (cancelled) {
        unsigned char none[] = { 9, '(','n','o',' ','n','a','m','e',')' };
        DrawString(none);
        return;
    }
    unsigned char greet[] = { 7, 'H','e','l','l','o',',',' ' };
    DrawString(greet);
    DrawString(answerPstr);
    unsigned char bang[] = { 1, '!' };
    DrawString(bang);
}

static void ShowGreetDialog(void) {
    /* Remember the current port. A dialog is a window with its own
     * GrafPort; after DisposeDialog that port is gone, so we must point
     * QuickDraw back at our window before drawing the answer. */
    GrafPtr savePort;
    GetPort(&savePort);

    DialogPtr dlg = GetNewDialog(kDialogID, NULL, (WindowPtr)(-1));
    if (!dlg) { SysBeep(10); return; }
    SetPort((GrafPtr)dlg);
    /* Make the EditText field own initial focus + select all.
     * The in-browser libInterface.a exposes only the modern Universal
     * Headers name (SelectDialogItemText); the legacy SelIText was
     * dropped. Native Retro68 has both via #defines, but our wasm
     * sysroot has only the modern symbols compiled in. */
    SelectDialogItemText(dlg, kField, 0, 32767);

    short itemHit = 0;
    while (itemHit != kOK && itemHit != kCancel) {
        ModalDialog(NULL, &itemHit);
    }

    if (itemHit == kOK) {
        Handle hItem;
        short kind;
        Rect box;
        GetDialogItem(dlg, kField, &kind, &hItem, &box);
        Str255 answer;
        /* Modern Universal Headers name — see SelectDialogItemText note above. */
        GetDialogItemText(hItem, answer);
        DisposeDialog(dlg);
        SetPort(savePort);
        for (short i = 0; i <= answer[0]; i++) gAnswer[i] = answer[i];  /* length byte + chars */
        gAnswerState = kAnswered;
        DrawAnswer(gAnswer, false);
    } else {
        DisposeDialog(dlg);
        SetPort(savePort);
        gAnswerState = kCancelled;
        DrawAnswer(NULL, true);
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
    TextFont(0); TextSize(12);

    /* Button positioned below the intro text. */
    gButtonRect.left = 12;
    gButtonRect.top = 50;
    gButtonRect.right = 132;
    gButtonRect.bottom = 78;

    ShowWindow(gWin);
    DrawIntro();
    /* MacRoman 0xC9 is the horizontal-ellipsis glyph (…). Embedding the
     * UTF-8 multi-byte '…' directly is a multi-char constant warning +
     * gets truncated to one byte at runtime; spell the codepoint
     * explicitly so the button reads "Greet me…" on the classic Mac. */
    unsigned char btnLabel[] = { 9, 'G','r','e','e','t',' ','m','e', 0xC9 };
    DrawButton(&gButtonRect, btnLabel);

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
                    if (PtInRect(local, &gButtonRect)) {
                        InvertRoundRect(&gButtonRect, 8, 8);
                        unsigned long t = TickCount();
                        while (TickCount() - t < 6) { /* flash */ }
                        InvertRoundRect(&gButtonRect, 8, 8);
                        ShowGreetDialog();
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
                    DrawButton(&gButtonRect, btnLabel);
                    if (gAnswerState != kNoAnswerYet)
                        DrawAnswer(gAnswer, gAnswerState == kCancelled);
                    EndUpdate(gWin);
                }
                break;
        }
    }
    return 0;
}
