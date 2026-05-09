/*
 * markdownviewer.c — Classic Mac Toolbox shell for the Markdown Viewer.
 *
 * Architecture is a close parallel to reader.c (the HTML viewer):
 *
 *   :Shared:<name>.md  --HOpen/FSRead-------->  raw bytes
 *   raw bytes          --md_layout_build----->  MdLayout (DrawOps)
 *   DrawOps            --DrawText / TextFace->  on-screen pixels
 *
 * The shell owns: event loop, scroll bar, file I/O, menu handling, and
 * Finder integration (AppleEvents oapp / odoc / quit).  All Markdown
 * parsing and word-wrap live in markdown_parse.c and are host-testable.
 *
 * Differences from reader.c:
 *   - No URL fetch / shared-poller polling (simpler event loop)
 *   - No Back navigation (single-document viewer; File > Open to switch)
 *   - Creator code 'CVMV'; default document "README.md"
 *   - Link regions are shown underlined but clicking them is a no-op in v1
 *     (no in-browser navigation integration yet)
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
#include <AppleEvents.h>

#include "markdown_parse.h"

/* ------------------------------------------------------------------ IDs */

enum {
    kMenuApple = 128,
    kMenuFile  = 129,
    kMenuEdit  = 130
};

enum {
    kAppleAbout = 1,

    kFileOpen   = 1,
    kFileClose  = 2,
    kFileQuit   = 4
};

enum {
    kAlertAbout = 128
};

enum {
    kStrShared       = 1,    /* ":Shared:" */
    kStrDefaultDoc   = 2,    /* "README.md" */
    kStrEmptyTitle   = 3,    /* "(no document)" */
    kStrAppName      = 4,    /* "Markdown Viewer" */
    kStrFallbackText = 5     /* shown when no doc found */
};

enum {
    kWindResID  = 128,
    kStrListID  = 128
};

/* ------------------------------------------------------------ Layout */

#define kScrollBarWidth  16
#define kContentMargin    8

/* ------------------------------------------------------------ State */

#define kMdBufferBytes  32768      /* enough for a typical README */

static WindowPtr     gWindow    = NULL;
static ControlHandle gScrollBar = NULL;
static Boolean       gQuit      = false;

static char          gMdBuf[kMdBufferBytes];
static long          gMdLen     = 0;
static MdLayout      gLayout;

static Str63  gCurrentDoc;

/* ------------------------------------------------- Pascal-string utils */

static void PStrCat(StringPtr dest, ConstStr255Param src)
{
    int dl = dest[0], sl = src[0];
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

/* Build ":Shared:<docName>" into out (both are Pascal strings). */
static void BuildSharedPath(StringPtr out, ConstStr255Param docName)
{
    Str255 prefix;
    GetIndString(prefix, kStrListID, kStrShared);
    if (prefix[0] == 0) {
        prefix[0] = 8;
        BlockMoveData(":Shared:", prefix + 1, 8);
    }
    PStrCopy(out, prefix);
    PStrCat(out, docName);
}

/* ------------------------------------------------------ File I/O */

/* Read the Markdown file at fullPath into gMdBuf.
 * Returns byte count read, or -1 on error. */
static long ReadMdFile(ConstStr255Param fullPath)
{
    short refNum = 0;
    OSErr err;

    err = HOpen(0, 0, fullPath, fsRdPerm, &refNum);
    if (err != noErr) return -1;

    long count = kMdBufferBytes;
    err = FSRead(refNum, &count, gMdBuf);
    FSClose(refNum);
    if (err != noErr && err != eofErr) return -1;
    return count;
}

/* ------------------------------------------------------ Window plumbing */

static void GetContentRect(Rect *r)
{
    SetPort(gWindow);
    *r = gWindow->portRect;
    r->right -= kScrollBarWidth;
    r->left  += kContentMargin;
    r->top   += kContentMargin;
    r->right -= kContentMargin;
}

static void ConfigureScrollBar(void)
{
    if (!gScrollBar) return;
    SetPort(gWindow);
    Rect wr = gWindow->portRect;

    HideControl(gScrollBar);
    MoveControl(gScrollBar, wr.right - kScrollBarWidth, wr.top - 1);
    SizeControl(gScrollBar, kScrollBarWidth + 1, wr.bottom - wr.top + 1 - 14);

    Rect cr;
    GetContentRect(&cr);
    short viewport_h = cr.bottom - cr.top;
    short maxScroll  = gLayout.content_height - viewport_h;
    if (maxScroll < 0) maxScroll = 0;
    SetControlMinimum(gScrollBar, 0);
    SetControlMaximum(gScrollBar, maxScroll);
    if (GetControlValue(gScrollBar) > maxScroll)
        SetControlValue(gScrollBar, maxScroll);
    ShowControl(gScrollBar);
}

/* ------------------------------------------------------ Drawing */

static void ApplyDrawOpFont(const DrawOp *op)
{
    if (op->family == DRAW_FAMILY_MONO) {
        TextFont(4);   /* Monaco */
    } else {
        TextFont(applFont);
    }
    TextSize(op->font_size);
    TextFace(op->face);
}

static void DrawCBytes(short x, short y, const char *bytes, short len)
{
    MoveTo(x, y);
    DrawText((Ptr)bytes, 0, len);
}

static void DrawBullet(short x, short y, unsigned char size)
{
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

    Rect erase = cr;
    EraseRect(&erase);

    short scrollY = gScrollBar ? GetControlValue(gScrollBar) : 0;

    RgnHandle clip = NewRgn();
    GetClip(clip);
    ClipRect(&cr);

    for (int i = 0; i < gLayout.op_count; i++) {
        const DrawOp *op = &gLayout.ops[i];
        short x = (short)(cr.left + op->x);
        short y = (short)(cr.top  + op->y - scrollY);
        if (y < cr.top - 32 || y > cr.bottom + 32) continue;

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
                break;  /* visual only: text already shown underlined */
        }
    }

    SetClip(clip);
    DisposeRgn(clip);
    TextFont(applFont);
    TextSize(12);
    TextFace(0);

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
    md_layout_build(gMdBuf, (size_t)gMdLen, &gLayout, width, 12);
    if (gScrollBar) {
        SetControlValue(gScrollBar, 0);
        ConfigureScrollBar();
    }
}

