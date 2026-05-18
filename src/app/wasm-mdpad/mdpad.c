/*
 * mdpad.c — split-pane Markdown editor with live preview.
 *
 * The vibe-coding angle: Markdown didn't exist when System 7 shipped
 * (Gruber coined it in 2004), but the format is universal today. So this
 * is a textbook "modern concept, classic chrome" sample — a CodeMirror /
 * Bear / iA Writer style two-pane editor, drawn in 1995-era Geneva and
 * Chicago against grey window backgrounds.
 *
 * Window layout: vertical split, ~50/50.
 *   +------------------+------------------+
 *   |  source pane     |  preview pane    |
 *   |  (TextEdit, you  |  (custom-drawn,  |
 *   |  type Markdown)  |  re-rendered on  |
 *   |                  |  every keystroke)|
 *   +------------------+------------------+
 *
 * Markdown subset rendered:
 *   - `# H1`, `## H2`, `### H3`     headings (Chicago, sized)
 *   - `**bold**`, `*italic*`        inline styles (mid-line, stacking)
 *   - `` `code` ``                  inline monospace (Monaco)
 *   - ```` ``` ```` … ```` ``` ```` code block (Monaco indented)
 *   - `- foo` / `* foo`             bullet list
 *   - `1. foo`                      numbered list (just numbered)
 *   - blank line                    paragraph break
 *
 * Intentionally NOT supported (kept the parser small):
 *   - tables, blockquotes, images, links (rendered as raw text)
 *   - reference-style links, footnotes, HTML passthrough
 *
 * Live preview frequency: on each keyDown we invalidate the preview rect;
 * the next updateEvt re-parses + re-draws. This is fast enough for any
 * doc that fits on screen (the parser is single-pass, allocation-free).
 *
 * Resource shape — see mdpad.r:
 *   MBAR 128 + MENU 128–130 (Apple, File, Edit) + WIND 128 + ALRT 128 +
 *   DITL 128 + SIZE -1 (1 MB) + 'CVMD' signature.
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
#include <Files.h>
#include <StandardFile.h>
#include <Errors.h>

/* Debug Console — log open / save events with file size + name. Open
 * the Output panel → Console tab to see file I/O activity from this
 * editor scroll past as you Cmd-O / Cmd-S inside the running Mac. */
#include <cvm_log.h>

#ifndef FALSE
# define FALSE 0
#endif
#ifndef TRUE
# define TRUE 1
#endif

#define kWindowID  128
#define kAlertID   128

#define kMenuApple  128
#define kMenuFile   129
#define kMenuEdit   130

#define kAppleAbout 1
/* File menu items — must stay in lockstep with mdpad.r's MENU 129. */
#define kFileNew     1
#define kFileOpen    2
/* item 3 is the separator */
#define kFileSave    4
#define kFileSaveAs  5
/* item 6 is the separator */
#define kFileQuit    7
#define kEditCut    3
#define kEditCopy   4
#define kEditPaste  5
#define kEditClear  6

/* TextEdit's documented per-record cap. Files larger than this are
 * truncated on Open with a status note appended into the buffer. */
#define kMaxFileBytes  32000L

/* File metadata for files we save.
 *   'TEXT'  — universally readable as a text file
 *   'CVMD'  — our app's signature, so the Finder reopens .md in this
 *             app on double-click (BNDL ties it together in mdpad.r) */
#define kFileType      'TEXT'
#define kFileCreator   'CVMD'

/* Pane gutter between source/preview, in pixels. Wide enough to read
 * as a visual divider, narrow enough not to waste pixels. */
#define kGutter     8

/* Body text font + size for the preview pane. Geneva 12 is the System 7
 * proportional default — readers will pattern-match it as "Mac text". */
#define kBodyFont   3      /* Geneva */
#define kBodySize   12
#define kBodyLead   16     /* leading (line-height) for body */

