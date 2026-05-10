/*
 * reader.c — Mac Toolbox UI shell for the classic-vibe-mac HTML viewer.
 *
 * What this file is: the entire on-screen Mac side of "Reader", a tiny HTML
 * browser for System 7. It opens a window, runs an event loop, reads HTML
 * files off a shared volume, and asks html_parse.c to turn the bytes into
 * draw ops which it then paints with QuickDraw.
 *
 * Pattern: classic Mac "Toolbox shell". A Mac app of this era is just a
 * `main()` that initialises the Toolbox managers, builds a window, and
 * spins forever in `WaitNextEvent` until the user picks Quit. There is no
 * runtime, no framework — every paint, click, and menu pick is something
 * we explicitly handle. Modern devs: think of it as writing your own
 * miniature browser engine + window manager + main loop in one C file.
 *
 * Crash course in classic-Mac concepts you'll see below — each is
 * re-explained inline the first time it appears:
 *   - Pascal strings:  "\pHello" — a length-prefixed byte buffer (NOT a
 *                      C-string). The Toolbox APIs want these.
 *   - Resources:       data baked into the app's "resource fork" (see
 *                      reader.r). Loaded by numeric ID (e.g. WIND 128).
 *   - WaitNextEvent:   the System 7 main loop. Hands us mouse, key,
 *                      window-update, and Apple events one at a time.
 *   - QuickDraw:       Apple's 2D drawing API. MoveTo + DrawString =
 *                      "set pen position, draw text". No retained-mode
 *                      scene graph: you redraw on every update event.
 *   - Memory Manager:  NewHandle / HLock / MoreMasters. Manual heap
 *                      bookkeeping; we only touch it lightly here.
 *   - File Manager:    HOpen / FSRead / FSClose. NOT POSIX. Pascal-string
 *                      paths, vRefNum/dirID volume identifiers.
 *   - AppleEvents:     Inter-app messages. The Finder uses these to tell
 *                      us "the user double-clicked this document".
 *
 * Pipeline (data flow):
 *   :Shared:<name>.html  --HOpen/FSRead--------->  raw bytes
 *   raw bytes            --html_tokenize--------->  HtmlTokenList
 *   HtmlTokenList        --html_layout_build----->  HtmlLayout (DrawOps)
 *   DrawOps              --DrawText / TextFace--->  on-screen pixels
 *
 * The Toolbox shell is intentionally dumb: all parsing/layout lives in
 * html_parse.c and is host-tested. This file owns the event loop, scroll
 * bar, file I/O, link clicks, and font setup.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68 (a modern GCC that
 * cross-compiles to vintage Motorola 68000). The shared-folder mount
 * (Mac volume named "Shared") is provided by BasiliskII's extfs machinery
 * wired up by the JS host — this app just opens files at the
 * pre-existing path ":Shared:index.html".
 *
 * If you're editing this file in the in-browser playground: you can
 * change anything you like, hit Build & Run, and see the result in the
 * emulator within ~1 second. A good first edit is one of the strings
 * inside the alert dialogs or the STR# table in reader.r.
 */

/* Each header below corresponds to one of Apple's "managers" — the
 * classic-Mac equivalent of standard library subsystems. There's no big
 * "mac.h"; you include exactly the managers you use. Most function names
 * are unprefixed (Apple owned the namespace), so e.g. `NewWindow`,
 * `DrawString`, and `FSRead` are real top-level symbols. */
#include <Quickdraw.h>      /* drawing primitives: MoveTo, DrawString, ... */
#include <Windows.h>        /* WindowPtr, GetNewWindow, Drag/Grow/SetPort  */
#include <Menus.h>          /* MBAR, GetMenuHandle, MenuSelect             */
#include <Events.h>         /* WaitNextEvent, EventRecord                  */
#include <Fonts.h>          /* TextFont, applFont, font IDs                */
#include <Dialogs.h>        /* Alert, StandardGetFile (Open dialog)        */
#include <TextEdit.h>       /* TEInit (the Toolbox wants this even if      */
                            /* we never use a TEHandle — desk accessories  */
                            /* in the Apple menu may rely on it)           */
#include <TextUtils.h>      /* GetIndString — pulls strings out of STR#    */
#include <Devices.h>        /* OpenDeskAcc — Apple-menu desk accessories   */
#include <OSUtils.h>        /* SysBeep                                     */
#include <Resources.h>      /* GetResource, etc. (resource fork access)    */
#include <Files.h>          /* HOpen, FSRead, FSClose, FSSpec              */
#include <AppleEvents.h>    /* AEInstallEventHandler, AEProcessAppleEvent  */
/* Controls Manager (NewControl, TrackControl, GetControlValue, ...) is
 * declared in Windows.h in Retro68's multiversal interfaces — there is
 * no standalone Controls.h header in this toolchain (a known Retro68
 * quirk; #include <Controls.h> would fail). AppleEvents.h pulls in
 * AEDataModel symbols too via the multiversal headers. */

#include "html_parse.h"

/* ------------------------------------------------------------------ IDs */

/* Resource IDs. On classic Mac OS, almost every UI asset (menus, windows,
 * dialogs, icons, strings) lives in the app's "resource fork" — a parallel
 * stream of bytes attached to the same file as the executable. We refer
 * to those assets by numeric ID. The actual bytes for these IDs are
 * declared in reader.r and compiled into the resource fork by Rez.
 *
 * Why the IDs start at 128: Apple convention. IDs 0..127 are reserved for
 * the system; user resources start at 128. Our app, our menus, our IDs. */

enum {
    kMenuApple = 128,
    kMenuFile  = 129,
    kMenuEdit  = 130,
    kMenuView  = 131
};

enum {
    kAppleAbout = 1,

    kFileOpen   = 1,
    kFileClose  = 2,
    kFileQuit   = 4,

    kViewReload  = 1,
    kViewBack    = 2,
    kViewOpenUrl = 3
};

enum {
    kAlertAbout    = 128,
    kAlertNote     = 130,
    kDialogOpenUrl = 131
};