static void SetWindowTitleFromDoc(void)
{
    Str255 title;
    title[0] = 0;
    PStrCat(title, "\pMarkdown — ");
    PStrCat(title, gCurrentDoc);
    SetWTitle(gWindow, title);
}

/* Load fallback text from the STR# resource. */
static void LoadFallback(void)
{
    Str255 msg;
    GetIndString(msg, kStrListID, kStrFallbackText);
    long len = msg[0];
    if (len > kMdBufferBytes) len = kMdBufferBytes;
    BlockMoveData(msg + 1, gMdBuf, len);
    gMdLen = len;
}

static void LoadDocument(ConstStr255Param docName)
{
    Str255 fullPath;
    BuildSharedPath(fullPath, docName);
    long n = ReadMdFile(fullPath);
    if (n < 0) {
        LoadFallback();
    } else {
        gMdLen = n;
    }
    PStrCopy(gCurrentDoc, docName);
    SetWindowTitleFromDoc();
    RebuildLayout();
    InvalidateContent();
}

static void LoadDefaultDocument(void)
{
    Str63 startDoc;
    GetIndString(startDoc, kStrListID, kStrDefaultDoc);
    if (startDoc[0] == 0) {
        startDoc[0] = 9;
        BlockMoveData("README.md", startDoc + 1, 9);
    }
    LoadDocument(startDoc);
}

/* ------------------------------------------------------ Mouse handling */

static void HandleContentClick(Point local)
{
    if (gScrollBar) {
        ControlHandle which = NULL;
        short part = FindControl(local, gWindow, &which);
        if (part != 0 && which == gScrollBar) {
            (void)TrackControl(which, local, NULL);
            InvalidateContent();
        }
    }
}

/* ------------------------------------------------------ Menu glue */

static void ShowAbout(void)
{
    (void)Alert(kAlertAbout, NULL);
}

/* Open dialog: TEXT files (our .md files are tagged TEXT/CVMV). */
static void DoOpen(void)
{
    SFTypeList     types;
    StandardFileReply reply;
    types[0] = 'TEXT';
    StandardGetFile(NULL, 1, types, &reply);
    if (!reply.sfGood) return;
    LoadDocument(reply.sfFile.name);
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
            case kFileOpen:  DoOpen();      break;
            case kFileClose: gQuit = true;  break;
            case kFileQuit:  gQuit = true;  break;
        }
    } else if (menuID == kMenuEdit) {
        (void)SystemEdit(menuItem - 1);
    }
    HiliteMenu(0);
}

