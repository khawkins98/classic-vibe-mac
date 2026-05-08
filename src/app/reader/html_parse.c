/*
 * html_parse.c — pure-C HTML tokenizer + layout for the Reader app.
 *
 * Standard C99 only. Nothing in here may include MacTypes.h, Quickdraw.h,
 * or anything Toolbox-flavored. Compiles under both Retro68 (m68k) and the
 * host gcc/clang for unit tests.
 *
 * The tokenizer is intentionally permissive: it never errors on malformed
 * markup, just skips what it can't parse. The layout pass is similarly
 * forgiving — unknown tags become passthrough text, mismatched closes
 * pop their style off the stack only if it matches.
 *
 * Word-wrap uses a simple greedy algorithm with a glyph-width estimate
 * (no kerning, no real font metrics — Geneva 12 averages ~6px per
 * character which is good enough for proof-of-concept layout). The
 * Toolbox shell can override the estimate later if it wants pixel-perfect
 * line breaks via TextWidth().
 */

#include "html_parse.h"

#include <string.h>

/* ------------------------------------------------------------ Tokenizer */

static int ascii_lower(int c)
{
    if (c >= 'A' && c <= 'Z') return c + 32;
    return c;
}

static int strieq(const char *a, size_t alen, const char *b)
{
    size_t i;
    for (i = 0; i < alen; i++) {
        if (b[i] == 0) return 0;
        if (ascii_lower((unsigned char)a[i]) != ascii_lower((unsigned char)b[i])) return 0;
    }
    return b[i] == 0;
}

HtmlTagId html_tag_id(const char *name, size_t len)
{
    /* Order: most common first. Brute-force compare is fine — the table is
     * tiny and this is called O(tags-in-doc) times, which is small. */
    if (strieq(name, len, "p"))      return HTML_TAG_P;
    if (strieq(name, len, "br"))     return HTML_TAG_BR;
    if (strieq(name, len, "a"))      return HTML_TAG_A;
    if (strieq(name, len, "li"))     return HTML_TAG_LI;
    if (strieq(name, len, "ul"))     return HTML_TAG_UL;
    if (strieq(name, len, "b"))      return HTML_TAG_B;
    if (strieq(name, len, "i"))      return HTML_TAG_I;
    if (strieq(name, len, "em"))     return HTML_TAG_EM;
    if (strieq(name, len, "h1"))     return HTML_TAG_H1;
    if (strieq(name, len, "h2"))     return HTML_TAG_H2;
    if (strieq(name, len, "h3"))     return HTML_TAG_H3;
    if (strieq(name, len, "pre"))    return HTML_TAG_PRE;
    if (strieq(name, len, "strong")) return HTML_TAG_STRONG;
    if (strieq(name, len, "html"))   return HTML_TAG_HTML;
    if (strieq(name, len, "head"))   return HTML_TAG_HEAD;
    if (strieq(name, len, "body"))   return HTML_TAG_BODY;
    if (strieq(name, len, "title"))  return HTML_TAG_TITLE;
    return HTML_TAG_UNKNOWN;
}

/* HTML5 void elements we treat as self-closing regardless of slash. */
static int tag_is_void(HtmlTagId t)
{
    return t == HTML_TAG_BR;
}

/* Locate href="..." or href='...' in an attribute span. Returns pointer/
 * length of the URL. Returns 0 if not found. */
static int find_href(const char *src, size_t len, const char **out, size_t *out_len)
{
    size_t i = 0;
    while (i + 4 < len) {
        if (ascii_lower((unsigned char)src[i])     == 'h' &&
            ascii_lower((unsigned char)src[i + 1]) == 'r' &&
            ascii_lower((unsigned char)src[i + 2]) == 'e' &&
            ascii_lower((unsigned char)src[i + 3]) == 'f') {
            size_t j = i + 4;
            while (j < len && (src[j] == ' ' || src[j] == '\t')) j++;
            if (j < len && src[j] == '=') {
                j++;
                while (j < len && (src[j] == ' ' || src[j] == '\t')) j++;
                char quote = 0;
                if (j < len && (src[j] == '"' || src[j] == '\'')) { quote = src[j]; j++; }
                size_t start = j;
                while (j < len) {
                    if (quote && src[j] == quote) break;
                    if (!quote && (src[j] == ' ' || src[j] == '>' || src[j] == '\t')) break;
                    j++;
                }
                *out = src + start;
                *out_len = j - start;
                return 1;
            }
        }
        i++;
    }
    return 0;
}