enum {
    kStrShared      = 1,    /* ":Shared:" */
    kStrIndex       = 2,    /* "index.html" */
    kStrEmptyTitle  = 3,    /* "(no document)" */
    kStrErrTitle    = 4,    /* "Reader" */
    kStrFallbackHtml = 5,   /* HTML body shown when no content found */
    kStrUnix        = 6,    /* ":Unix:" — extfs runtime volume */
    kStrFetchedUrl  = 7     /* "(fetched URL)" — window title for URL docs */
    /* ← These IDs index into the STR# 128 resource defined in reader.r.
     * Open reader.r in the playground editor, change one of those strings,
     * click Build & Run, and watch your edit show up in the Mac above. */
};

enum {
    kWindResID    = 128,
    kCntlResID    = 128,    /* vertical scroll bar */
    kStrListID    = 128
};

/* ------------------------------------------------------------ Layout */

#define kScrollBarWidth   16
#define kContentMargin     8

/* ------------------------------------------------------------ State */

#define kHtmlBufferBytes   16384      /* enough for the sample pages */
#define kHistoryDepth      16

static WindowPtr   gWindow         = NULL;
static ControlHandle gScrollBar    = NULL;
static Boolean     gQuit           = false;

static char        gHtmlBuf[kHtmlBufferBytes];
static long        gHtmlLen        = 0;
static HtmlTokenList gTokens;
static HtmlLayout    gLayout;

/* Pascal-string globals, initialised at runtime in main().
 *
 * Pascal strings — the Toolbox's native string type. Layout:
 *     [length byte][byte 1][byte 2]...[byte N]
 * No NUL terminator; the length lives in byte 0. Type aliases:
 *     Str63   = unsigned char[64]   (1 length + 63 chars)
 *     Str255  = unsigned char[256]  (1 length + 255 chars)
 * Source-code literals use a `\p` prefix: `"\pHello"` becomes the bytes
 * { 5, 'H','e','l','l','o' }.
 *
 * Why initialised at runtime: Retro68's GCC won't implicitly cast a
 * "\p..." char-array literal into the unsigned char Str63 type at file
 * scope. (See LEARNINGS.md — this is a known Retro68 quirk.) main()
 * seeds them with GetIndString or BlockMoveData. */
static Str63       gCurrentDoc;
static Str63       gHistory[kHistoryDepth];
static short       gHistoryDepth   = 0;

/* ------------------------------------------- URL-fetch polling state */

/* Monotonic request counter. Incremented each time the user submits a URL.
 * Written into __url-request.txt so the JS host can detect new requests
 * and ignore stale result files from previous requests. */
static long        gUrlRequestId   = 0;

/* true while we are waiting for the JS host to write the result file. */
static Boolean     gPollingForResult = false;

/* Tick count at which we next check for the result file. */
static long        gNextResultCheck = 0;

/* Forward declarations for helpers used before their definitions. */
static long ReadHtmlFile(ConstStr255Param fullPath);
static void InvalidateContent(void);
static void RebuildLayout(void);

/* ----------------------------------------------------- Pascal-string utils */

/* Tiny Pascal-string helpers — there's a stdlib for C-strings (string.h)
 * but the Toolbox uses Pascal strings, so we roll our own. Each one
 * mirrors a `str*` from string.h; the only twist is the length is at
 * byte 0 instead of after a trailing NUL. */

/* Concatenate two Pascal strings into dest. dest must be Str255-sized. */
static void PStrCat(StringPtr dest, ConstStr255Param src)
{
    int dl = dest[0];
    int sl = src[0];
    if (dl + sl > 255) sl = 255 - dl;
    BlockMoveData(src + 1, dest + 1 + dl, sl);
    dest[0] = (unsigned char)(dl + sl);
}

static void PStrCopy(StringPtr dest, ConstStr255Param src)
{
    BlockMoveData(src, dest, src[0] + 1);
}

static Boolean PStrEqual(ConstStr255Param a, ConstStr255Param b)
{
    if (a[0] != b[0]) return false;
    for (int i = 1; i <= a[0]; i++) if (a[i] != b[i]) return false;
    return true;
}

/* Build a Str255 holding ":Shared:<docName>". docName is a Pascal string.
 *
 * On classic Mac OS, file paths use COLONS as separators, not slashes.
 * ":Shared:index.html" means "in the volume named Shared, the file
 * index.html". A leading colon means "absolute, starting at a volume
 * name". This is one of the deepest cultural differences from Unix:
 * paths are colon-separated, volumes are first-class, and there is no
 * universal root /. */
static void BuildSharedPath(StringPtr out, ConstStr255Param docName)
{
    Str255 prefix;
    /* Pull string #1 ("\":Shared:\"") out of the STR# 128 list defined in
     * reader.r. GetIndString writes a Pascal string into prefix. */
    GetIndString(prefix, kStrListID, kStrShared);   /* ":Shared:" */
    if (prefix[0] == 0) {
        /* Belt-and-braces fallback if the resource lookup ever fails:
         * hand-build the Pascal string from a C-string literal.
         * `prefix[0] = 8;` is the length byte; `BlockMoveData` (the
         * Toolbox's memcpy) copies the 8 chars after the length. */
        prefix[0] = 8;
        BlockMoveData(":Shared:", prefix + 1, 8);
    }
    PStrCopy(out, prefix);
    PStrCat(out, docName);
}

/* Build a Str255 holding ":Unix:<filename>". Used for files written into the
 * extfs live mount by the JS host (e.g. __url-request.txt, __url-result-N.html).
 * Unlike :Shared: (baked at build time), :Unix: is read/write at runtime. */
static void BuildUnixPath(StringPtr out, ConstStr255Param filename)
{
    Str255 prefix;
    GetIndString(prefix, kStrListID, kStrUnix);   /* ":Unix:" */
    if (prefix[0] == 0) {
        prefix[0] = 6;
        BlockMoveData(":Unix:", prefix + 1, 6);
    }
    PStrCopy(out, prefix);
    PStrCat(out, filename);
}

/* Convert a non-negative long integer to a decimal ASCII Pascal string.
 * There is no itoa() or sprintf() in the classic Mac toolbox we can rely on
 * without linking the C runtime — this is a standalone helper. */