/* ------------------------------------------------------ AppleEvents */

#ifndef keyMissedKeywordAttr
#define keyMissedKeywordAttr 'miss'
#endif

static OSErr MissedAnyParameters(const AppleEvent *evt)
{
    DescType returnedType;
    Size     actualSize;
    OSErr    err = AEGetAttributePtr((AppleEvent *)evt, keyMissedKeywordAttr,
                                     typeWildCard, &returnedType,
                                     NULL, 0, &actualSize);
    if (err == errAEDescNotFound) return noErr;
    if (err == noErr) return errAEEventNotHandled;
    return err;
}

static pascal OSErr HandleOpenApp(const AppleEvent *evt, AppleEvent *reply,
                                   long refcon)
{
    (void)reply; (void)refcon;
    OSErr err = MissedAnyParameters(evt);
    if (err != noErr) return err;
    LoadDefaultDocument();
    return noErr;
}

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

    FSSpec   spec;
    AEKeyword keyword;
    DescType  actualType;
    Size      actualSize;
    err = AEGetNthPtr(&docList, 1, typeFSS, &keyword, &actualType,
                      &spec, sizeof(spec), &actualSize);
    AEDisposeDesc(&docList);
    if (err != noErr) return err;

    err = MissedAnyParameters(evt);
    if (err != noErr) return err;

    LoadDocument(spec.name);
    return noErr;
}

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
    AEEventHandlerUPP openAppUPP  = NewAEEventHandlerUPP(HandleOpenApp);
    AEEventHandlerUPP openDocsUPP = NewAEEventHandlerUPP(HandleOpenDocs);
    AEEventHandlerUPP quitAppUPP  = NewAEEventHandlerUPP(HandleQuitApp);

    (void)AEInstallEventHandler(kCoreEventClass, kAEOpenApplication,
                                openAppUPP,  0L, false);
    (void)AEInstallEventHandler(kCoreEventClass, kAEOpenDocuments,
                                openDocsUPP, 0L, false);
    (void)AEInstallEventHandler(kCoreEventClass, kAEQuitApplication,
                                quitAppUPP,  0L, false);
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
    if (gScrollBar) {
        short v    = GetControlValue(gScrollBar);
        short maxV = GetControlMaximum(gScrollBar);
        Rect cr;
        GetContentRect(&cr);
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
        if (v < 0)    v = 0;
        if (v > maxV) v = maxV;
        SetControlValue(gScrollBar, v);
        InvalidateContent();
    }
}

/* ------------------------------------------------------ main */

int main(void)
{
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

    InstallAppleEventHandlers();

    gWindow = GetNewWindow(kWindResID, NULL, (WindowPtr)-1L);
    if (!gWindow) { SysBeep(20); return 1; }
    SetPort(gWindow);
    TextFont(applFont);
    TextSize(12);

    Rect sbRect = { 0, 0, 100, kScrollBarWidth };
    gScrollBar = NewControl(gWindow, &sbRect, "\p", false, 0, 0, 0,
                            scrollBarProc, 0L);
    ConfigureScrollBar();

    /* Seed title before the first AppleEvent arrives. */
    Str63 placeholder;
    GetIndString(placeholder, kStrListID, kStrEmptyTitle);
    if (placeholder[0] == 0) {
        placeholder[0] = 13;
        BlockMoveData("(no document)", placeholder + 1, 13);
    }
    PStrCopy(gCurrentDoc, placeholder);

    /* Drain launch AppleEvent (oapp or odoc) before falling back. */
    {
        EventRecord e;
        if (WaitNextEvent(highLevelEventMask, &e, 1L, NULL)) {
            if (e.what == kHighLevelEvent)
                (void)AEProcessAppleEvent(&e);
        }
    }
    if (PStrEqual(gCurrentDoc, placeholder)) {
        LoadDefaultDocument();
    }

    while (!gQuit) {
        EventRecord e;
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown:   DoMouseDown(&e);                break;
                case keyDown:     DoKeyDown(&e);                  break;
                case autoKey:     DoKeyDown(&e);                  break;
                case updateEvt:   DoUpdate((WindowPtr)e.message); break;
                case activateEvt: break;
                case kHighLevelEvent:
                    (void)AEProcessAppleEvent(&e);
                    break;
            }
        }
    }

    return 0;
}