int html_tokenize(const char *src, size_t src_len, HtmlTokenList *out)
{
    out->count = 0;
    out->overflowed = 0;
    if (src == 0 || src_len == 0) return 0;

    size_t i = 0;
    size_t text_start = 0;

    while (i < src_len) {
        if (src[i] == '<') {
            /* Flush any pending text. */
            if (i > text_start) {
                if (out->count >= HTML_MAX_TOKENS) { out->overflowed = 1; return 0; }
                HtmlToken *t = &out->tokens[out->count++];
                t->kind = HTML_TOK_TEXT;
                t->tag = HTML_TAG_UNKNOWN;
                t->text = src + text_start;
                t->text_len = i - text_start;
                t->href = 0;
                t->href_len = 0;
            }
            /* Find matching '>'. If unterminated, treat the rest as text. */
            size_t end = i + 1;
            while (end < src_len && src[end] != '>') end++;
            if (end >= src_len) {
                text_start = i;
                break;
            }

            /* Skip <!-- ... --> and <!DOCTYPE...> entirely. */
            if (i + 3 < src_len && src[i + 1] == '!') {
                if (i + 4 <= src_len && src[i + 2] == '-' && src[i + 3] == '-') {
                    /* Comment — find --> */
                    size_t k = i + 4;
                    while (k + 2 < src_len &&
                           !(src[k] == '-' && src[k + 1] == '-' && src[k + 2] == '>')) {
                        k++;
                    }
                    if (k + 2 < src_len) end = k + 2;
                }
                i = end + 1;
                text_start = i;
                continue;
            }

            /* Determine open/close. */
            size_t name_start = i + 1;
            int is_close = 0;
            if (name_start < end && src[name_start] == '/') {
                is_close = 1;
                name_start++;
            }
            size_t name_end = name_start;
            while (name_end < end &&
                   src[name_end] != ' ' && src[name_end] != '\t' &&
                   src[name_end] != '/' && src[name_end] != '\n') {
                name_end++;
            }
            size_t name_len = name_end - name_start;

            /* Self-closing slash before '>'. */
            int is_self = 0;
            if (end > name_end && src[end - 1] == '/') is_self = 1;

            HtmlTagId tag = html_tag_id(src + name_start, name_len);
            if (tag_is_void(tag)) is_self = 1;

            if (out->count >= HTML_MAX_TOKENS) { out->overflowed = 1; return 0; }
            HtmlToken *t = &out->tokens[out->count++];
            t->kind = is_close ? HTML_TOK_TAG_CLOSE
                    : (is_self ? HTML_TOK_TAG_SELF : HTML_TOK_TAG_OPEN);
            t->tag = tag;
            t->text = src + name_start;
            t->text_len = name_len;
            t->href = 0;
            t->href_len = 0;

            /* Pick up href on opening anchor tags. */
            if (!is_close && tag == HTML_TAG_A && name_end < end) {
                find_href(src + name_end, end - name_end, &t->href, &t->href_len);
            }

            i = end + 1;
            text_start = i;
        } else {
            i++;
        }
    }

    if (i > text_start) {
        if (out->count < HTML_MAX_TOKENS) {
            HtmlToken *t = &out->tokens[out->count++];
            t->kind = HTML_TOK_TEXT;
            t->tag = HTML_TAG_UNKNOWN;
            t->text = src + text_start;
            t->text_len = i - text_start;
            t->href = 0;
            t->href_len = 0;
        } else {
            out->overflowed = 1;
        }
    }

    return 0;
}

/* ------------------------------------------------------------ Layout */

/* Per-family glyph width estimate. Geneva 12 averages ~6px; Monaco 10 is
 * a fixed ~6px. Real word-wrap should call TextWidth from the shell, but
 * this estimate is fine for proof-of-concept and keeps the layout pass
 * pure C. */
static short glyph_width_for(unsigned char family, unsigned char size,
                             unsigned char face)
{
    short w;
    if (family == DRAW_FAMILY_MONO) {
        w = (short)(size * 6 / 10);   /* Monaco is roughly 0.6 em wide */
        if (w < 6) w = 6;
    } else {
        w = (short)(size * 6 / 12);   /* Geneva ~6px @ 12pt */
        if (face & DRAW_FACE_BOLD) w += 1;
        if (w < 5) w = 5;
    }
    return w;
}

