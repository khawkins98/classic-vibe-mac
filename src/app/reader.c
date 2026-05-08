/*
 * reader.c — Mac Toolbox UI shell for the classic-vibe-mac HTML viewer.
 *
 * Name choice — "Reader": the app's job is to read HTML files from a
 * shared volume and render them. "Reader" is concrete and accurate (a
 * document reader); "Pages" was the runner-up but reads as a different
 * Apple-branded product. We pick neutrality + clarity.
 *
 * Pipeline:
 *   :Shared:<name>.html  --FSpOpenDF/FSRead-->  raw bytes
 *   raw bytes            --html_tokenize-->     HtmlTokenList
 *   HtmlTokenList        --html_layout_build--> HtmlLayout (DrawOps)
 *   DrawOps              --DrawText / TextFace--> on-screen pixels
 *
 * The Toolbox shell is intentionally dumb: all parsing/layout lives in
 * html_parse.c and is host-tested. This file owns the event loop, scroll
 * bar, file I/O, link clicks, and font setup.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68. The shared-folder
 * mount (Mac volume named "Shared") is provided by BasiliskII's extfs
 * machinery wired up by the JS host — this app just opens files via
 * FSpOpenDF on a pre-existing path.
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
#include <Files.h>
/* Controls Manager (NewControl, TrackControl, GetControlValue, ...) is
 * declared in Windows.h in Retro68's multiversal interfaces — there is
 * no standalone Controls.h header in this toolchain. */

#include "html_parse.h"

/* ------------------------------------------------------------------ IDs */

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

    kViewReload = 1,
    kViewBack   = 2
};

enum {
    kAlertAbout = 128,
    kAlertNote  = 130
};

enum {
    kStrShared      = 1,    /* ":Shared:" */
    kStrIndex       = 2,    /* "index.html" */
    kStrEmptyTitle  = 3,    /* "(no document)" */
    kStrErrTitle    = 4,    /* "Reader" */
    kStrFallbackHtml = 5    /* HTML body shown when no content found */
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

/* Pascal-string global initialised at runtime — Retro68's GCC won't
 * implicitly cast a "\p..." char array literal into the unsigned char
 * Str63 type at file scope. SetCurrentDocName() in main() seeds it. */
static Str63       gCurrentDoc;
static Str63       gHistory[kHistoryDepth];
static short       gHistoryDepth   = 0;

/* ----------------------------------------------------- Pascal-string utils */

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

/* Build a Str255 holding ":Shared:<docName>". docName is a Pascal string. */
static void BuildSharedPath(StringPtr out, ConstStr255Param docName)
{
    Str255 prefix;
    GetIndString(prefix, kStrListID, kStrShared);   /* ":Shared:" */
    if (prefix[0] == 0) {
        prefix[0] = 8;
        BlockMoveData(":Shared:", prefix + 1, 8);
    }
    PStrCopy(out, prefix);
    PStrCat(out, docName);
}

/* ------------------------------------------------------ File I/O */

/* Read the file at the given full path into gHtmlBuf. Returns
 * the number of bytes read, or -1 on error. */
static long ReadHtmlFile(ConstStr255Param fullPath)
{
    short refNum = 0;
    OSErr err;

    /* HOpen takes vRefNum=0 + dirID=0 + a colon-rooted volume:path Pascal
     * string. This works for absolute Mac paths starting with the volume
     * name. */
    err = HOpen(0, 0, fullPath, fsRdPerm, &refNum);
    if (err != noErr) return -1;

    long count = kHtmlBufferBytes;
    err = FSRead(refNum, &count, gHtmlBuf);
    /* eofErr is fine — it just means we got the rest of the file. */
    FSClose(refNum);
    if (err != noErr && err != eofErr) return -1;
    return count;
}

/* ------------------------------------------------------ Window plumbing */

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
 * after layout (to recompute scrollable range). */
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

static void ApplyDrawOpFont(const DrawOp *op)
{
    /* family→font: applFont (Geneva on default System 7) for body,
     * Monaco (font ID 4 on System 7) for monospace. Retro68's Fonts.h
     * exposes applFont/systemFont but not per-family aliases like
     * `monaco` or `geneva` — use the numeric ID directly. If Monaco is
     * missing on the user's system the Font Manager falls back
     * gracefully to the system font. */
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
    /* QuickDraw circle as a small filled oval. The bullet sits ~2px above
     * the baseline, sized to match the body font. */
    Rect r;
    short half = (short)(size / 4);
    if (half < 2) half = 2;
    r.left   = x;
    r.top    = (short)(y - size / 2);
    r.right  = (short)(x + 2 * half);
    r.bottom = (short)(r.top + 2 * half);
    PaintOval(&r);
}

static void DrawContent(void)
{
    SetPort(gWindow);
    Rect cr;
    GetContentRect(&cr);

    /* Erase the content area (not the scroll bar — that paints itself). */
    Rect erase = cr;
    EraseRect(&erase);

    short scrollY = gScrollBar ? GetControlValue(gScrollBar) : 0;

    /* Clip so wrapped text doesn't bleed onto the scroll bar or chrome. */
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
    PStrCat(title, "\pReader — ");
    PStrCat(title, gCurrentDoc);
    SetWTitle(gWindow, title);
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
            case kViewReload: LoadDocument(gCurrentDoc, false); break;
            case kViewBack:   NavigateBack();                   break;
        }
    }
    HiliteMenu(0);
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
    /* Standard System 7 init dance. MoreMasters preallocates master pointer
     * blocks so future NewHandle calls don't fragment the heap. */
    MaxApplZone();
    MoreMasters(); MoreMasters(); MoreMasters();
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

    /* Initial doc: index.html under :Shared:. */
    Str63 startDoc;
    GetIndString(startDoc, kStrListID, kStrIndex);
    if (startDoc[0] == 0) {
        startDoc[0] = 10;
        BlockMoveData("index.html", startDoc + 1, 10);
    }
    PStrCopy(gCurrentDoc, startDoc);
    LoadDocument(startDoc, false);

    while (!gQuit) {
        EventRecord e;
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown:   DoMouseDown(&e);                 break;
                case keyDown:     DoKeyDown(&e);                   break;
                case autoKey:     DoKeyDown(&e);                   break;
                case updateEvt:   DoUpdate((WindowPtr)e.message);  break;
                case activateEvt: /* nothing — single-window app */ break;
            }
        }
    }

    return 0;
}
