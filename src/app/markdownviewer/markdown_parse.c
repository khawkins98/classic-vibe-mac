/*
 * markdown_parse.c — Markdown → DrawOp layout engine.
 *
 * Pure C, no Mac Toolbox.  Compiled by Retro68 and the host C compiler.
 * Host unit tests live in tests/unit/test_md_parse.c.
 *
 * Architecture mirrors html_parse.c:
 *   - A LayoutCtx tracks the pen position, current font style, and list
 *     indent.  Helper functions (newline, emit_word, emit_bullet) advance
 *     the cursor and append DrawOp records to the MdLayout.
 *   - The top-level md_layout_build() walks the Markdown source line by
 *     line, classifying each line as heading / blockquote / bullet / code /
 *     blank / body and dispatching to the appropriate helpers.
 *   - Inline formatting (**bold**, *italic*, `code`, [link](url)) is parsed
 *     within body lines by layout_md_inline(), which calls layout_text_run()
 *     for each run with the appropriate face/family flags set.
 *   - Word-wrap uses the same greedy estimate as html_parse.c: fixed glyph
 *     width derived from font size.  Real pixel-accurate wrap requires
 *     calling TextWidth() from the Toolbox shell, but the estimate is fine
 *     for a System 7 reader.
 */

#include "markdown_parse.h"

#include <string.h>

/* ---------------------------------------------------------------- helpers */

static short glyph_width_for(unsigned char family, unsigned char size,
                              unsigned char face)
{
    short w;
    if (family == DRAW_FAMILY_MONO) {
        w = (short)(size * 6 / 10);
        if (w < 6) w = 6;
    } else {
        w = (short)(size * 6 / 12);
        if (face & DRAW_FACE_BOLD) w += 1;
        if (w < 5) w = 5;
    }
    return w;
}

static short line_height_for(unsigned char size)
{
    short h = (short)(size + (size + 4) / 5);
    if (h < size + 2) h = size + 2;
    return h;
}

static int strpool_append(MdLayout *L, const char *s, size_t len)
{
    if (L->strpool_used + len + 1 > MD_LAYOUT_STRPOOL_BYTES) return -1;
    int off = L->strpool_used;
    if (len) memcpy(L->strpool + off, s, len);
    L->strpool[off + len] = 0;
    L->strpool_used = (unsigned short)(off + len + 1);
    return off;
}

/* ---------------------------------------------------------------- layout state */

typedef struct {
    short         cur_x;
    short         cur_y;
    short         line_top;
    short         line_max_height;
    short         content_width;
    short         list_depth;
    short         pending_indent;
    unsigned char face;
    unsigned char family;
    unsigned char body_size;
    unsigned char cur_size;
} LayoutCtx;

static void newline(MdLayout *L, LayoutCtx *ctx)
{
    short lh = ctx->line_max_height;
    if (lh < line_height_for(ctx->body_size)) lh = line_height_for(ctx->body_size);
    ctx->cur_y += lh;
    ctx->line_top = ctx->cur_y - ctx->cur_size;
    ctx->cur_x = ctx->pending_indent;
    ctx->line_max_height = 0;
    if (ctx->cur_y > L->content_height) L->content_height = ctx->cur_y;
}

static void emit_word(MdLayout *L, LayoutCtx *ctx, const char *s, size_t len)
{
    if (len == 0) return;
    if (L->op_count >= MD_LAYOUT_MAX_OPS) { L->overflowed = 1; return; }
    int off = strpool_append(L, s, len);
    if (off < 0) { L->overflowed = 1; return; }

    short gw = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
    short word_w = (short)(gw * (short)len);

    DrawOp *op = &L->ops[L->op_count++];
    op->kind      = DRAW_OP_TEXT;
    op->x         = ctx->cur_x;
    op->y         = ctx->cur_y;
    op->width     = word_w;
    op->height    = line_height_for(ctx->cur_size);
    op->face      = ctx->face;
    op->family    = ctx->family;
    op->font_size = ctx->cur_size;
    op->text_off  = (unsigned short)off;
    op->text_len  = (unsigned short)len;
    op->link_left = op->link_top = op->link_right = op->link_bottom = 0;
    op->href_off  = op->href_len = 0;

    short lh = line_height_for(ctx->cur_size);
    if (lh > ctx->line_max_height) ctx->line_max_height = lh;
    ctx->cur_x += word_w;
}