static short line_height_for(unsigned char size)
{
    /* Leading is roughly +20%; round up. */
    short h = (short)(size + (size + 4) / 5);
    if (h < size + 2) h = size + 2;
    return h;
}

/* Decode a single character entity starting at src[i]. Writes one char to
 * *out and returns the number of input bytes consumed (including the &;).
 * Returns 0 if not a recognised entity. */
static size_t decode_entity(const char *src, size_t len, size_t i, char *out)
{
    if (i >= len || src[i] != '&') return 0;
    /* Find ';' within ~8 chars. */
    size_t j = i + 1;
    size_t end = (i + 10 < len) ? i + 10 : len;
    while (j < end && src[j] != ';') j++;
    if (j >= end || src[j] != ';') return 0;
    size_t name_len = j - (i + 1);
    const char *name = src + i + 1;
    if (name_len == 3 && strieq(name, 3, "amp"))  { *out = '&';  return j - i + 1; }
    if (name_len == 2 && strieq(name, 2, "lt"))   { *out = '<';  return j - i + 1; }
    if (name_len == 2 && strieq(name, 2, "gt"))   { *out = '>';  return j - i + 1; }
    if (name_len == 4 && strieq(name, 4, "quot")) { *out = '"';  return j - i + 1; }
    if (name_len == 4 && strieq(name, 4, "apos")) { *out = '\''; return j - i + 1; }
    if (name_len == 4 && strieq(name, 4, "nbsp")) { *out = ' ';  return j - i + 1; }
    return 0;
}

/* Append a string to the layout's strpool, returning its offset. Returns
 * -1 on overflow. Always NUL-terminates so the Toolbox shell can pass the
 * pointer to TextWidth/etc. without knowing the length, but the explicit
 * length on the DrawOp is still authoritative. */
static int strpool_append(HtmlLayout *L, const char *s, size_t len)
{
    if (L->strpool_used + len + 1 > HTML_LAYOUT_STRPOOL_BYTES) return -1;
    int off = L->strpool_used;
    if (len) memcpy(L->strpool + off, s, len);
    L->strpool[off + len] = 0;
    L->strpool_used = (unsigned short)(off + len + 1);
    return off;
}

/* Layout state machine. Tracks current text style + cursor position. */
typedef struct {
    short cur_x;                /* current pen x in content coords */
    short cur_y;                /* baseline y of current line */
    short line_top;             /* top of current line (for link bounds) */
    short line_max_height;      /* tallest glyph on this line so far */
    short content_width;
    short list_depth;           /* >0 inside <ul> */
    short pending_indent;       /* x to start next new line at */

    unsigned char face;
    unsigned char family;
    unsigned char body_size;
    unsigned char cur_size;

    /* Active link, if any. Tracks the bounding box across the run so a
     * single LINK_REGION op covers all the words in the anchor. */
    int   link_active;
    int   link_first_op;        /* index of first DrawOp in the link */
    short link_left;
    short link_top;
    short link_right;
    short link_bottom;
    int   link_href_off;
    int   link_href_len;
} LayoutCtx;

static void emit_link_region(HtmlLayout *L, LayoutCtx *ctx);

/* Finish the current line. Advances cur_y to the next baseline. */
static void newline(HtmlLayout *L, LayoutCtx *ctx)
{
    /* If a link was in progress and crossed a line, freeze the existing
     * region; the next run starts a new one. */
    if (ctx->link_active && ctx->link_right > ctx->link_left) {
        emit_link_region(L, ctx);
        ctx->link_first_op = L->op_count;
        ctx->link_left = ctx->pending_indent;
        ctx->link_right = ctx->pending_indent;
    }
    short lh = ctx->line_max_height;
    if (lh < line_height_for(ctx->body_size)) lh = line_height_for(ctx->body_size);
    ctx->cur_y += lh;
    ctx->line_top = ctx->cur_y - ctx->cur_size;
    ctx->cur_x = ctx->pending_indent;
    ctx->line_max_height = 0;
    if (ctx->cur_y > L->content_height) L->content_height = ctx->cur_y;
}

