/*
 * html_parse.h — pure-C HTML tokenizer and layout for the Reader app.
 *
 * No Mac Toolbox calls live in this module. It is compiled by both Retro68
 * (linked into the Reader Toolbox shell) and the host C compiler (driven by
 * tests/unit/test_html_parse.c). Anything that touches QuickDraw, Resources,
 * or Files belongs in reader.c.
 *
 * Pipeline:
 *   raw HTML bytes  --html_tokenize-->  HtmlTokenList
 *   HtmlTokenList   --html_layout-->    HtmlLayout (a flat list of DrawOps)
 *
 * The Toolbox shell consumes the DrawOps in order, mapping them to TextFont/
 * TextSize/TextFace/MoveTo/DrawText/DrawString calls. Layout knows the
 * content width so word-wrap is computed here; the shell is dumb.
 *
 * Supported subset (intentionally tiny):
 *   <p> <br> <h1> <h2> <h3>
 *   <strong> <b>      bold
 *   <em>     <i>      italic
 *   <ul> <li>         bulleted lists, simple nesting OK
 *   <pre>             monospace block (no internal tag parsing)
 *   <a href="...">    link with click region
 *
 * Out of scope: images, tables, CSS, forms, JavaScript, character entities
 * beyond &amp; &lt; &gt; &quot; &nbsp;. Unknown tags are dropped silently
 * (their text content still renders).
 */

#ifndef HTML_PARSE_H
#define HTML_PARSE_H

#include <stddef.h>

/* ------------------------------------------------------------ Tokens */

typedef enum {
    HTML_TOK_TEXT = 0,         /* a run of body text */
    HTML_TOK_TAG_OPEN,         /* <foo> or <foo attr="..."> */
    HTML_TOK_TAG_CLOSE,        /* </foo> */
    HTML_TOK_TAG_SELF          /* <br> or <br/> — HTML void elements */
} HtmlTokenKind;

/* Tag identifiers. Keep small + sorted by appearance frequency. The
 * tokenizer maps the tag name string to one of these; unknown names map
 * to HTML_TAG_UNKNOWN (which the layout pass ignores entirely). */
typedef enum {
    HTML_TAG_UNKNOWN = 0,
    HTML_TAG_P,
    HTML_TAG_BR,
    HTML_TAG_H1,
    HTML_TAG_H2,
    HTML_TAG_H3,
    HTML_TAG_B,
    HTML_TAG_STRONG,
    HTML_TAG_I,
    HTML_TAG_EM,
    HTML_TAG_UL,
    HTML_TAG_LI,
    HTML_TAG_PRE,
    HTML_TAG_A,
    HTML_TAG_HTML,
    HTML_TAG_HEAD,
    HTML_TAG_BODY,
    HTML_TAG_TITLE
} HtmlTagId;

/* One token. For TEXT, (text, text_len) point into a caller-owned buffer
 * (the layout pass copies what it needs into the layout's string pool).
 * For TAG_*, tag is the identifier; href is set only on <a href="...">.
 *
 * Strings inside tokens are NOT null-terminated — always use the explicit
 * length. */
typedef struct {
    HtmlTokenKind kind;
    HtmlTagId     tag;
    const char   *text;
    size_t        text_len;
    const char   *href;        /* opening <a> only; NULL otherwise */
    size_t        href_len;
} HtmlToken;

#define HTML_MAX_TOKENS 512

typedef struct {
    HtmlToken tokens[HTML_MAX_TOKENS];
    int       count;
    int       overflowed;      /* set if >= HTML_MAX_TOKENS were seen */
} HtmlTokenList;

/* Tokenize html (length src_len; null terminator not required). Pointers in
 * the resulting tokens reference the input buffer — keep `src` alive while
 * you use the token list. Returns 0 on success. */
int html_tokenize(const char *src, size_t src_len, HtmlTokenList *out);

/* ------------------------------------------------------------ Layout */

/* Each DrawOp is one instruction the QuickDraw side executes left-to-right.
 * Geometry is in pixels relative to the document's content box (0,0 = top
 * left of the viewport). The shell offsets by the scroll position. */

typedef enum {
    DRAW_OP_TEXT = 0,          /* draw `text` at (x, y) baseline */
    DRAW_OP_LINK_REGION,       /* records an a-href click target */
    DRAW_OP_BULLET             /* draw a bullet glyph at (x, y) */
} DrawOpKind;

/* Face flags match Toolbox `Style` bits (bold=1, italic=2, underline=4)
 * so the shell can pass them straight to TextFace. Underline is set on
 * link runs. */
#define DRAW_FACE_BOLD       0x01
#define DRAW_FACE_ITALIC     0x02
#define DRAW_FACE_UNDERLINE  0x04

/* Font family. The shell maps family→TextFont(applFont|monaco|geneva). */
typedef enum {
    DRAW_FAMILY_BODY = 0,      /* default proportional (applFont/Geneva) */
    DRAW_FAMILY_MONO           /* monaco / monospace for <pre> */
} DrawFamily;

#define HTML_LAYOUT_STRPOOL_BYTES   8192
#define HTML_LAYOUT_MAX_OPS         1024

typedef struct {
    DrawOpKind kind;
    short      x;
    short      y;              /* baseline y for text, top y for bullet */
    short      width;          /* pixel width occupied (text/link only) */
    short      height;         /* line height (text only) */
    unsigned char face;        /* DRAW_FACE_* bits */
    unsigned char family;      /* DrawFamily */
    unsigned char font_size;   /* points */
    /* (text_off, text_len) point into HtmlLayout.strpool for TEXT and the
     * link-target string for LINK_REGION. */
    unsigned short text_off;
    unsigned short text_len;
    /* For LINK_REGION only: bounding box of the clickable text. */
    short      link_left;
    short      link_top;
    short      link_right;
    short      link_bottom;
    /* For LINK_REGION only: offset/length of the href in strpool. */
    unsigned short href_off;
    unsigned short href_len;
} DrawOp;

typedef struct {
    DrawOp ops[HTML_LAYOUT_MAX_OPS];
    int    op_count;
    int    overflowed;

    /* Heap of strings the ops point into. NUL-separated; offsets are
     * stable for the lifetime of the layout. */
    char     strpool[HTML_LAYOUT_STRPOOL_BYTES];
    unsigned short strpool_used;

    /* Total height of the laid-out content (for scroll-bar sizing). */
    short    content_height;
    /* Width the layout was computed for. */
    short    content_width;
} HtmlLayout;

/* Lay out a token list into draw ops, fitting into content_width pixels.
 * font_size_body is the body text size in points (12 for Geneva 12).
 * Returns 0 on success. The layout is fully self-contained — the input
 * token list and source HTML can be freed afterwards. */
int html_layout_build(const HtmlTokenList *tokens,
                      HtmlLayout *out,
                      short content_width,
                      unsigned char font_size_body);

/* ------------------------------------------------------------ Helpers */

/* Map a tag name (case-insensitive) to a tag id. Exposed for tests. */
HtmlTagId html_tag_id(const char *name, size_t len);

/* Hit-test: returns the index of the first LINK_REGION op whose link
 * bounding box contains (x, y), or -1 if none. The Toolbox shell calls
 * this on mouseDown in the content area. */
int html_layout_hit_link(const HtmlLayout *layout, short x, short y);

#endif /* HTML_PARSE_H */