static void LongToStr(long n, Str255 out)
{
    /* We build digits right-to-left into a temp C-string, then reverse. */
    char tmp[12];  /* max 10 digits for 32-bit + sign + NUL */
    int  len = 0;
    if (n == 0) { tmp[len++] = '0'; }
    while (n > 0) { tmp[len++] = (char)('0' + (n % 10)); n /= 10; }
    /* Reverse into the Pascal string. */
    out[0] = (unsigned char)len;
    for (int i = 0; i < len; i++) {
        out[1 + i] = (unsigned char)tmp[len - 1 - i];
    }
}

/* Write the URL fetch request to :Unix:__url-request.txt.
 * Format: "<requestId>\n<url>\n" (newline-separated, ASCII/MacRoman).
 * The JS shared-poller polls this file and starts a fetch when the ID changes. */
static void WriteUrlRequest(ConstStr255Param url)
{
    gUrlRequestId++;

    Str255 path;
    BuildUnixPath(path, "\p__url-request.txt");

    /* Delete any previous request file so we start clean. */
    HDelete(0, 0, path);
    short refNum = 0;
    OSErr err = HCreate(0, 0, path, 'CVMR', 'TEXT');
    if (err != noErr && err != dupFNErr) return;
    err = HOpen(0, 0, path, fsWrPerm, &refNum);
    if (err != noErr) return;

    /* Write "<id>\n<url>\n" — assemble into a char buf. */
    char buf[280];
    int  pos = 0;

    /* Append the request ID digits. */
    Str255 idStr;
    LongToStr(gUrlRequestId, idStr);
    for (int i = 1; i <= idStr[0]; i++) buf[pos++] = idStr[i];
    buf[pos++] = '\n';

    /* Append the URL (Pascal string body). */
    for (int i = 1; i <= url[0] && pos < 277; i++) buf[pos++] = url[i];
    buf[pos++] = '\n';

    long count = pos;
    (void)FSWrite(refNum, &count, buf);
    FSClose(refNum);

    gPollingForResult = true;
    gNextResultCheck  = TickCount() + 30;  /* first check ~0.5 s from now */
}

/* Load a document directly from a full Mac path (bypassing BuildSharedPath).
 * Used for URL-fetched result files written to :Unix: by the JS host. */
static void LoadDocumentFromFullPath(ConstStr255Param fullPath,
                                     ConstStr255Param displayName,
                                     Boolean          pushHistory)
{
    long n = ReadHtmlFile(fullPath);
    if (n < 0) return;   /* file not ready yet — caller retries */
    gHtmlLen = n;

    if (pushHistory && !PStrEqual(displayName, gCurrentDoc)) {
        if (gHistoryDepth < kHistoryDepth) {
            PStrCopy(gHistory[gHistoryDepth], gCurrentDoc);
            gHistoryDepth++;
        } else {
            for (int i = 1; i < kHistoryDepth; i++) {
                PStrCopy(gHistory[i - 1], gHistory[i]);
            }
            PStrCopy(gHistory[kHistoryDepth - 1], gCurrentDoc);
        }
    }
    PStrCopy(gCurrentDoc, displayName);

    /* Show "(fetched URL)" as the window title. */
    Str255 titleStr;
    GetIndString(titleStr, kStrListID, kStrFetchedUrl);
    if (titleStr[0] == 0) { titleStr[0] = 13; BlockMoveData("(fetched URL)", titleStr + 1, 13); }
    SetWTitle(gWindow, titleStr);

    RebuildLayout();
    InvalidateContent();
}

/* Poll for the URL fetch result written by the JS shared-poller.
 * Called from the main loop when gPollingForResult is true.
 * On success: loads the document and clears polling state.
 * On ENOENT: returns (will retry next tick).
 * On other error: gives up. */
static void CheckUrlResult(void)
{
    /* Build :Unix:__url-result-<id>.html */
    Str255 filename;
    Str255 idStr;
    LongToStr(gUrlRequestId, idStr);

    /* filename = "__url-result-" ++ id ++ ".html" */
    filename[0] = 0;
    PStrCat(filename, "\p__url-result-");
    PStrCat(filename, idStr);
    PStrCat(filename, "\p.html");

    Str255 fullPath;
    BuildUnixPath(fullPath, filename);

    short refNum = 0;
    OSErr err = HOpen(0, 0, fullPath, fsRdPerm, &refNum);
    if (err == fnfErr || err == nsvErr) {
        /* Not written yet — schedule next check in ~0.5 s. */
        gNextResultCheck = TickCount() + 30;
        return;
    }
    if (err != noErr) {
        /* Unexpected error — give up. */
        gPollingForResult = false;
        return;
    }
    FSClose(refNum);

    /* File is present — load it. */
    gPollingForResult = false;
    Str255 displayName;
    GetIndString(displayName, kStrListID, kStrFetchedUrl);
    LoadDocumentFromFullPath(fullPath, displayName, true);

    /* Clean up the result file so stale data doesn't confuse a future request. */
    HDelete(0, 0, fullPath);
}

/* Show the "Open URL" dialog (DLOG 131). On OK, write the URL request. */
static void DoOpenUrlDialog(void)
{
    DialogPtr dlg = GetNewDialog(kDialogOpenUrl, NULL, (WindowPtr)-1L);
    if (!dlg) return;

    /* Tell the Dialog Manager which items are default/cancel so Return and
     * Escape work as expected (inside Macintosh: Toolbox Essentials § 6-82). */
    SetDialogDefaultItem(dlg, 1);   /* item 1 = Open button */
    SetDialogCancelItem(dlg, 2);    /* item 2 = Cancel button */

    /* Put focus in the URL edit field (item 3). */
    SelectDialogItemText(dlg, 3, 0, 32767);

    short itemHit = 0;
    while (itemHit != 1 && itemHit != 2) {
        ModalDialog(NULL, &itemHit);
    }

    if (itemHit == 1) {
        /* Retrieve the URL text from item 3. */
        short  kind;
        Handle h;
        Rect   box;
        GetDialogItem(dlg, 3, &kind, &h, &box);
        Str255 url;
        GetDialogItemText(h, url);

        /* Ignore blank input. */
        if (url[0] > 0) {
            WriteUrlRequest(url);
        }
    }

    DisposeDialog(dlg);
}