/* Emit a TEXT draw op for a word. */
static void emit_word(HtmlLayout *L, LayoutCtx *ctx, const char *s, size_t len)
{
    if (len == 0) return;
    if (L->op_count >= HTML_LAYOUT_MAX_OPS) { L->overflowed = 1; return; }
    int off = strpool_append(L, s, len);
    if (off < 0) { L->overflowed = 1; return; }

    short gw = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
    short word_w = (short)(gw * (short)len);

    DrawOp *op = &L->ops[L->op_count++];
    op->kind = DRAW_OP_TEXT;
    op->x = ctx->cur_x;
    op->y = ctx->cur_y;
    op->width = word_w;
    op->height = line_height_for(ctx->cur_size);
    op->face = ctx->face;
    op->family = ctx->family;
    op->font_size = ctx->cur_size;
    op->text_off = (unsigned short)off;
    op->text_len = (unsigned short)len;
    op->link_left = op->link_top = op->link_right = op->link_bottom = 0;
    op->href_off = op->href_len = 0;

    short lh = line_height_for(ctx->cur_size);
    if (lh > ctx->line_max_height) ctx->line_max_height = lh;

    if (ctx->link_active) {
        if (ctx->link_left == ctx->link_right) {
            ctx->link_left = ctx->cur_x;
            ctx->link_top = ctx->cur_y - ctx->cur_size;
        }
        ctx->link_right = ctx->cur_x + word_w;
        ctx->link_bottom = ctx->cur_y + 2;
    }

    ctx->cur_x += word_w;
}

static void emit_link_region(HtmlLayout *L, LayoutCtx *ctx)
{
    if (!ctx->link_active) return;
    if (ctx->link_right <= ctx->link_left) return;
    if (L->op_count >= HTML_LAYOUT_MAX_OPS) { L->overflowed = 1; return; }
    int href_off = ctx->link_href_off;
    int href_len = ctx->link_href_len;
    DrawOp *op = &L->ops[L->op_count++];
    op->kind = DRAW_OP_LINK_REGION;
    op->x = ctx->link_left;
    op->y = ctx->link_top;
    op->width = (short)(ctx->link_right - ctx->link_left);
    op->height = (short)(ctx->link_bottom - ctx->link_top);
    op->face = 0;
    op->family = 0;
    op->font_size = 0;
    op->text_off = 0;
    op->text_len = 0;
    op->link_left = ctx->link_left;
    op->link_top = ctx->link_top;
    op->link_right = ctx->link_right;
    op->link_bottom = ctx->link_bottom;
    op->href_off = (unsigned short)href_off;
    op->href_len = (unsigned short)href_len;
}

/* Emit a bullet glyph at the current x (used for <li>). */
static void emit_bullet(HtmlLayout *L, LayoutCtx *ctx)
{
    if (L->op_count >= HTML_LAYOUT_MAX_OPS) { L->overflowed = 1; return; }
    DrawOp *op = &L->ops[L->op_count++];
    op->kind = DRAW_OP_BULLET;
    op->x = ctx->cur_x;
    op->y = ctx->cur_y;
    op->width = 8;
    op->height = (short)ctx->cur_size;
    op->face = 0;
    op->family = ctx->family;
    op->font_size = ctx->cur_size;
    op->text_off = 0;
    op->text_len = 0;
    op->link_left = op->link_top = op->link_right = op->link_bottom = 0;
    op->href_off = op->href_len = 0;
    ctx->cur_x += 14;
}

/* Process a text run: collapse whitespace (unless in <pre> — caller decides),
 * emit words, wrap on overflow. */
static void layout_text_run(HtmlLayout *L, LayoutCtx *ctx,
                            const char *src, size_t len, int preformatted)
{
    /* Decode entities into a small word buffer; flush on whitespace. */
    char word[256];
    size_t wlen = 0;

    size_t i = 0;
    while (i < len) {
        char c;
        size_t adv;
        if (src[i] == '&' && (adv = decode_entity(src, len, i, &c)) > 0) {
            i += adv;
        } else {
            c = src[i++];
        }

        if (preformatted) {
            if (c == '\n') {
                if (wlen) {
                    emit_word(L, ctx, word, wlen);
                    wlen = 0;
                }
                newline(L, ctx);
                continue;
            }
            /* In pre, treat space specially: emit single-char word so x
             * advances. Word buffer is flushed on actual whitespace too. */
            if (wlen + 1 < sizeof(word)) word[wlen++] = c;
            continue;
        }

        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            if (wlen) {
                /* Wrap if this word won't fit. */
                short gw = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
                short word_w = (short)(gw * (short)wlen);
                if (ctx->cur_x + word_w > ctx->content_width &&
                    ctx->cur_x > ctx->pending_indent) {
                    newline(L, ctx);
                }
                emit_word(L, ctx, word, wlen);
                wlen = 0;
                /* Inter-word space: one glyph width, but only if we're not
                 * at the start of a fresh line. */
                if (ctx->cur_x > ctx->pending_indent) {
                    short gw2 = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
                    ctx->cur_x += gw2;
                }
            }
            continue;
        }

        if (wlen + 1 < sizeof(word)) word[wlen++] = c;
    }

    if (preformatted) {
        if (wlen) emit_word(L, ctx, word, wlen);
    } else if (wlen) {
        short gw = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
        short word_w = (short)(gw * (short)wlen);
        if (ctx->cur_x + word_w > ctx->content_width &&
            ctx->cur_x > ctx->pending_indent) {
            newline(L, ctx);
        }
        emit_word(L, ctx, word, wlen);
    }
}