/* Code font: Monaco is the canonical Mac monospace. */
#define kCodeFont   4      /* Monaco */
#define kCodeSize   10
#define kCodeLead   14

/* Headings: Chicago (system font, id 0) at three sizes. */
#define kHeadFont   0

QDGlobals qd;

static TEHandle  gTE        = NULL;
static WindowPtr gWin       = NULL;
static Boolean   gDone      = FALSE;

/* Cached pane rects, recomputed on resize/update. */
static Rect      gSourceRect;
static Rect      gPreviewRect;

/* "Current file" — set after a successful Open or Save As. Plain
 * Save (Cmd-S) writes back to this FSSpec without re-prompting;
 * Save As always prompts. */
static FSSpec    gFile;
static Boolean   gHasFile = FALSE;

/* Starter doc — Pascal-string layout: first byte is the length-1 of
 * the rest. Keeps the buffer flat and avoids strlen at runtime. */
static const unsigned char STARTER[] = {
    243,
    '#',' ','M','a','r','k','d','o','w','n',' ','i','n',' ','S','y',
    's','t','e','m',' ','7',13,
    13,
    'M','a','r','k','d','o','w','n',' ','d','i','d','n',39,'t',' ',
    'e','x','i','s','t',' ','w','h','e','n',' ','t','h','i','s',' ',
    'O','S',' ','s','h','i','p','p','e','d','.',13,
    13,
    '#','#',' ','I','n','l','i','n','e',13,
    13,
    'Y','o','u',' ','c','a','n',' ','t','y','p','e',' ','*','*','b',
    'o','l','d','*','*',' ','o','r',' ','*','i','t','a','l','i','c',
    '*',' ','o','r',' ','`','c','o','d','e','`','.',13,
    13,
    '#','#',' ','L','i','s','t',13,
    13,
    '-',' ','o','n','e',13,
    '-',' ','t','w','o',13,
    '-',' ','t','h','r','e','e',13,
    13,
    '#','#',' ','C','o','d','e',13,
    13,
    '`','`','`',13,
    'i','n','t',' ','m','a','i','n','(',')',' ','{',' ','r','e','t',
    'u','r','n',' ','0',';',' ','}',13,
    '`','`','`',13,
    13,
    'E','d','i','t',' ','t','h','e',' ','l','e','f','t',' ','p','a',
    'n','e',';',' ','t','h','e',' ','r','i','g','h','t',' ','u','p',
    'd','a','t','e','s',' ','a','s',' ','y','o','u',' ','t','y','p','e','.'
};

/* ──────────────────────────────────────────────────────────────────
 * Pane geometry
 *
 * Single window, vertically split: source on the left, preview on the
 * right. Gutter between them. ComputePanes is the single source of
 * truth — every place that needs either rect calls this so they stay
 * in lockstep after any resize/move/layout change.
 * ────────────────────────────────────────────────────────────────── */
static void ComputePanes(void) {
    Rect content = gWin->portRect;
    short mid = (content.left + content.right) / 2;
    gSourceRect.top    = content.top + kGutter;
    gSourceRect.left   = content.left + kGutter;
    gSourceRect.bottom = content.bottom - kGutter;
    gSourceRect.right  = mid - kGutter / 2;
    gPreviewRect.top    = content.top + kGutter;
    gPreviewRect.left   = mid + kGutter / 2;
    gPreviewRect.bottom = content.bottom - kGutter;
    gPreviewRect.right  = content.right - kGutter;
}

/* ──────────────────────────────────────────────────────────────────
 * Markdown renderer
 *
 * Walks the source buffer line-by-line and draws into the preview
 * rect. Allocation-free: state lives in locals + the few static
 * cursor variables below. The parser is *intentionally* small —
 * common Markdown is built up from a tiny set of line-prefix patterns
 * plus inline `*…*`, `**…**`, and `` `…` `` runs. We handle exactly
 * those, render anything else as plain text, and leave more elaborate
 * Markdown (tables, links, images, blockquotes) as "raw passthrough"
 * so the source stays readable in the preview even if not styled.
 * ────────────────────────────────────────────────────────────────── */

