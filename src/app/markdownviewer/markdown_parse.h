/*
 * markdown_parse.h — pure-C Markdown → DrawOp layout (host-compilable, no Toolbox).
 *
 * No Mac Toolbox calls live here. Compiled by Retro68 (linked into the
 * MarkdownViewer Toolbox shell) and by the host C compiler (unit tests).
 * Anything QuickDraw/Resource/File belongs in markdownviewer.c.
 *
 * Pipeline:
 *   raw Markdown bytes  --md_layout_build-->  MdLayout (flat DrawOp list)
 *   MdLayout ops        --DrawText / etc--->  on-screen pixels (shell)
 *
 * Supported Markdown subset:
 *   # ## ###             ATX headings (H1/H2/H3)
 *   **text** __text__    bold
 *   *text*   _text_      italic
 *   `code`               inline monospace
 *   ``` ... ```          fenced code block (monospace, preformatted)
 *   - item  * item       unordered lists
 *   1. item              ordered lists (rendered as bullet items)
 *   > text               blockquote (italic, indented)
 *   ---  ***             thematic break (treated as paragraph spacing)
 *   [text](url)          links (text shown underlined; no navigation in v1)
 *   blank line           paragraph break
 *
 * Out of scope: images, HTML tags, tables, nested inline markers, task
 * lists.  Unknown constructs fall back to plain body text.
 *
 * DrawOp types and face/family constants are intentionally identical to
 * html_parse.h so the rendering code in the Toolbox shell can be a
 * near-verbatim copy of reader.c's DrawContent function.
 */

#ifndef MARKDOWN_PARSE_H
#define MARKDOWN_PARSE_H

#include <stddef.h>

/* ------------------------------------------------------------ DrawOps */

typedef enum {
    DRAW_OP_TEXT = 0,        /* draw text at (x, y) baseline */
    DRAW_OP_LINK_REGION,     /* clickable link bounding box (visual only in v1) */
    DRAW_OP_BULLET           /* bullet glyph */
} DrawOpKind;

/* Face bits match QuickDraw Style constants so the shell can pass them
 * straight to TextFace(). */
#define DRAW_FACE_BOLD       0x01
#define DRAW_FACE_ITALIC     0x02
#define DRAW_FACE_UNDERLINE  0x04

typedef enum {
    DRAW_FAMILY_BODY = 0,    /* Geneva / applFont */
    DRAW_FAMILY_MONO = 1     /* Monaco (font ID 4) */
} DrawFamily;

#define MD_LAYOUT_MAX_OPS        1024
#define MD_LAYOUT_STRPOOL_BYTES  16384

typedef struct {
    DrawOpKind     kind;
    short          x;
    short          y;          /* baseline y for text, top y for bullet */
    short          width;      /* pixel width (text/link) */
    short          height;     /* line height (text) */
    unsigned char  face;       /* DRAW_FACE_* bits */
    unsigned char  family;     /* DrawFamily */
    unsigned char  font_size;  /* points */
    unsigned short text_off;   /* offset into MdLayout.strpool */
    unsigned short text_len;
    /* LINK_REGION only: bounding rect */
    short          link_left;
    short          link_top;
    short          link_right;
    short          link_bottom;
    /* LINK_REGION only: href in strpool */
    unsigned short href_off;
    unsigned short href_len;
} DrawOp;

typedef struct {
    DrawOp         ops[MD_LAYOUT_MAX_OPS];
    int            op_count;
    int            overflowed;

    char           strpool[MD_LAYOUT_STRPOOL_BYTES];
    unsigned short strpool_used;

    short          content_height;
    short          content_width;
} MdLayout;

/* Build a MdLayout from raw Markdown bytes.
 *   src            — Markdown source (not necessarily NUL-terminated)
 *   len            — byte count
 *   out            — caller-allocated; zeroed by this function
 *   content_width  — pixel width available for text
 *   font_size_body — body text size in points (typically 12)
 * Returns 0 on success. */
int md_layout_build(const char *src, size_t len,
                    MdLayout *out,
                    short content_width,
                    unsigned char font_size_body);

#endif /* MARKDOWN_PARSE_H */