/* Apply a heading size from the H1/H2/H3 tag id. */
static unsigned char heading_size(HtmlTagId t, unsigned char body)
{
    if (t == HTML_TAG_H1) return (unsigned char)(body + 12);  /* 24 if body=12 */
    if (t == HTML_TAG_H2) return (unsigned char)(body + 6);   /* 18 */
    if (t == HTML_TAG_H3) return (unsigned char)(body + 2);   /* 14 */
    return body;
}

int html_layout_build(const HtmlTokenList *tokens,
                      HtmlLayout *out,
                      short content_width,
                      unsigned char font_size_body)
{
    memset(out, 0, sizeof(*out));
    out->content_width = content_width;

    LayoutCtx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.content_width = content_width;
    ctx.body_size = font_size_body;
    ctx.cur_size = font_size_body;
    ctx.family = DRAW_FAMILY_BODY;
    ctx.face = 0;
    ctx.cur_x = 0;
    ctx.pending_indent = 0;
    /* Start with a baseline one body-size below the top so the first line
     * of text sits inside the viewport. */
    ctx.cur_y = (short)(font_size_body + 4);
    ctx.line_top = ctx.cur_y - font_size_body;
    ctx.line_max_height = 0;

    int in_pre = 0;
    int just_block_break = 1;   /* suppress leading blank lines */

    for (int ti = 0; ti < tokens->count; ti++) {
        const HtmlToken *t = &tokens->tokens[ti];

        if (t->kind == HTML_TOK_TEXT) {
            /* Skip leading whitespace right after a block break. */
            if (just_block_break && !in_pre) {
                size_t s = 0;
                while (s < t->text_len &&
                       (t->text[s] == ' ' || t->text[s] == '\t' ||
                        t->text[s] == '\n' || t->text[s] == '\r')) {
                    s++;
                }
                if (s >= t->text_len) continue;
                layout_text_run(out, &ctx, t->text + s, t->text_len - s, in_pre);
            } else {
                layout_text_run(out, &ctx, t->text, t->text_len, in_pre);
            }
            just_block_break = 0;
            continue;
        }

        HtmlTagId tag = t->tag;
        int is_open  = (t->kind == HTML_TOK_TAG_OPEN);
        int is_close = (t->kind == HTML_TOK_TAG_CLOSE);
        int is_self  = (t->kind == HTML_TOK_TAG_SELF);

        switch (tag) {
            case HTML_TAG_BR:
                /* Always a line break, regardless of open/close/self. */
                newline(out, &ctx);
                just_block_break = 1;
                break;

            case HTML_TAG_P:
                if (is_open || is_close) {
                    if (!just_block_break) newline(out, &ctx);
                    /* extra spacing for paragraph */
                    ctx.cur_y += (short)(font_size_body / 2);
                    ctx.line_top = ctx.cur_y - ctx.cur_size;
                    just_block_break = 1;
                }
                break;

            case HTML_TAG_H1:
            case HTML_TAG_H2:
            case HTML_TAG_H3:
                if (is_open) {
                    if (!just_block_break) newline(out, &ctx);
                    ctx.cur_y += (short)(font_size_body / 2);
                    ctx.cur_size = heading_size(tag, font_size_body);
                    ctx.face |= DRAW_FACE_BOLD;
                    ctx.line_top = ctx.cur_y - ctx.cur_size;
                    just_block_break = 1;
                } else if (is_close) {
                    newline(out, &ctx);
                    ctx.cur_size = font_size_body;
                    ctx.face &= (unsigned char)~DRAW_FACE_BOLD;
                    just_block_break = 1;
                }
                break;

            case HTML_TAG_B:
            case HTML_TAG_STRONG:
                if (is_open) ctx.face |= DRAW_FACE_BOLD;
                else if (is_close) ctx.face &= (unsigned char)~DRAW_FACE_BOLD;
                break;

            case HTML_TAG_I:
            case HTML_TAG_EM:
                if (is_open) ctx.face |= DRAW_FACE_ITALIC;
                else if (is_close) ctx.face &= (unsigned char)~DRAW_FACE_ITALIC;
                break;

            case HTML_TAG_PRE:
                if (is_open) {
                    if (!just_block_break) newline(out, &ctx);
                    ctx.family = DRAW_FAMILY_MONO;
                    in_pre = 1;
                    just_block_break = 1;
                } else if (is_close) {
                    newline(out, &ctx);
                    ctx.family = DRAW_FAMILY_BODY;
                    in_pre = 0;
                    just_block_break = 1;
                }
                break;

            case HTML_TAG_UL:
                if (is_open) {
                    if (!just_block_break) newline(out, &ctx);
                    ctx.list_depth++;
                    ctx.pending_indent = (short)(ctx.list_depth * 18);
                    just_block_break = 1;
                } else if (is_close) {
                    if (ctx.list_depth > 0) ctx.list_depth--;
                    ctx.pending_indent = (short)(ctx.list_depth * 18);
                    newline(out, &ctx);
                    just_block_break = 1;
                }
                break;

            case HTML_TAG_LI:
                if (is_open) {
                    if (!just_block_break) newline(out, &ctx);
                    /* Bullet sits at indent − 12; text continues at indent. */
                    short save = ctx.pending_indent;
                    ctx.cur_x = (short)(save - 12);
                    if (ctx.cur_x < 0) ctx.cur_x = 0;
                    emit_bullet(out, &ctx);
                    ctx.cur_x = save;
                    just_block_break = 0;
                } else if (is_close) {
                    newline(out, &ctx);
                    just_block_break = 1;
                }
                break;

            case HTML_TAG_A:
                if (is_open) {
                    ctx.face |= DRAW_FACE_UNDERLINE;
                    ctx.link_active = 1;
                    ctx.link_first_op = out->op_count;
                    ctx.link_left = ctx.cur_x;
                    ctx.link_right = ctx.cur_x;
                    ctx.link_top = ctx.cur_y - ctx.cur_size;
                    ctx.link_bottom = ctx.cur_y + 2;
                    int hoff = -1;
                    if (t->href && t->href_len) {
                        hoff = strpool_append(out, t->href, t->href_len);
                    } else {
                        hoff = strpool_append(out, "", 0);
                    }
                    ctx.link_href_off = (hoff < 0) ? 0 : hoff;
                    ctx.link_href_len = (int)t->href_len;
                } else if (is_close) {
                    emit_link_region(out, &ctx);
                    ctx.link_active = 0;
                    ctx.face &= (unsigned char)~DRAW_FACE_UNDERLINE;
                }
                break;

            case HTML_TAG_HTML:
            case HTML_TAG_HEAD:
            case HTML_TAG_BODY:
                /* Wrappers — ignore. */
                break;

            case HTML_TAG_TITLE:
                /* Skip everything between <title>...</title>. We don't
                 * render document titles in the body. */
                if (is_open) {
                    int depth = 1;
                    while (++ti < tokens->count && depth > 0) {
                        const HtmlToken *t2 = &tokens->tokens[ti];
                        if (t2->kind == HTML_TOK_TAG_OPEN && t2->tag == HTML_TAG_TITLE) depth++;
                        else if (t2->kind == HTML_TOK_TAG_CLOSE && t2->tag == HTML_TAG_TITLE) depth--;
                    }
                }
                break;

            default:
                /* Unknown tags: graceful no-op, suppress (void) warning. */
                (void)is_self;
                break;
        }
    }

    /* Final flush. */
    if (ctx.link_active) emit_link_region(out, &ctx);
    if (ctx.cur_x > 0 || ctx.cur_y > 0) {
        if (ctx.cur_y > out->content_height) out->content_height = ctx.cur_y;
    }
    out->content_height += line_height_for(font_size_body);
    return 0;
}

int html_layout_hit_link(const HtmlLayout *layout, short x, short y)
{
    for (int i = 0; i < layout->op_count; i++) {
        const DrawOp *op = &layout->ops[i];
        if (op->kind != DRAW_OP_LINK_REGION) continue;
        if (x >= op->link_left && x <= op->link_right &&
            y >= op->link_top  && y <= op->link_bottom) {
            return i;
        }
    }
    return -1;
}