/* Render cursor — pen y-position, gets advanced as we draw. */
static short gPenY;

/* Set the pen font + size + face for what's about to be drawn. */
static void SetPenStyle(short font, short size, short face) {
    TextFont(font);
    TextSize(size);
    TextFace(face);
}

/* Advance the y cursor by `lead` pixels (= one line). If we ran off
 * the bottom of the preview rect, callers should bail (we check at
 * the top of DrawLine and friends, so a no-op here is fine). */
static void AdvanceLine(short lead) {
    gPenY += lead;
}

/* Draw `len` bytes from `s` at the current pen position, advancing
 * the pen horizontally by the string's measured width. Used by the
 * inline-style walker below to lay out runs of varying style on a
 * single visual line. */
static void DrawRun(short xStart, const char *s, short len, short face) {
    if (len <= 0) return;
    TextFace(face);
    MoveTo(xStart, gPenY);
    DrawText(s, 0, len);
}

/* Measure a run's pixel width with the current font/size/face. Lets
 * the inline walker advance x correctly across style boundaries. */
static short MeasureRun(const char *s, short len, short face) {
    if (len <= 0) return 0;
    TextFace(face);
    return TextWidth(s, 0, len);
}

/* Draw one logical line of inline-styled text starting at (xStart, gPenY).
 *
 * Scans for `**bold**`, `*italic*`, and `` `code` `` markers and lays out
 * the runs in the matching style. The face mask is monotonic — bold
 * inside italic gives bold+italic — and unclosed markers are rendered
 * as literal asterisks (matches what most casual writers expect).
 *
 * The pen font/size are assumed to already be set by the caller; this
 * function only touches face + inline font (Monaco for `…`). */
static void DrawInline(short xStart, short bodyFont, short bodySize,
                       const char *s, short len) {
    short x = xStart;
    short i = 0;
    short face = 0;          /* current accumulated face mask */
    short runStart = 0;

    while (i < len) {
        char c = s[i];

        /* Inline code: `…` — switch to Monaco for the span. */
        if (c == '`') {
            /* Flush pending plain run. */
            short rl = i - runStart;
            if (rl > 0) {
                TextFont(bodyFont); TextSize(bodySize);
                DrawRun(x, &s[runStart], rl, face);
                x += MeasureRun(&s[runStart], rl, face);
            }
            /* Find closing backtick. */
            short j = i + 1;
            while (j < len && s[j] != '`') j++;
            if (j < len) {
                /* Found pair — draw inner span in Monaco. */
                short clen = j - i - 1;
                if (clen > 0) {
                    TextFont(kCodeFont); TextSize(kCodeSize);
                    DrawRun(x, &s[i + 1], clen, 0);
                    x += MeasureRun(&s[i + 1], clen, 0);
                }
                TextFont(bodyFont); TextSize(bodySize);
                i = j + 1;
                runStart = i;
                continue;
            }
            /* Unclosed backtick — treat as literal, fall through. */
        }

        /* Inline bold: **…** — exactly two asterisks. */
        if (c == '*' && i + 1 < len && s[i + 1] == '*') {
            short rl = i - runStart;
            if (rl > 0) {
                TextFont(bodyFont); TextSize(bodySize);
                DrawRun(x, &s[runStart], rl, face);
                x += MeasureRun(&s[runStart], rl, face);
            }
            /* Find closing `**`. */
            short j = i + 2;
            while (j + 1 < len && !(s[j] == '*' && s[j + 1] == '*')) j++;
            if (j + 1 < len) {
                short clen = j - i - 2;
                if (clen > 0) {
                    DrawRun(x, &s[i + 2], clen, face | bold);
                    x += MeasureRun(&s[i + 2], clen, face | bold);
                }
                i = j + 2;
                runStart = i;
                continue;
            }
            /* Unclosed — literal. Fall through. */
        }

        /* Inline italic: *…* — exactly one asterisk (and the next char
         * isn't another `*`, which would be the bold case above). */
        if (c == '*' && (i + 1 >= len || s[i + 1] != '*')) {
            short rl = i - runStart;
            if (rl > 0) {
                TextFont(bodyFont); TextSize(bodySize);
                DrawRun(x, &s[runStart], rl, face);
                x += MeasureRun(&s[runStart], rl, face);
            }
            short j = i + 1;
            while (j < len && s[j] != '*') j++;
            if (j < len) {
                short clen = j - i - 1;
                if (clen > 0) {
                    DrawRun(x, &s[i + 1], clen, face | italic);
                    x += MeasureRun(&s[i + 1], clen, face | italic);
                }
                i = j + 1;
                runStart = i;
                continue;
            }
            /* Unclosed — literal. Fall through. */
        }

        i++;
    }
    /* Flush tail. */
    short rl = i - runStart;
    if (rl > 0) {
        TextFont(bodyFont); TextSize(bodySize);
        DrawRun(x, &s[runStart], rl, face);
    }
}