/* ------------------------------------------------------ File I/O */

/* Read the file at the given full path into gHtmlBuf. Returns
 * the number of bytes read, or -1 on error.
 *
 * This is the File Manager — the classic Mac equivalent of POSIX open/
 * read/close. None of these are POSIX (no errno, no fd, no `<sys/...>`):
 *   HOpen   ~ open(path, O_RDONLY)   — returns a "refNum" (~ fd)
 *   FSRead  ~ read(fd, buf, n)        — reads up to *count bytes
 *   FSClose ~ close(fd)
 * Errors come back as OSErr (a SInt16). 0 = noErr; everything else is a
 * negative number defined in MacErrors.h.
 *
 * "H" in HOpen is "hierarchical" — the older flat File Manager from the
 * Mac 128K days didn't know about folders, so the H-prefixed variants
 * were added later (ca. HFS, 1985). All modern code should use them. */
static long ReadHtmlFile(ConstStr255Param fullPath)
{
    short refNum = 0;
    OSErr err;

    /* HOpen takes vRefNum=0 + dirID=0 + a colon-rooted volume:path Pascal
     * string. This works for absolute Mac paths starting with the volume
     * name (e.g. ":Shared:index.html"). fsRdPerm = open read-only. */
    err = HOpen(0, 0, fullPath, fsRdPerm, &refNum);
    if (err != noErr) return -1;

    /* FSRead's `count` is in/out: caller fills it with the buffer size,
     * the call updates it to bytes actually read. */
    long count = kHtmlBufferBytes;
    err = FSRead(refNum, &count, gHtmlBuf);
    /* eofErr is fine — it just means we got the rest of the file
     * (we hit EOF before filling the buffer). Any other OSErr is fatal. */
    FSClose(refNum);
    if (err != noErr && err != eofErr) return -1;
    return count;
}

/* ------------------------------------------------------ Window plumbing */

/* QuickDraw primer for the window code below:
 *   - A WindowPtr is also a "GrafPort" — a drawing destination. SetPort
 *     tells QuickDraw "send subsequent draw calls here".
 *   - portRect is the window's content area in *local* coordinates
 *     (origin at top-left of the content area, not the screen).
 *   - Rect is { top, left, bottom, right } — note the order, classic Mac
 *     puts the y-coordinates on the outside.
 *   - All drawing happens in pixels. The Mac of this era is a 1-bit
 *     monochrome display — black or white, no gray.
 */
static void GetContentRect(Rect *r)
{
    SetPort(gWindow);
    *r = gWindow->portRect;
    r->right -= kScrollBarWidth;       /* leave room for scroll bar */
    r->left  += kContentMargin;
    r->top   += kContentMargin;
    r->right -= kContentMargin;
}

/* Resize the scroll bar to match the current window. Called on init and
 * after layout (to recompute scrollable range).
 *
 * "Control" in classic Mac OS = any clickable widget the Toolbox ships:
 * scroll bar, button, checkbox, radio. They have a min/max/value tuple
 * and a part code system for hit-testing. */
static void ConfigureScrollBar(void)
{
    if (!gScrollBar) return;
    SetPort(gWindow);
    Rect wr = gWindow->portRect;

    /* Move/resize the bar to sit flush along the right edge. */
    HideControl(gScrollBar);
    MoveControl(gScrollBar, wr.right - kScrollBarWidth, wr.top - 1);
    SizeControl(gScrollBar, kScrollBarWidth + 1, wr.bottom - wr.top + 1 - 14);

    /* Range: 0..(content_height - viewport_height), clamped >= 0. */
    Rect cr;
    GetContentRect(&cr);
    short viewport_h = cr.bottom - cr.top;
    short maxScroll = gLayout.content_height - viewport_h;
    if (maxScroll < 0) maxScroll = 0;
    SetControlMinimum(gScrollBar, 0);
    SetControlMaximum(gScrollBar, maxScroll);
    if (GetControlValue(gScrollBar) > maxScroll) {
        SetControlValue(gScrollBar, maxScroll);
    }
    ShowControl(gScrollBar);
}

/* ------------------------------------------------------ Drawing */

/* QuickDraw text rendering, for the uninitiated:
 *   TextFont(id) — pick the font (by numeric Font Manager ID).
 *   TextSize(n)  — point size.
 *   TextFace(b)  — bold/italic/underline/etc bits.
 *   MoveTo(x,y)  — move the pen. y is the BASELINE, not the top.
 *   DrawString(\p"...")    — draw a Pascal string at the pen.
 *   DrawText(buf, off, n)  — draw n bytes from a non-Pascal buffer.
 *
 * There's no font name lookup — every font has a numeric ID. `applFont`
 * is the application font (Geneva on default System 7). `monaco` would
 * be a name but Retro68's Fonts.h doesn't export it, so we use the
 * Font Manager's hardcoded ID 4. (LEARNINGS.md catches this Retro68
 * quirk: applFont yes, geneva/monaco names no.) */
static void ApplyDrawOpFont(const DrawOp *op)
{
    /* family→font: applFont (Geneva on default System 7) for body,
     * Monaco (font ID 4 on System 7) for monospace. If Monaco is missing
     * on the user's system the Font Manager falls back gracefully to the
     * system font. */
    if (op->family == DRAW_FAMILY_MONO) {
        TextFont(4);   /* Monaco */
    } else {
        TextFont(applFont);
    }
    TextSize(op->font_size);
    TextFace(op->face);   /* Toolbox Style is a SInt8 of bold/italic/underline bits */
}

static void DrawCBytes(short x, short y, const char *bytes, short len)
{
    /* DrawText takes a non-Pascal byte buffer + offset + length. Perfect
     * for layout strings that aren't NUL-rooted. Cast strips the const
     * qualifier — DrawText's prototype takes Ptr (non-const) but it
     * doesn't mutate the buffer in practice. */
    MoveTo(x, y);
    DrawText((Ptr)bytes, 0, len);
}

