/*
 * files.c — File I/O via StandardGetFile / StandardPutFile (cv-mac).
 *
 * Fills the most visible coverage gap on the wasm-shelf: reading and
 * writing files from inside an in-browser-built Mac app. A TextEdit
 * field plus three buttons:
 *
 *   Open  — StandardGetFile picks a TEXT file from any mounted volume.
 *           FSOpenDF / GetEOF / FSRead drains it into the TE buffer.
 *   Save  — StandardPutFile prompts for a filename. FSCreate / FSpCreate
 *           (older trap) + FSOpenDF + FSWrite + SetEOF persists the
 *           TE contents.
 *   Quit  — exits.
 *
 * File creator is 'CVFL', type is 'TEXT' — so saved files round-trip
 * cleanly with this app or any TEXT-aware Toolbox app.
 *
 * What this *doesn't* do (deliberate):
 *   - No format conversion. Reads/writes raw bytes; line endings stay
 *     CR (the Mac standard, what TextEdit emits).
 *   - No "are you sure?" prompt on Open/Quit when the buffer is dirty.
 *     The next ladder rung — easy to add with a 3-button Alert.
 *
 * Pairs with files.r (WIND 128, SIZE -1, signature 'CVFL').
 */

#include <Types.h>
#include <Quickdraw.h>
#include <Fonts.h>
#include <Windows.h>
#include <Menus.h>
#include <TextEdit.h>
#include <Dialogs.h>
#include <Events.h>
#include <Files.h>
#include <Memory.h>
#include <StandardFile.h>
#include <Errors.h>

#define kWindowID 128

#ifndef FALSE
# define FALSE 0
#endif
#ifndef TRUE
# define TRUE 1
#endif

QDGlobals qd;

static WindowPtr gWin = NULL;
static TEHandle gTE = NULL;
static Boolean gDone = 0;

/* Three button rects — laid out across the top of the window above
 * the TextEdit field. Computed in main() from the window size so a
 * future resize would only need to recompute these. */
static Rect gBtnOpen, gBtnSave, gBtnQuit;

static const unsigned char kStarter[] = {
    62,
    'T','y','p','e',' ','h','e','r','e',',',' ',
    'h','i','t',' ','S','a','v','e',' ','t','o',' ','w','r','i','t','e',' ',
    't','o',' ','d','i','s','k','.',13,
    'O','p','e','n',' ','l','o','a','d','s',' ','a','n','y',' ','T','E',
    'X','T',' ','f','i','l','e','.'
};

static void DrawButton(const Rect *r, const unsigned char *label) {
    FrameRoundRect(r, 8, 8);
    short w = StringWidth(label);
    short cx = r->left + (r->right - r->left - w) / 2;
    MoveTo(cx, r->top + 14);
    DrawString(label);
}

static void DrawChrome(void) {
    Rect bar;
    bar.left = 0; bar.top = 0;
    bar.right = gWin->portRect.right;
    bar.bottom = 30;
    EraseRect(&bar);

    TextFont(0);
    TextSize(12);
    unsigned char bOpen[] = { 4, 'O','p','e','n' };
    unsigned char bSave[] = { 4, 'S','a','v','e' };
    unsigned char bQuit[] = { 4, 'Q','u','i','t' };
    DrawButton(&gBtnOpen, bOpen);
    DrawButton(&gBtnSave, bSave);
    DrawButton(&gBtnQuit, bQuit);
}

/* Append a literal Pascal-string suffix to an existing Pascal-string
 * in place. Returns 0 on overflow. Used to suffix status lines into
 * the TextEdit buffer when something goes wrong. */
static void TEAppendCStr(const char *s) {
    if (!gTE) return;
    short n = 0;
    while (s[n]) n++;
    long end = (**gTE).teLength;
    TESetSelect(end, end, gTE);
    TEInsert((Ptr)s, n, gTE);
}

/* Open: StandardGetFile -> FSOpenDF/FSRead -> TextEdit. */
static void DoOpen(void) {
    StandardFileReply reply;
    SFTypeList types;
    types[0] = 'TEXT';
    StandardGetFile(NULL, 1, types, &reply);
    if (!reply.sfGood) return;

    short refNum;
    OSErr err = FSpOpenDF(&reply.sfFile, fsRdPerm, &refNum);
    if (err != noErr) {
        TEAppendCStr("\015[open failed]");
        return;
    }

    long len;
    err = GetEOF(refNum, &len);
    if (err == noErr && len > 0) {
        /* Cap at 32 KB — TextEdit's own internal limit. Anything larger
         * truncates; we tell the user via a status line. */
        long readLen = len > 32000 ? 32000 : len;
        Ptr buf = NewPtr(readLen);
        if (buf) {
            err = FSRead(refNum, &readLen, buf);
            if (err == noErr || err == eofErr) {
                TESetText(buf, readLen, gTE);
                if (len > 32000) {
                    TESetSelect(readLen, readLen, gTE);
                    TEAppendCStr("\015[truncated to 32K]");
                }
            }
            DisposePtr(buf);
        }
    } else if (len == 0) {
        TESetText("", 0, gTE);
    }
    FSClose(refNum);
    TESetSelect(0, 0, gTE);
    InvalRect(&(**gTE).viewRect);
}