/* Classify and render the line `[s..s+len)` at the current gPenY. */
static void RenderLine(const char *s, short len) {
    if (gPenY > gPreviewRect.bottom) return;     /* off-screen — stop drawing */

    /* Heading: ### / ## / # at line start, followed by space. Three
     * concrete sizes that read as a clear hierarchy in System 7's
     * Chicago. */
    if (len >= 2 && s[0] == '#') {
        short hashes = 0;
        while (hashes < 3 && hashes < len && s[hashes] == '#') hashes++;
        if (hashes >= 1 && hashes <= 3 && hashes < len && s[hashes] == ' ') {
            short size = (hashes == 1) ? 18 : (hashes == 2) ? 14 : 12;
            short lead = size + 4;
            gPenY += lead - kBodyLead;           /* extra top breathing room */
            SetPenStyle(kHeadFont, size, bold);
            MoveTo(gPreviewRect.left, gPenY);
            DrawText(&s[hashes + 1], 0, len - hashes - 1);
            AdvanceLine(lead + 2);
            return;
        }
    }

    /* Bullet list: `-` or `*` followed by space. Draw a bullet, indent
     * the rest. The bullet glyph is option-8 on a real Mac (• = 0xA5
     * MacRoman); we use a plain '*' for portability so users on any
     * keymap see something sensible. */
    if (len >= 2 && (s[0] == '-' || s[0] == '*') && s[1] == ' ') {
        SetPenStyle(kBodyFont, kBodySize, 0);
        MoveTo(gPreviewRect.left + 8, gPenY);
        DrawChar(0xA5);                          /* • */
        DrawInline(gPreviewRect.left + 24, kBodyFont, kBodySize,
                   &s[2], len - 2);
        AdvanceLine(kBodyLead);
        return;
    }

    /* Numbered list: ASCII digit followed by `. `. Render with the
     * source number preserved (we don't renumber — closer to the
     * Markdown spec's "loose" behavior). */
    if (len >= 3 && s[0] >= '0' && s[0] <= '9') {
        short j = 0;
        while (j < len && s[j] >= '0' && s[j] <= '9') j++;
        if (j > 0 && j + 1 < len && s[j] == '.' && s[j + 1] == ' ') {
            SetPenStyle(kBodyFont, kBodySize, 0);
            MoveTo(gPreviewRect.left + 8, gPenY);
            DrawText(s, 0, j + 1);
            DrawInline(gPreviewRect.left + 30, kBodyFont, kBodySize,
                       &s[j + 2], len - j - 2);
            AdvanceLine(kBodyLead);
            return;
        }
    }

    /* Empty line → paragraph break (just half a line of vertical
     * whitespace; the next line's natural lead handles the rest). */
    if (len == 0) {
        AdvanceLine(kBodyLead / 2);
        return;
    }

    /* Default: body paragraph with inline style scan. */
    SetPenStyle(kBodyFont, kBodySize, 0);
    DrawInline(gPreviewRect.left, kBodyFont, kBodySize, s, len);
    AdvanceLine(kBodyLead);
}