static void DrawBullet(short x, short y, unsigned char size)
{
    /* QuickDraw circle as a small filled oval. PaintOval(&r) fills the
     * given rect with the current pen pattern (default: solid black).
     * The bullet sits ~2px above the baseline, sized to match the body
     * font. */
    Rect r;
    short half = (short)(size / 4);
    if (half < 2) half = 2;
    r.left   = x;
    r.top    = (short)(y - size / 2);
    r.right  = (short)(x + 2 * half);
    r.bottom = (short)(r.top + 2 * half);
    PaintOval(&r);
}

/* Repaint the content area from the current HtmlLayout. Called on every
 * update event (the OS sends one whenever a region of our window has
 * been exposed and needs re-drawing — there's no automatic backing
 * store on classic Mac OS, so the app is responsible for redrawing on
 * demand). */
static void DrawContent(void)
{
    SetPort(gWindow);
    Rect cr;
    GetContentRect(&cr);

    /* Erase the content area to white (the scroll bar paints itself
     * separately, so we leave its rect alone). EraseRect uses the
     * GrafPort's *background* pattern, which defaults to white. */
    Rect erase = cr;
    EraseRect(&erase);

    short scrollY = gScrollBar ? GetControlValue(gScrollBar) : 0;

    /* RgnHandle = a handle to a "region" — QuickDraw's flexible 2D mask
     * type (think arbitrary-shaped clip path). Here we save the current
     * clip, restrict drawing to the content rect so wrapped text doesn't
     * bleed onto the scroll bar or chrome, and restore at the bottom. */
    RgnHandle clip = NewRgn();
    GetClip(clip);
    ClipRect(&cr);

    for (int i = 0; i < gLayout.op_count; i++) {
        const DrawOp *op = &gLayout.ops[i];
        short x = (short)(cr.left + op->x);
        short y = (short)(cr.top  + op->y - scrollY);
        if (y < cr.top - 32 || y > cr.bottom + 32) continue;  /* off-screen */

        switch (op->kind) {
            case DRAW_OP_TEXT: {
                ApplyDrawOpFont(op);
                DrawCBytes(x, y, gLayout.strpool + op->text_off, op->text_len);
                break;
            }
            case DRAW_OP_BULLET: {
                DrawBullet(x, (short)(y - op->font_size / 2), op->font_size);
                break;
            }
            case DRAW_OP_LINK_REGION:
                /* Bounds-only op; no visible artifact (text under it has
                 * underline already). */
                break;
        }
    }

    /* Restore clip and reset face. */
    SetClip(clip);
    DisposeRgn(clip);
    TextFont(applFont);
    TextSize(12);
    TextFace(0);

    /* Update the scroll bar in case the layout grew/shrank. */
    if (gScrollBar) Draw1Control(gScrollBar);
}

/* Mark the whole window as needing a redraw. The OS will then post an
 * `updateEvt` to our event loop on the next pass — that's where the
 * actual repaint happens (DoUpdate → DrawContent). This is the
 * Mac-equivalent of "setNeedsDisplay" / "scheduleRepaint": we don't
 * draw immediately, we ask to be notified later. */
static void InvalidateContent(void)
{
    SetPort(gWindow);
    InvalRect(&gWindow->portRect);
}

/* ------------------------------------------------------ Layout pipeline */

static void RebuildLayout(void)
{
    Rect cr;
    GetContentRect(&cr);
    short width = cr.right - cr.left;
    if (width < 80) width = 80;
    html_tokenize(gHtmlBuf, (size_t)gHtmlLen, &gTokens);
    html_layout_build(&gTokens, &gLayout, width, 12);
    if (gScrollBar) {
        SetControlValue(gScrollBar, 0);
        ConfigureScrollBar();
    }
}

static void SetWindowTitleFromDoc(void)
{
    Str255 title;
    title[0] = 0;
    /* "\pReader — " is a Pascal-string literal: the \p prefix tells the
     * compiler to emit a length byte at offset 0 followed by the chars.
     * Try changing the title text here and clicking Build & Run to see
     * the change in the emulator within ~1 second. */
    PStrCat(title, "\pReader — ");
    PStrCat(title, gCurrentDoc);
    SetWTitle(gWindow, title);   /* Set Window Title — Toolbox call */
}

/* Load the no-content fallback HTML from STR# 5. Used when ReadHtmlFile
 * fails — usually because the JS host hasn't mounted :Shared: yet, or the
 * extfs source folder is empty. */
static void LoadFallback(void)
{
    Str255 msg;
    GetIndString(msg, kStrListID, kStrFallbackHtml);
    long len = msg[0];
    if (len > kHtmlBufferBytes) len = kHtmlBufferBytes;
    BlockMoveData(msg + 1, gHtmlBuf, len);
    gHtmlLen = len;
}

/* Try to load the named document; on success update history + title.
 * `pushHistory` controls whether the previous doc is pushed onto the
 * back-stack (false for Back navigation). */
static void LoadDocument(ConstStr255Param docName, Boolean pushHistory)
{
    Str255 fullPath;
    BuildSharedPath(fullPath, docName);
    long n = ReadHtmlFile(fullPath);
    if (n < 0) {
        LoadFallback();
    } else {
        gHtmlLen = n;
    }

    if (pushHistory && !PStrEqual(docName, gCurrentDoc)) {
        if (gHistoryDepth < kHistoryDepth) {
            PStrCopy(gHistory[gHistoryDepth], gCurrentDoc);
            gHistoryDepth++;
        } else {
            /* Drop oldest. */
            for (int i = 1; i < kHistoryDepth; i++) {
                PStrCopy(gHistory[i - 1], gHistory[i]);
            }
            PStrCopy(gHistory[kHistoryDepth - 1], gCurrentDoc);
        }
    }
    PStrCopy(gCurrentDoc, docName);
    SetWindowTitleFromDoc();
    RebuildLayout();
    InvalidateContent();
}

static void NavigateBack(void)
{
    if (gHistoryDepth == 0) return;
    Str63 prev;
    PStrCopy(prev, gHistory[gHistoryDepth - 1]);
    gHistoryDepth--;
    LoadDocument(prev, false);
}

