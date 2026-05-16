/*
 * console.c — Debug Console demo for cv-mac.
 *
 * Shows the cvm_log() API at work. The Mac app draws a tiny window
 * with "Click to log; click again to quit"; every click appends a
 * message to /Shared/__cvm_console.log via cvm_log(), and the cv-mac
 * IDE's Output panel "Console" tab surfaces the new line within ~1s.
 *
 * Click 1: logs a click count
 * Click 2: logs a click count
 * …
 * Click 6: logs "exiting" and calls ExitToShell.
 *
 * Boot also calls cvm_log_reset() so each run starts with a clean
 * slate (the watcher detects the truncation and wipes the pane).
 *
 * The window is intentionally minimal: a centered headline + a
 * counter that updates on each click. The interesting surface is
 * the Console tab in the IDE — that's where the action is.
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

/* cvm_log.h is bundled with cv-mac's playground sysroot — available
 * as a system header from any project, no per-project copy needed.
 * The source-of-truth lives at src/app/wasm-debug-console/cvm_log.h
 * in the repo and is inlined into the playground at build time by
 * cc1.ts (Vite `?raw` import). */
#include <cvm_log.h>

#define kWindowID 128
#define kMaxClicks 6

QDGlobals qd;

static WindowPtr gWin = NULL;
static short gClicks = 0;

/* Tiny utility: write a decimal short into a Pascal-string slot. */
static void AppendShortToPStr(Str255 s, short v)
{
    char digits[8];
    int n = 0;
    if (v == 0) digits[n++] = '0';
    while (v > 0 && n < 8) { digits[n++] = '0' + (v % 10); v /= 10; }
    /* digits[] is little-endian — reverse onto end of s. */
    while (n > 0 && s[0] < 254) {
        s[++s[0]] = digits[--n];
    }
}

static void DrawWindowContents(void)
{
    Rect r;
    Str255 line;
    int i;

    SetPort((GrafPtr) gWin);
    r = gWin->portRect;
    EraseRect(&r);

    TextFont(0);
    TextSize(12);
    MoveTo(20, 30);
    DrawString("\pcvm Debug Console demo");

    TextFont(4); /* monaco */
    TextSize(9);
    MoveTo(20, 60);
    DrawString("\pClick window to log a message.");
    MoveTo(20, 75);
    DrawString("\pCheck the IDE's Output → Console tab.");

    /* Click counter line. */
    line[0] = 0;
    {
        const char *prefix = "Clicks so far: ";
        for (i = 0; prefix[i]; i++) line[++line[0]] = prefix[i];
    }
    AppendShortToPStr(line, gClicks);
    MoveTo(20, 100);
    DrawString(line);

    /* Hint line. */
    MoveTo(20, 130);
    {
        Str255 hint;
        const char *txt = "Sixth click exits.";
        hint[0] = 0;
        for (i = 0; txt[i]; i++) hint[++hint[0]] = txt[i];
        DrawString(hint);
    }
}

static void HandleClick(void)
{
    Str255 msg;
    int i;
    const char *prefix = "click #";

    gClicks++;

    /* Build "click #N — hello from Mac." and ship it. */
    msg[0] = 0;
    for (i = 0; prefix[i]; i++) msg[++msg[0]] = prefix[i];
    AppendShortToPStr(msg, gClicks);
    {
        const char *suffix = " - hello from Mac";
        for (i = 0; suffix[i]; i++) msg[++msg[0]] = suffix[i];
    }
    cvm_log_p(msg);

    /* Demo both APIs: also emit a plain C string. */
    cvm_log("(this line came from cvm_log() with a C string)");

    DrawWindowContents();

    if (gClicks >= kMaxClicks) {
        cvm_log("Demo done. Goodbye!");
        ExitToShell();
    }
}

int main(void)
{
    EventRecord evt;
    Rect bounds;

    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();

    /* Always start fresh — the watcher wipes the pane on truncation. */
    cvm_log_reset();
    cvm_log("cvm Debug Console demo starting...");

    SetRect(&bounds, 60, 60, 460, 260);
    gWin = NewWindow(
        NULL, &bounds,
        "\pcvm Debug Console",
        true, documentProc, (WindowPtr) -1, true, 0);
    if (!gWin) {
        cvm_log("NewWindow failed -- aborting");
        ExitToShell();
    }
    SetPort((GrafPtr) gWin);
    DrawWindowContents();
    cvm_log("Window open. Click to log a message.");

    for (;;) {
        WaitNextEvent(everyEvent, &evt, 10, NULL);
        switch (evt.what) {
        case updateEvt:
            BeginUpdate(gWin);
            DrawWindowContents();
            EndUpdate(gWin);
            break;
        case mouseDown: {
            WindowPtr w;
            short part = FindWindow(evt.where, &w);
            if (part == inContent && w == gWin) HandleClick();
            else if (part == inDrag) {
                Rect drag = qd.screenBits.bounds;
                DragWindow(w, evt.where, &drag);
            }
            else if (part == inGoAway) {
                if (TrackGoAway(w, evt.where)) {
                    cvm_log("Goodbye -- window closed.");
                    ExitToShell();
                }
            }
            break;
        }
        }
    }
    return 0;
}