/* Walk the source buffer and emit drawing ops into the preview rect.
 * Handles fenced code blocks (```…```) inline since they cross line
 * boundaries — switch to Monaco for everything between the fences,
 * then back to default classification. */
static void RenderMarkdown(void) {
    /* Erase preview pane to white before redrawing. */
    EraseRect(&gPreviewRect);

    if (!gTE) return;
    CharsHandle h = TEGetText(gTE);
    if (!h) return;
    long total = (**gTE).teLength;
    if (total <= 0) return;
    const char *src = *h;

    gPenY = gPreviewRect.top + kBodyLead;
    Boolean inCode = FALSE;
    long i = 0;
    while (i < total && gPenY <= gPreviewRect.bottom) {
        /* Find end of current line — CR (Mac convention) or LF. */
        long j = i;
        while (j < total && src[j] != 13 && src[j] != 10) j++;
        short lineLen = (short)(j - i);
        const char *line = &src[i];

        /* Code-fence toggle: a line that's exactly ``` (or starts with). */
        if (lineLen >= 3 && line[0] == '`' && line[1] == '`' && line[2] == '`') {
            inCode = !inCode;
            /* Fence line itself draws nothing — just the toggle. */
        } else if (inCode) {
            SetPenStyle(kCodeFont, kCodeSize, 0);
            MoveTo(gPreviewRect.left + 8, gPenY);
            if (lineLen > 0) DrawText(line, 0, lineLen);
            AdvanceLine(kCodeLead);
        } else {
            RenderLine(line, lineLen);
        }

        i = j + 1;          /* skip past the line terminator */
    }
}

/* ──────────────────────────────────────────────────────────────────
 * File I/O — Open / Save / Save As
 *
 * Mac classic stores text with CR (0x0D) line endings; modern .md
 * consumers expect LF (0x0A). We translate at the boundary:
 *   - Open  : LF → CR, CRLF → CR (the latter for files written on
 *             Windows-friendly editors). TextEdit sees only CR.
 *   - Save  : CR → LF, so the .md file dropped on the host filesystem
 *             reads naturally in VS Code / any modern Markdown tool.
 *
 * File type/creator pair is TEXT/CVMD — the universal "this is a text
 * file" type plus our own creator so double-clicking a saved .md in
 * the Finder relaunches us. (Drop creator to 'ttxt' if you want
 * SimpleText to take over instead.)
 * ────────────────────────────────────────────────────────────────── */

/* Append a one-line status note to the editor buffer. Used to surface
 * I/O failures without popping a modal dialog — the user can read the
 * message in-place and delete it. */
static void TEAppendNote(const char *s) {
    if (!gTE) return;
    long n = 0;
    while (s[n]) n++;
    long end = (**gTE).teLength;
    TESetSelect(end, end, gTE);
    /* Leading CR so the note lands on its own line. */
    TEKey(13, gTE);
    TEInsert((Ptr)s, n, gTE);
    InvalRect(&gPreviewRect);
}