/* Map a C-string href (from the layout strpool) to a Pascal string and
 * then load it. We don't try to handle full URLs — only relative names
 * like "about.html". */
static void NavigateLink(const char *href, unsigned short hlen)
{
    Str63 docName;
    if (hlen == 0 || hlen > 63) return;
    /* Strip any leading "./" the markup might carry. */
    unsigned short start = 0;
    if (hlen >= 2 && href[0] == '.' && href[1] == '/') start = 2;
    docName[0] = (unsigned char)(hlen - start);
    BlockMoveData(href + start, docName + 1, hlen - start);
    LoadDocument(docName, true);
}

/* ------------------------------------------------------ Mouse handling */

static void HandleContentClick(Point local)
{
    Rect cr;
    GetContentRect(&cr);
    if (!PtInRect(local, &cr)) {
        /* Maybe a click in the scroll bar. */
        if (gScrollBar) {
            ControlHandle which = NULL;
            short part = FindControl(local, gWindow, &which);
            if (part != 0 && which == gScrollBar) {
                /* TrackControl needs an actionProc only for thumb arrows;
                 * for thumb itself we read the value after the call. */
                (void)TrackControl(which, local, NULL);
                InvalidateContent();
            }
        }
        return;
    }

    short scrollY = gScrollBar ? GetControlValue(gScrollBar) : 0;
    short hx = (short)(local.h - cr.left);
    short hy = (short)(local.v - cr.top + scrollY);
    int hit = html_layout_hit_link(&gLayout, hx, hy);
    if (hit < 0) return;

    const DrawOp *op = &gLayout.ops[hit];
    NavigateLink(gLayout.strpool + op->href_off, op->href_len);
}

/* ------------------------------------------------------ Menu glue */

static void ShowAbout(void)
{
    (void)Alert(kAlertAbout, NULL);
}

/* Open dialog: classic SFGetFile filtered to .html/.htm. The user picks a
 * file under :Shared: and we feed its name into LoadDocument. (We don't
 * try to navigate volumes — files outside :Shared: would break relative
 * link resolution anyway.) */
static void DoOpen(void)
{
    SFTypeList types;
    StandardFileReply reply;
    types[0] = 'TEXT';
    StandardGetFile(NULL, 1, types, &reply);
    if (!reply.sfGood) return;
    /* Use just the file name (assumes the user picked from :Shared:). */
    LoadDocument(reply.sfFile.name, true);
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
            case kFileOpen:  DoOpen(); break;
            case kFileClose: gQuit = true; break;
            case kFileQuit:  gQuit = true; break;
        }
    } else if (menuID == kMenuEdit) {
        (void)SystemEdit(menuItem - 1);
    } else if (menuID == kMenuView) {
        switch (menuItem) {
            case kViewReload:  LoadDocument(gCurrentDoc, false); break;
            case kViewBack:    NavigateBack();                   break;
            case kViewOpenUrl: DoOpenUrlDialog();                break;
        }
    }
    HiliteMenu(0);
}

/* ------------------------------------------------------ AppleEvents */

/*
 * AppleEvents are the classic-Mac inter-process messaging system —
 * roughly analogous to Unix signals + DBus + an RPC layer all at once.
 * The Finder uses them to tell apps "the user double-clicked one of
 * your documents", "please quit", and so on. Each event has a 4-char
 * event class + 4-char event ID; the four "core" events
 * ('aevt'/'oapp', 'aevt'/'odoc', 'aevt'/'pdoc', 'aevt'/'quit') are the
 * ones every well-behaved app handles.
 *
 * Finder integration: when the user double-clicks a TEXT/CVMR file (i.e. an
 * .html that scripts/build-boot-disk.sh tagged), the Process Manager
 * launches us if needed and posts a kCoreEventClass / kAEOpenDocuments
 * AppleEvent containing an FSSpec list. When we're launched with no
 * documents (e.g. from Startup Items or a bare double-click on the app),
 * we get kAEOpenApplication instead. The Finder also posts
 * kAEQuitApplication on shutdown / Force Quit.
 *
 * Without these handlers, classic Mac OS 7 still launches us, but the
 * 'odoc' AppleEvent goes unhandled — so we boot to index.html no matter
 * which file the user double-clicked. The whole point of this plumbing is
 * to wire the FSSpec from 'odoc' through to LoadDocument().
 *
 * Per AppleEvents docs (Inside Macintosh: Interapplication Communication
 * ch. 4), every handler must return noErr or a meaningful AE error code,
 * and reply parameters are owned by the AE machinery — we just read.
 */

/*
 * MissedAnyParameters — the conventional AppleEvent sanity check. After we
 * pull every parameter we care about, ask the AE for the magic
 * "keyMissedKeywordAttr" attribute. If that returns errAEDescNotFound, we
 * extracted everything; if it returns noErr, the sender supplied
 * parameters we ignored, and the polite thing per IM is to fail the
 * event with errAEEventNotHandled. We let it slide here because Reader's
 * 'odoc' use is open-the-first-doc-and-go; extra parameters from a script
 * shouldn't break that.
 */
/* Multiversal's AppleEvents.yaml ships the function but not this attribute
 * keyword — define it inline so we don't have to patch the toolchain.
 * Value 'miss' is the long-standing AppleEvent constant from Inside
 * Macintosh: IAC. */
#ifndef keyMissedKeywordAttr
#define keyMissedKeywordAttr 'miss'
#endif

static OSErr MissedAnyParameters(const AppleEvent *evt)
{
    DescType returnedType;
    Size actualSize;
    OSErr err = AEGetAttributePtr((AppleEvent *)evt, keyMissedKeywordAttr,
                                   typeWildCard, &returnedType,
                                   NULL, 0, &actualSize);
    /* errAEDescNotFound => no missed params (the desired outcome). */
    if (err == errAEDescNotFound) return noErr;
    if (err == noErr) return errAEEventNotHandled;
    return err;
}