/* Save: StandardPutFile -> FSpCreate (overwriting if needed) -> FSWrite. */
static void DoSave(void) {
    StandardFileReply reply;
    unsigned char prompt[] = { 11, 'S','a','v','e',' ','a','s','.','.','.' };
    unsigned char dflt[] = { 8, 'U','n','t','i','t','l','e','d' };
    StandardPutFile(prompt, dflt, &reply);
    if (!reply.sfGood) return;

    /* If replacing, delete the old file first. FSpDelete returns noErr
     * if the file existed; fnfErr if not. Either is fine. */
    if (reply.sfReplacing) {
        FSpDelete(&reply.sfFile);
    }
    OSErr err = FSpCreate(&reply.sfFile, 'CVFL', 'TEXT', smRoman);
    if (err != noErr && err != dupFNErr) {
        TEAppendCStr("\015[create failed]");
        return;
    }

    short refNum;
    err = FSpOpenDF(&reply.sfFile, fsWrPerm, &refNum);
    if (err != noErr) {
        TEAppendCStr("\015[open-for-write failed]");
        return;
    }

    long len = (**gTE).teLength;
    CharsHandle text = TEGetText(gTE);
    HLock((Handle)text);
    err = FSWrite(refNum, &len, *text);
    HUnlock((Handle)text);
    /* Truncate the file to exactly the data length — handles the
     * shrink case when re-saving over a longer existing file. */
    SetEOF(refNum, len);
    FSClose(refNum);

    if (err != noErr) {
        TEAppendCStr("\015[write failed]");
    } else {
        TEAppendCStr("\015[saved]");
    }
}

static void HandleClick(Point local) {
    if (PtInRect(local, &gBtnOpen)) {
        InvertRoundRect(&gBtnOpen, 8, 8);
        DoOpen();
        InvertRoundRect(&gBtnOpen, 8, 8);
    } else if (PtInRect(local, &gBtnSave)) {
        InvertRoundRect(&gBtnSave, 8, 8);
        DoSave();
        InvertRoundRect(&gBtnSave, 8, 8);
    } else if (PtInRect(local, &gBtnQuit)) {
        gDone = TRUE;
    } else if (gTE) {
        /* Click into the TE field — caret / selection. */
        TEClick(local, 0, gTE);
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
    ShowWindow(gWin);

    /* Three buttons across the top, 60 px wide each, 8 px apart, 4 px
     * down from the top edge. */
    gBtnOpen.left = 8;   gBtnOpen.top = 4;
    gBtnOpen.right = 68; gBtnOpen.bottom = 24;
    gBtnSave.left = 76;  gBtnSave.top = 4;
    gBtnSave.right = 136; gBtnSave.bottom = 24;
    gBtnQuit.left = 144; gBtnQuit.top = 4;
    gBtnQuit.right = 204; gBtnQuit.bottom = 24;

    /* TE field fills the rest of the window below the button bar. */
    Rect te;
    te.left = 8;
    te.top = 36;
    te.right = gWin->portRect.right - 8;
    te.bottom = gWin->portRect.bottom - 8;
    gTE = TENew(&te, &te);
    if (!gTE) { SysBeep(10); return 1; }
    TESetText((Ptr)&kStarter[1], (long)kStarter[0], gTE);
    TESetSelect(0x7FFF, 0x7FFF, gTE);
    TEActivate(gTE);

    DrawChrome();

    while (!gDone) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                if (part == inContent && w == gWin) {
                    Point local = ev.where;
                    GlobalToLocal(&local);
                    HandleClick(local);
                } else if (part == inDrag && w == gWin) {
                    Rect b = qd.screenBits.bounds;
                    b.top += 20;
                    DragWindow(w, ev.where, &b);
                } else if (part == inGoAway && w == gWin) {
                    if (TrackGoAway(w, ev.where)) gDone = TRUE;
                }
                break;
            }
            case keyDown:
            case autoKey:
                if (gTE) TEKey((char)(ev.message & charCodeMask), gTE);
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    EraseRect(&gWin->portRect);
                    DrawChrome();
                    if (gTE) TEUpdate(&gWin->portRect, gTE);
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                if (gTE) TEIdle(gTE);
                break;
            case activateEvt:
                if ((WindowPtr)ev.message == gWin && gTE) {
                    if (ev.modifiers & activeFlag) TEActivate(gTE);
                    else TEDeactivate(gTE);
                }
                break;
        }
    }

    if (gTE) TEDispose(gTE);
    return 0;
}