/* Read the FSSpec's data fork into TextEdit, converting LF → CR. */
static void LoadFromFile(const FSSpec *spec) {
    short refNum;
    OSErr err = FSpOpenDF(spec, fsRdPerm, &refNum);
    if (err != noErr) { TEAppendNote("[open failed]"); return; }

    long len;
    err = GetEOF(refNum, &len);
    if (err != noErr) { FSClose(refNum); TEAppendNote("[stat failed]"); return; }
    if (len == 0) {
        TESetText("", 0, gTE);
        FSClose(refNum);
        gFile = *spec;
        gHasFile = TRUE;
        InvalRect(&gPreviewRect);
        return;
    }

    Boolean truncated = FALSE;
    long readLen = len;
    if (readLen > kMaxFileBytes) { readLen = kMaxFileBytes; truncated = TRUE; }

    Ptr raw = NewPtr(readLen);
    if (!raw) { FSClose(refNum); TEAppendNote("[NewPtr failed]"); return; }
    err = FSRead(refNum, &readLen, raw);
    FSClose(refNum);
    if (err != noErr && err != eofErr) {
        DisposePtr(raw);
        TEAppendNote("[read failed]");
        return;
    }

    /* Convert line endings into the buffer we hand to TextEdit. Output
     * is at most the same length as input (CRLF→CR shrinks by one per
     * pair; everything else is 1:1). */
    Ptr out = NewPtr(readLen);
    if (!out) { DisposePtr(raw); TEAppendNote("[NewPtr failed]"); return; }
    long outLen = 0;
    for (long i = 0; i < readLen; i++) {
        unsigned char c = (unsigned char)raw[i];
        if (c == 13) {                              /* CR (lone or in CRLF) */
            out[outLen++] = 13;
            if (i + 1 < readLen && (unsigned char)raw[i + 1] == 10) i++;
        } else if (c == 10) {                       /* LF → CR */
            out[outLen++] = 13;
        } else {
            out[outLen++] = (char)c;
        }
    }
    DisposePtr(raw);

    TESetText(out, outLen, gTE);
    DisposePtr(out);
    TESetSelect(0, 0, gTE);

    gFile = *spec;
    gHasFile = TRUE;
    InvalRect(&gPreviewRect);
    if (truncated) TEAppendNote("[file truncated at 32K — TextEdit limit]");
    /* Log to the Debug Console: "open: <pascal-name> <len>B". */
    {
        Str255 line; line[0] = 0;
        const char *p = "open: ";
        while (*p && line[0] < 254) line[++line[0]] = *p++;
        for (short i = 1; i <= spec->name[0] && line[0] < 252; i++)
            line[++line[0]] = spec->name[i];
        if (line[0] < 252) { line[++line[0]] = ' '; }
        unsigned char tmp[16];
        NumToString(readLen, tmp);
        for (short i = 1; i <= tmp[0] && line[0] < 253; i++) line[++line[0]] = tmp[i];
        if (line[0] < 254) line[++line[0]] = 'B';
        cvm_log_p(line);
    }
}

/* Write TextEdit's buffer into the FSSpec, converting CR → LF. */
static void WriteToFile(const FSSpec *spec) {
    /* Best-effort create. dupFNErr is fine (we'll just overwrite). */
    OSErr err = FSpCreate(spec, kFileCreator, kFileType, smRoman);
    if (err != noErr && err != dupFNErr) {
        TEAppendNote("[create failed]");
        return;
    }

    short refNum;
    err = FSpOpenDF(spec, fsWrPerm, &refNum);
    if (err != noErr) { TEAppendNote("[open-for-write failed]"); return; }

    long len = (**gTE).teLength;
    CharsHandle text = TEGetText(gTE);
    HLock((Handle)text);
    /* CR → LF copy. Output is exactly `len` bytes (1:1 substitution). */
    Ptr out = NewPtr(len);
    if (!out) { HUnlock((Handle)text); FSClose(refNum); TEAppendNote("[NewPtr failed]"); return; }
    const char *src = *text;
    for (long i = 0; i < len; i++) {
        unsigned char c = (unsigned char)src[i];
        out[i] = (c == 13) ? 10 : (char)c;
    }
    HUnlock((Handle)text);

    err = FSWrite(refNum, &len, out);
    DisposePtr(out);
    SetEOF(refNum, len);                            /* shrink if the prior file was longer */
    FSClose(refNum);

    if (err != noErr) { TEAppendNote("[write failed]"); return; }

    gFile = *spec;
    gHasFile = TRUE;
    /* Log to the Debug Console: "save: <pascal-name> <len>B". */
    {
        Str255 line; line[0] = 0;
        const char *p = "save: ";
        while (*p && line[0] < 254) line[++line[0]] = *p++;
        for (short i = 1; i <= spec->name[0] && line[0] < 252; i++)
            line[++line[0]] = spec->name[i];
        if (line[0] < 252) { line[++line[0]] = ' '; }
        unsigned char tmp[16];
        NumToString(len, tmp);
        for (short i = 1; i <= tmp[0] && line[0] < 253; i++) line[++line[0]] = tmp[i];
        if (line[0] < 254) line[++line[0]] = 'B';
        cvm_log_p(line);
    }
}