/* Default-open: use whatever STR# 128/2 says (currently "index.html"). */
static void LoadDefaultDocument(void)
{
    Str63 startDoc;
    GetIndString(startDoc, kStrListID, kStrIndex);
    if (startDoc[0] == 0) {
        /* GetIndString failed (resource missing?) — hard-code the fallback
         * so we don't ship a dead app if the STR# slot ever drifts. */
        startDoc[0] = 10;
        BlockMoveData("index.html", startDoc + 1, 10);
    }
    LoadDocument(startDoc, false);
}

/* 'oapp' — Open Application. Sent when we launch with no documents
 * (Startup Items, a bare Finder double-click on Reader, applet-style
 * launch via osascript). Behaviour: load the default doc. */
static pascal OSErr HandleOpenApp(const AppleEvent *evt, AppleEvent *reply,
                                  long refcon)
{
    (void)reply; (void)refcon;
    OSErr err = MissedAnyParameters(evt);
    if (err != noErr) return err;
    LoadDefaultDocument();
    return noErr;
}

/* 'odoc' — Open Documents. The direct object (keyDirectObject) is an
 * AEDescList of FSSpecs. We coerce to typeAEList, count, then pull #1 as
 * an FSSpec, and use its `name` field directly — Reader's loader takes a
 * filename and joins it under :Shared: itself. (Multi-doc + arbitrary
 * folder support are out of scope; if the user opens a doc that's not in
 * :Shared: the `:Shared:<name>` HOpen will simply fail and we'll fall
 * through to the no-content message — better than crashing.) */
static pascal OSErr HandleOpenDocs(const AppleEvent *evt, AppleEvent *reply,
                                   long refcon)
{
    (void)reply; (void)refcon;

    AEDescList docList;
    OSErr err = AEGetParamDesc((AppleEvent *)evt, keyDirectObject,
                                typeAEList, &docList);
    if (err != noErr) return err;

    long count = 0;
    err = AECountItems(&docList, &count);
    if (err != noErr || count < 1) {
        AEDisposeDesc(&docList);
        return err == noErr ? errAEEventNotHandled : err;
    }

    /* Grab item #1 as an FSSpec. AEGetNthPtr fills our buffer directly —
     * no handle juggling. */
    FSSpec spec;
    AEKeyword keyword;
    DescType actualType;
    Size actualSize;
    err = AEGetNthPtr(&docList, 1, typeFSS, &keyword, &actualType,
                      &spec, sizeof(spec), &actualSize);
    AEDisposeDesc(&docList);
    if (err != noErr) return err;

    err = MissedAnyParameters(evt);
    if (err != noErr) return err;

    /* The FSSpec name is a Str63 (Pascal string) — exactly what
     * LoadDocument wants. We don't honour the spec's vRefNum/parID
     * (Reader's :Shared:-prefix path resolution is hard-coded to the
     * boot volume), but for files baked into :Shared: by build-boot-disk.sh
     * the name alone is enough. */
    LoadDocument(spec.name, true);
    return noErr;
}

/* 'quit' — Quit Application. Trip the event-loop sentinel; the actual
 * teardown happens after WaitNextEvent returns. */
static pascal OSErr HandleQuitApp(const AppleEvent *evt, AppleEvent *reply,
                                  long refcon)
{
    (void)reply; (void)refcon;
    OSErr err = MissedAnyParameters(evt);
    if (err != noErr) return err;
    gQuit = true;
    return noErr;
}

static void InstallAppleEventHandlers(void)
{
    /* NewAEEventHandlerUPP wraps a C function pointer so it's callable
     * from the AE machinery — on 68k builds it's a real glue stub, on
     * Retro68's modern toolchain it's a no-op cast, but we always go
     * through the wrapper so the same source compiles for either target.
     * Pass refcon=0 — Reader's handlers don't carry per-install state,
     * they read globals directly. */
    AEEventHandlerUPP openAppUPP   = NewAEEventHandlerUPP(HandleOpenApp);
    AEEventHandlerUPP openDocsUPP  = NewAEEventHandlerUPP(HandleOpenDocs);
    AEEventHandlerUPP quitAppUPP   = NewAEEventHandlerUPP(HandleQuitApp);

    (void)AEInstallEventHandler(kCoreEventClass, kAEOpenApplication,
                                openAppUPP, 0L, false);
    (void)AEInstallEventHandler(kCoreEventClass, kAEOpenDocuments,
                                openDocsUPP, 0L, false);
    (void)AEInstallEventHandler(kCoreEventClass, kAEQuitApplication,
                                quitAppUPP, 0L, false);
}

/* ------------------------------------------------------ Events */