static void emit_bullet(MdLayout *L, LayoutCtx *ctx)
{
    if (L->op_count >= MD_LAYOUT_MAX_OPS) { L->overflowed = 1; return; }
    DrawOp *op = &L->ops[L->op_count++];
    op->kind      = DRAW_OP_BULLET;
    op->x         = ctx->cur_x;
    op->y         = ctx->cur_y;
    op->width     = 8;
    op->height    = (short)ctx->cur_size;
    op->face      = 0;
    op->family    = ctx->family;
    op->font_size = ctx->cur_size;
    op->text_off  = op->text_len = 0;
    op->link_left = op->link_top = op->link_right = op->link_bottom = 0;
    op->href_off  = op->href_len = 0;
    ctx->cur_x += 14;
}

/* Greedy word-wrap text run.  preformatted=1 preserves newlines verbatim
 * (used for fenced code blocks). */
static void layout_text_run(MdLayout *L, LayoutCtx *ctx,
                             const char *src, size_t len, int preformatted)
{
    char   word[256];
    size_t wlen = 0;
    size_t i    = 0;

    while (i < len) {
        char c = src[i++];

        if (preformatted) {
            if (c == '\n') {
                if (wlen) { emit_word(L, ctx, word, wlen); wlen = 0; }
                newline(L, ctx);
                continue;
            }
            if (wlen + 1 < sizeof(word)) word[wlen++] = c;
            continue;
        }

        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            if (wlen) {
                short gw     = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
                short word_w = (short)(gw * (short)wlen);
                if (ctx->cur_x + word_w > ctx->content_width &&
                    ctx->cur_x > ctx->pending_indent) {
                    newline(L, ctx);
                }
                emit_word(L, ctx, word, wlen);
                wlen = 0;
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
        short gw     = glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
        short word_w = (short)(gw * (short)wlen);
        if (ctx->cur_x + word_w > ctx->content_width &&
            ctx->cur_x > ctx->pending_indent) {
            newline(L, ctx);
        }
        emit_word(L, ctx, word, wlen);
    }
}

/* Add inter-word spacing before a continuation text run (when we're already
 * past the start of a line).  Called at the top of layout_md_inline so
 * each Markdown line that continues the same paragraph is spaced from the
 * previous words. */
static void add_inter_word_space(LayoutCtx *ctx)
{
    if (ctx->cur_x > ctx->pending_indent) {
        ctx->cur_x += glyph_width_for(ctx->family, ctx->cur_size, ctx->face);
    }
}

/* Find the next occurrence of needle (length nlen) in haystack[pos..len).
 * Returns the index or len if not found. */
static size_t find_seq(const char *src, size_t len, size_t pos,
                       const char *needle, size_t nlen)
{
    while (pos + nlen <= len) {
        if (memcmp(src + pos, needle, nlen) == 0) return pos;
        pos++;
    }
    return len;
}

/* Process inline Markdown formatting within a single text segment
 * (a line or part of a line, not including the block prefix).
 * Handles: **bold**, __bold__, *italic*, _italic_, `code`, [text](url).
 * Emits DrawOps for each run. */
static void layout_md_inline(MdLayout *L, LayoutCtx *ctx,
                              const char *src, size_t len,
                              int is_continuation)
{
    if (len == 0) return;

    /* Add a separating space when continuing on the same logical line. */
    if (is_continuation) add_inter_word_space(ctx);

    unsigned char saved_face   = ctx->face;
    unsigned char saved_family = ctx->family;
    size_t i         = 0;
    size_t seg_start = 0;

    while (i < len) {
        /* ---- ** bold ---- */
        if (i + 1 < len && src[i] == '*' && src[i+1] == '*') {
            if (i > seg_start)
                layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
            size_t end = find_seq(src, len, i + 2, "**", 2);
            if (end < len) {
                ctx->face = saved_face | DRAW_FACE_BOLD;
                layout_text_run(L, ctx, src + i + 2, end - (i + 2), 0);
                ctx->face = saved_face;
                i = end + 2; seg_start = i;
            } else {
                i += 2;  /* unmatched: treat as literal */
            }
            continue;
        }
        /* ---- __ bold ---- */
        if (i + 1 < len && src[i] == '_' && src[i+1] == '_') {
            if (i > seg_start)
                layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
            size_t end = find_seq(src, len, i + 2, "__", 2);
            if (end < len) {
                ctx->face = saved_face | DRAW_FACE_BOLD;
                layout_text_run(L, ctx, src + i + 2, end - (i + 2), 0);
                ctx->face = saved_face;
                i = end + 2; seg_start = i;
            } else { i += 2; }
            continue;
        }
        /* ---- * italic ---- */
        if (src[i] == '*') {
            if (i > seg_start)
                layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
            size_t end = find_seq(src, len, i + 1, "*", 1);
            if (end < len) {
                ctx->face = saved_face | DRAW_FACE_ITALIC;
                layout_text_run(L, ctx, src + i + 1, end - (i + 1), 0);
                ctx->face = saved_face;
                i = end + 1; seg_start = i;
            } else { i++; }
            continue;
        }
        /* ---- _ italic ---- */
        if (src[i] == '_') {
            if (i > seg_start)
                layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
            size_t end = find_seq(src, len, i + 1, "_", 1);
            if (end < len) {
                ctx->face = saved_face | DRAW_FACE_ITALIC;
                layout_text_run(L, ctx, src + i + 1, end - (i + 1), 0);
                ctx->face = saved_face;
                i = end + 1; seg_start = i;
            } else { i++; }
            continue;
        }
        /* ---- ` inline code ---- */
        if (src[i] == '`') {
            if (i > seg_start)
                layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
            size_t end = find_seq(src, len, i + 1, "`", 1);
            if (end < len) {
                ctx->family = DRAW_FAMILY_MONO;
                layout_text_run(L, ctx, src + i + 1, end - (i + 1), 0);
                ctx->family = saved_family;
                i = end + 1; seg_start = i;
            } else { i++; }
            continue;
        }
        /* ---- [text](url) link ---- */
        if (src[i] == '[') {
            size_t j = find_seq(src, len, i + 1, "]", 1);
            if (j < len && j + 1 < len && src[j+1] == '(') {
                size_t k = find_seq(src, len, j + 2, ")", 1);
                if (i > seg_start)
                    layout_text_run(L, ctx, src + seg_start, i - seg_start, 0);
                /* Emit the link text underlined. */
                ctx->face = saved_face | DRAW_FACE_UNDERLINE;
                layout_text_run(L, ctx, src + i + 1, j - (i + 1), 0);
                ctx->face = saved_face;
                i = (k < len) ? k + 1 : len;
                seg_start = i;
                continue;
            }
        }
        i++;
    }
    /* Flush any remaining plain segment. */
    if (len > seg_start)
        layout_text_run(L, ctx, src + seg_start, len - seg_start, 0);

    ctx->face   = saved_face;
    ctx->family = saved_family;
}

/* ---------------------------------------------------------------- heading helpers */

static unsigned char heading_size(int level, unsigned char body)
{
    if (level == 1) return (unsigned char)(body + 12);  /* 24 at body=12 */
    if (level == 2) return (unsigned char)(body + 6);   /* 18 */
    if (level == 3) return (unsigned char)(body + 2);   /* 14 */
    return body;
}

/* ---------------------------------------------------------------- main entry */

int md_layout_build(const char *src, size_t len,
                    MdLayout *out,
                    short content_width,
                    unsigned char font_size_body)
{
    memset(out, 0, sizeof(*out));
    out->content_width = content_width;

    LayoutCtx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.body_size      = font_size_body;
    ctx.cur_size       = font_size_body;
    ctx.content_width  = content_width;
    ctx.pending_indent = 4;
    ctx.cur_x          = 4;
    ctx.cur_y          = (short)(font_size_body + 4);
    ctx.line_top       = ctx.cur_y - font_size_body;
    ctx.family         = DRAW_FAMILY_BODY;

    int  in_fenced_code  = 0;   /* inside ``` ... ``` block */
    int  in_paragraph    = 0;   /* have we emitted text on the current paragraph? */
    int  just_block_end  = 1;   /* suppress duplicate blank lines at top */

    const char *p   = src;
    const char *end = src + len;

    while (p < end) {
        /* ---- find end of current line ---- */
        const char *line_start = p;
        while (p < end && *p != '\n') p++;
        size_t line_len = (size_t)(p - line_start);
        if (p < end) p++;   /* consume the '\n' */

        /* Strip trailing CR (Windows line endings). */
        if (line_len > 0 && line_start[line_len - 1] == '\r') line_len--;

        const char *line = line_start;

        /* ---- fenced code block handling ---- */
        if (line_len >= 3 && line[0] == '`' && line[1] == '`' && line[2] == '`') {
            if (in_fenced_code) {
                /* Close the code block. */
                if (ctx.cur_x > ctx.pending_indent) newline(out, &ctx);
                ctx.family     = DRAW_FAMILY_BODY;
                ctx.cur_size   = font_size_body;
                in_fenced_code = 0;
                just_block_end = 1;
                in_paragraph   = 0;
            } else {
                /* Open a code block. */
                if (!just_block_end) { newline(out, &ctx); }
                ctx.cur_y += (short)(font_size_body / 3);
                ctx.cur_x  = ctx.pending_indent;
                ctx.family = DRAW_FAMILY_MONO;
                in_fenced_code = 1;
                just_block_end = 1;
                in_paragraph   = 0;
            }
            continue;
        }

        if (in_fenced_code) {
            /* Emit verbatim line as monospace preformatted text. */
            if (line_len > 0) {
                layout_text_run(out, &ctx, line, line_len, 0);
            }
            newline(out, &ctx);
            continue;
        }

        /* ---- blank line ---- */
        if (line_len == 0) {
            if (in_paragraph) {
                newline(out, &ctx);
                ctx.cur_y += (short)(font_size_body / 2);
                ctx.line_top = ctx.cur_y - ctx.cur_size;
            }
            in_paragraph   = 0;
            just_block_end = 1;
            continue;
        }

        /* ---- thematic break (---, ***, ___) ---- */
        if (line_len >= 3) {
            int is_break = 1;
            char c0 = line[0];
            if (c0 == '-' || c0 == '*' || c0 == '_') {
                for (size_t k = 0; k < line_len; k++) {
                    if (line[k] != c0 && line[k] != ' ') { is_break = 0; break; }
                }
                /* Count actual separator chars (not spaces). */
                if (is_break) {
                    int cnt = 0;
                    for (size_t k = 0; k < line_len; k++) if (line[k] == c0) cnt++;
                    if (cnt < 3) is_break = 0;
                }
            } else {
                is_break = 0;
            }
            if (is_break) {
                if (!just_block_end) newline(out, &ctx);
                ctx.cur_y += font_size_body;
                ctx.cur_x  = ctx.pending_indent;
                ctx.line_top = ctx.cur_y - ctx.cur_size;
                in_paragraph   = 0;
                just_block_end = 1;
                continue;
            }
        }

        /* ---- ATX headings (# ## ###) ---- */
        if (line[0] == '#') {
            int level = 0;
            while (level < (int)line_len && line[level] == '#') level++;
            if (level <= 3 && level < (int)line_len && line[level] == ' ') {
                if (!just_block_end) newline(out, &ctx);
                ctx.cur_y += (short)(font_size_body / 2);
                ctx.line_top = ctx.cur_y - ctx.cur_size;

                ctx.cur_size = heading_size(level, font_size_body);
                ctx.face    |= DRAW_FACE_BOLD;
                ctx.cur_x    = ctx.pending_indent;

                const char *text = line + level + 1;
                size_t text_len  = line_len - (size_t)level - 1;
                /* Strip optional trailing # sequence. */
                while (text_len > 0 && text[text_len - 1] == '#') text_len--;
                while (text_len > 0 && text[text_len - 1] == ' ') text_len--;

                layout_md_inline(out, &ctx, text, text_len, 0);
                newline(out, &ctx);

                ctx.cur_size  = font_size_body;
                ctx.face     &= (unsigned char)~DRAW_FACE_BOLD;
                in_paragraph  = 0;
                just_block_end = 1;
                continue;
            }
        }

        /* ---- blockquote (> text) ---- */
        if (line[0] == '>') {
            if (!just_block_end) newline(out, &ctx);
            short old_indent     = ctx.pending_indent;
            ctx.pending_indent   = (short)(old_indent + 16);
            ctx.cur_x            = ctx.pending_indent;
            ctx.face            |= DRAW_FACE_ITALIC;

            const char *text = (line_len > 1 && line[1] == ' ') ? line + 2 : line + 1;
            size_t text_len  = (line_len > 1 && line[1] == ' ') ?
                               line_len - 2 : (line_len > 0 ? line_len - 1 : 0);

            layout_md_inline(out, &ctx, text, text_len, 0);
            newline(out, &ctx);

            ctx.face          &= (unsigned char)~DRAW_FACE_ITALIC;
            ctx.pending_indent = old_indent;
            ctx.cur_x          = ctx.pending_indent;
            in_paragraph       = 0;
            just_block_end     = 1;
            continue;
        }

        /* ---- unordered list (- item  or  * item) ---- */
        if (line_len >= 2 &&
            (line[0] == '-' || line[0] == '+' || line[0] == '*') &&
            line[1] == ' ') {

            if (!just_block_end) newline(out, &ctx);
            short old_indent   = ctx.pending_indent;
            ctx.pending_indent = (short)(old_indent + 18);
            ctx.cur_x          = (short)(ctx.pending_indent - 12);
            if (ctx.cur_x < 0) ctx.cur_x = 0;
            emit_bullet(out, &ctx);
            ctx.cur_x = ctx.pending_indent;

            const char *text    = line + 2;
            size_t      text_len = line_len - 2;
            layout_md_inline(out, &ctx, text, text_len, 0);
            newline(out, &ctx);

            ctx.pending_indent = old_indent;
            ctx.cur_x          = ctx.pending_indent;
            in_paragraph       = 0;
            just_block_end     = 1;
            continue;
        }

        /* ---- ordered list (1. item, 2. item, …) ---- */
        {
            size_t k = 0;
            while (k < line_len && line[k] >= '0' && line[k] <= '9') k++;
            if (k > 0 && k + 1 < line_len && line[k] == '.' && line[k+1] == ' ') {
                if (!just_block_end) newline(out, &ctx);
                short old_indent   = ctx.pending_indent;
                ctx.pending_indent = (short)(old_indent + 18);
                ctx.cur_x          = (short)(ctx.pending_indent - 12);
                if (ctx.cur_x < 0) ctx.cur_x = 0;
                emit_bullet(out, &ctx);
                ctx.cur_x = ctx.pending_indent;

                const char *text    = line + k + 2;
                size_t      text_len = line_len - k - 2;
                layout_md_inline(out, &ctx, text, text_len, 0);
                newline(out, &ctx);

                ctx.pending_indent = old_indent;
                ctx.cur_x          = ctx.pending_indent;
                in_paragraph       = 0;
                just_block_end     = 1;
                continue;
            }
        }

        /* ---- body paragraph text ---- */
        layout_md_inline(out, &ctx, line, line_len, in_paragraph);
        in_paragraph   = 1;
        just_block_end = 0;
    }

    /* Flush any open line. */
    if (ctx.cur_x > ctx.pending_indent) newline(out, &ctx);

    return 0;
}