static void DoFileOpen(void) {
    StandardFileReply reply;
    SFTypeList types;
    types[0] = 'TEXT';
    StandardGetFile(NULL, 1, types, &reply);
    if (!reply.sfGood) return;
    LoadFromFile(&reply.sfFile);
}

/* Save As: always prompts. Default filename suggests .md so the file
 * picks up Markdown highlighting / preview on the host filesystem
 * if saved to :Shared: (the host-mounted volume) or any disk a
 * modern macOS user later inspects. */
static void DoFileSaveAs(void) {
    StandardFileReply reply;
    /* Pascal strings — first byte is length. Kept ASCII-only so the
     * source compiles to identical bytes regardless of editor encoding
     * (cv-mac #297 / #291: UTF-8 ellipses round-trip badly through Rez). */
    unsigned char prompt[] = { 18,
        'S','a','v','e',' ','a','s',' ','M','a','r','k','d','o','w','n','.','.','.' };
    unsigned char dflt[]   = { 11,
        'U','n','t','i','t','l','e','d','.','m','d' };
    StandardPutFile(prompt, dflt, &reply);
    if (!reply.sfGood) return;
    if (reply.sfReplacing) FSpDelete(&reply.sfFile);
    WriteToFile(&reply.sfFile);
}

/* Save: re-uses the current FSSpec if we have one (after a previous
 * Open or Save As). Otherwise falls through to Save As. */
static void DoFileSave(void) {
    if (gHasFile) {
        /* Truncating before write because the buffer may have shrunk
         * (WriteToFile calls SetEOF, which handles this — but if the
         * file was deleted between sessions, FSpOpenDF will fail and
         * the user sees a status note). */
        WriteToFile(&gFile);
    } else {
        DoFileSaveAs();
    }
}

/* ──────────────────────────────────────────────────────────────────
 * Menu / event handlers
 * ────────────────────────────────────────────────────────────────── */
static void DoAbout(void) {
    StopAlert(kAlertID, NULL);
}

static void DoFileMenu(short item) {
    switch (item) {
        case kFileNew:
            if (gTE) {
                TESetText("", 0, gTE);
                TESetSelect(0, 0, gTE);
                gHasFile = FALSE;            /* untether from previous file */
                InvalRect(&gPreviewRect);
            }
            break;
        case kFileOpen:   DoFileOpen();   break;
        case kFileSave:   DoFileSave();   break;
        case kFileSaveAs: DoFileSaveAs(); break;
        case kFileQuit:   gDone = TRUE;   break;
    }
}

static void DoEditMenu(short item) {
    if (!gTE) return;
    switch (item) {
        case kEditCut:   TECut(gTE);    InvalRect(&gPreviewRect); break;
        case kEditCopy:  TECopy(gTE);                              break;
        case kEditPaste: TEPaste(gTE);  InvalRect(&gPreviewRect); break;
        case kEditClear: TEDelete(gTE); InvalRect(&gPreviewRect); break;
    }
}