static void DoUpdate(WindowPtr w)
{
    SetPort(w);
    BeginUpdate(w);
    DrawContent();
    if (gScrollBar) DrawControls(w);
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
        case inGrow: {
            long newSize = GrowWindow(win, e->where, &qd.screenBits.bounds);
            if (newSize) {
                short h = (short)(newSize & 0xFFFF);
                short w = (short)((newSize >> 16) & 0xFFFF);
                SizeWindow(win, w, h, true);
                ConfigureScrollBar();
                RebuildLayout();
                InvalidateContent();
            }
            break;
        }
        case inContent: {
            if (win != FrontWindow()) {
                SelectWindow(win);
            } else {
                Point local = e->where;
                SetPort(win);
                GlobalToLocal(&local);
                HandleContentClick(local);
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
        return;
    }
    /* Backspace = Back; arrow keys scroll. */
    if (key == 0x08 || key == 0x7F) {
        NavigateBack();
        return;
    }
    if (gScrollBar) {
        short v = GetControlValue(gScrollBar);
        short maxV = GetControlMaximum(gScrollBar);
        Rect cr; GetContentRect(&cr);
        short page = (short)((cr.bottom - cr.top) - 24);
        if (page < 16) page = 16;
        switch (key) {
            case 0x1E: v -= 24;    break;   /* up arrow */
            case 0x1F: v += 24;    break;   /* down arrow */
            case 0x0B: v -= page;  break;   /* page up */
            case 0x0C: v += page;  break;   /* page down */
            case ' ':  v += page;  break;
            default:   return;
        }
        if (v < 0) v = 0;
        if (v > maxV) v = maxV;
        SetControlValue(gScrollBar, v);
        InvalidateContent();
    }
}

/* ------------------------------------------------------ main */

int main(void)
{
    /* The classic-Mac-app boot sequence. Every System 7 application opens
     * with this incantation, in this order. Each call wakes up one of the
     * Toolbox managers — none of them have implicit init.
     *
     * Memory Manager primer: the Mac heap is divided into "master pointer
     * blocks", and every Handle (a pointer-to-pointer that the OS can
     * relocate to compact the heap) needs a master pointer. The OS
     * allocates them in batches; if you exhaust the initial pool mid-app,
     * the heap fragments. MoreMasters preallocates an extra batch.
     * Calling it 3x is cargo-culted from Inside Macintosh sample code —
     * it gives us 3*64 = 192 master pointers up front, plenty for a
     * one-window app.
     *
     * MaxApplZone expands the application heap to its max size right at
     * launch so it doesn't grow incrementally (which can also fragment).
     */
    MaxApplZone();
    MoreMasters(); MoreMasters(); MoreMasters();
    InitGraf(&qd.thePort);   /* QuickDraw — wakes up the global GrafPort */
    InitFonts();             /* Font Manager — needed before any TextFont */
    InitWindows();           /* Window Manager */
    InitMenus();             /* Menu Manager */
    TEInit();                /* TextEdit (used by Apple-menu DAs)        */
    InitDialogs(NULL);       /* Dialog Manager (Alert/Modal dialogs)     */
    InitCursor();            /* Sets cursor to standard arrow            */

    Handle mbar = GetNewMBar(128);
    SetMenuBar(mbar);
    AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
    DrawMenuBar();

    /* Hook up Finder integration BEFORE the first WaitNextEvent. The
     * launch-time AppleEvent (oapp or odoc) is queued by the Process
     * Manager during launch and dispatched the first time the app spins
     * an event loop — if our handlers aren't installed yet, the queued
     * event just goes to /dev/null and we fall back to LoadDefaultDocument
     * via the fallback at the bottom of main(). Installing here is the
     * standard MPW idiom (Inside Macintosh: IAC, "Receiving Apple
     * Events", listing 4-1). */
    InstallAppleEventHandlers();

    gWindow = GetNewWindow(kWindResID, NULL, (WindowPtr)-1L);
    if (!gWindow) {
        SysBeep(20);
        return 1;
    }
    SetPort(gWindow);
    TextFont(applFont);
    TextSize(12);

    /* Vertical scroll bar — the bar's WIND-relative rect is set up by
     * ConfigureScrollBar based on the actual window dimensions. */
    Rect sbRect = { 0, 0, 100, kScrollBarWidth };
    gScrollBar = NewControl(gWindow, &sbRect, "\p", false, 0, 0, 0,
                            scrollBarProc, 0L);
    ConfigureScrollBar();

    /* Seed gCurrentDoc with a sane Pascal string so SetWindowTitleFromDoc
     * doesn't draw garbage if we paint before any AE arrives. The actual
     * load happens in three places now:
     *   - HandleOpenApp  ('oapp' from the Finder, or Startup Items launch)
     *   - HandleOpenDocs ('odoc' from a TEXT/CVMR double-click)
     *   - the fallback below, in case neither AE arrives (e.g. running
     *     under an old Finder, or a stub launcher that never sends AEs).
     *
     * Loading inside HandleOpenApp/HandleOpenDocs (rather than here, then
     * stomping on top from the AE) is what makes double-clicked .html
     * files actually *open*: if we always called LoadDefaultDocument()
     * up front, an 'odoc' arriving milliseconds later would have to
     * un-load index and re-load the requested doc, briefly flashing the
     * wrong content. */
    Str63 placeholder;
    GetIndString(placeholder, kStrListID, kStrEmptyTitle);
    if (placeholder[0] == 0) {
        placeholder[0] = 13;
        BlockMoveData("(no document)", placeholder + 1, 13);
    }
    PStrCopy(gCurrentDoc, placeholder);

    /* Spin the event loop once with a short timeout so the Process Manager
     * gets a chance to deliver the queued launch AppleEvent before we
     * decide whether to fall back. WaitNextEvent with sleep=1 returns fast
     * if there's nothing pending; if 'oapp' or 'odoc' is queued, it'll be
     * a kHighLevelEvent and we route it via AEProcessAppleEvent. */
    {
        EventRecord e;
        if (WaitNextEvent(highLevelEventMask, &e, 1L, NULL)) {
            if (e.what == kHighLevelEvent) {
                (void)AEProcessAppleEvent(&e);
            }
        }
    }
    /* If nothing handled the launch event (unlikely on real System 7, but
     * the case under stub launchers and during local-dev hot reloads),
     * load the default. PStrEqual against the placeholder is the
     * "did anyone load anything yet?" probe. */
    if (PStrEqual(gCurrentDoc, placeholder)) {
        LoadDefaultDocument();
    }

    while (!gQuit) {
        EventRecord e;
        /* When polling for a URL result, use a short sleep so we check
         * frequently. TickCount() runs at ~60 Hz — 5 ticks ≈ 83 ms. */
        long sleepTicks = gPollingForResult ? 5L : 30L;
        if (WaitNextEvent(everyEvent, &e, sleepTicks, NULL)) {
            switch (e.what) {
                case mouseDown:   DoMouseDown(&e);                 break;
                case keyDown:     DoKeyDown(&e);                   break;
                case autoKey:     DoKeyDown(&e);                   break;
                case updateEvt:   DoUpdate((WindowPtr)e.message);  break;
                case activateEvt: /* nothing — single-window app */ break;
                case kHighLevelEvent:
                    /* Finder/scripts can send 'odoc' or 'quit' at any
                     * time, not just at launch. AEProcessAppleEvent
                     * dispatches to whichever handler we installed. */
                    (void)AEProcessAppleEvent(&e);
                    break;
            }
        }

        /* URL result polling — check once every ~30 ticks when active. */
        if (gPollingForResult && TickCount() >= gNextResultCheck) {
            CheckUrlResult();
        }
    }

    return 0;
}