static void DoMenu(long sel) {
    short menuID = HiWord(sel);
    short item   = LoWord(sel);
    switch (menuID) {
        case kMenuApple: if (item == kAppleAbout) DoAbout(); break;
        case kMenuFile:  DoFileMenu(item); break;
        case kMenuEdit:  DoEditMenu(item); break;
    }
    HiliteMenu(0);
}

int main(void) {
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);
    InitCursor();

    cvm_log_reset();
    cvm_log("mdpad: ready -- Cmd-O to open, Cmd-S to save");

    Handle mb = GetNewMBar(128);
    if (mb) {
        SetMenuBar(mb);
        AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
        DrawMenuBar();
    }

    gWin = GetNewWindow(kWindowID, NULL, (WindowPtr)(-1));
    if (!gWin) { SysBeep(10); return 1; }
    SetPort((GrafPtr)gWin);
    ShowWindow(gWin);

    ComputePanes();

    gTE = TENew(&gSourceRect, &gSourceRect);
    if (!gTE) { SysBeep(10); return 1; }
    /* Geneva 12 for the source so it reads like a notes-app and
     * matches the body font in the preview pane. */
    TEPtr tp = *gTE;
    tp->txFont = kBodyFont;
    tp->txSize = kBodySize;
    tp->txFace = 0;
    TESetText((Ptr)&STARTER[1], (long)STARTER[0], gTE);
    TESetSelect(0, 0, gTE);
    TECalText(gTE);
    TEActivate(gTE);
    InvalRect(&gPreviewRect);

    while (!gDone) {
        EventRecord ev;
        WaitNextEvent(everyEvent, &ev, 30, NULL);
        switch (ev.what) {
            case mouseDown: {
                WindowPtr w;
                short part = FindWindow(ev.where, &w);
                switch (part) {
                    case inMenuBar: {
                        long sel = MenuSelect(ev.where);
                        if (HiWord(sel) != 0) DoMenu(sel);
                        break;
                    }
                    case inContent:
                        if (w == gWin) {
                            Point local = ev.where;
                            GlobalToLocal(&local);
                            /* Only clicks inside the source pane go to TE;
                             * the preview pane is read-only. */
                            if (PtInRect(local, &gSourceRect)) {
                                TEClick(local, (ev.modifiers & shiftKey) != 0, gTE);
                            }
                        }
                        break;
                    case inDrag: {
                        Rect bounds = qd.screenBits.bounds;
                        bounds.top += 20;
                        DragWindow(w, ev.where, &bounds);
                        break;
                    }
                    case inGoAway:
                        if (TrackGoAway(w, ev.where)) gDone = TRUE;
                        break;
                }
                break;
            }
            case keyDown:
            case autoKey: {
                char ch = (char)(ev.message & charCodeMask);
                if (ev.modifiers & cmdKey) {
                    long sel = MenuKey(ch);
                    if (HiWord(sel) != 0) DoMenu(sel);
                } else if (gTE) {
                    TEKey(ch, gTE);
                    InvalRect(&gPreviewRect);
                }
                break;
            }
            case activateEvt:
                if ((WindowPtr)ev.message == gWin && gTE) {
                    if (ev.modifiers & activeFlag) TEActivate(gTE);
                    else TEDeactivate(gTE);
                }
                break;
            case updateEvt:
                if ((WindowPtr)ev.message == gWin) {
                    BeginUpdate(gWin);
                    ComputePanes();
                    EraseRect(&gWin->portRect);
                    /* Source pane border — drawn as a 1px frame around the
                     * TextEdit rect so users see "this side is editable". */
                    Rect frame = gSourceRect;
                    InsetRect(&frame, -2, -2);
                    FrameRect(&frame);
                    if (gTE) TEUpdate(&gSourceRect, gTE);
                    /* Preview pane: full re-render. */
                    RenderMarkdown();
                    EndUpdate(gWin);
                }
                break;
            case nullEvent:
                if (gTE) TEIdle(gTE);
                break;
        }
    }

    if (gTE) TEDispose(gTE);
    return 0;
}
