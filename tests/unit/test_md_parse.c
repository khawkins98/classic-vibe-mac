/*
 * test_md_parse.c — host-compiled unit tests for markdown_parse.c.
 *
 * Compiles with the host gcc/clang. No Mac Toolbox involvement.
 * Run via:  make && ./test_md_parse
 */

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "markdown_parse.h"

/* ------------------------------------------------------------ helpers */

/* Find ANY text op whose text exactly matches want. If face_mask is non-zero,
 * all bits in the mask must be set on the op. */
static int has_op_with_text(const MdLayout *L, const char *want,
                             unsigned char face_mask)
{
    size_t wl = strlen(want);
    for (int i = 0; i < L->op_count; i++) {
        const DrawOp *op = &L->ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len != wl) continue;
        if (memcmp(L->strpool + op->text_off, want, wl) != 0) continue;
        if ((op->face & face_mask) == face_mask) return 1;
    }
    return 0;
}

/* Retrieve the first TEXT op whose text exactly matches want; NULL if missing. */
static const DrawOp *find_op_with_text(const MdLayout *L, const char *want)
{
    size_t wl = strlen(want);
    for (int i = 0; i < L->op_count; i++) {
        const DrawOp *op = &L->ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len != wl) continue;
        if (memcmp(L->strpool + op->text_off, want, wl) != 0) continue;
        return op;
    }
    return NULL;
}

static int count_ops_kind(const MdLayout *L, DrawOpKind kind)
{
    int n = 0;
    for (int i = 0; i < L->op_count; i++) if (L->ops[i].kind == kind) n++;
    return n;
}

/* ------------------------------------------------------------ tests */

static void test_h1_bold_and_size(void)
{
    const char *md = "# Hello\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);

    /* H1 must be bold. */
    assert(has_op_with_text(&L, "Hello", DRAW_FACE_BOLD));
    /* H1 font size must be body+12 = 24. */
    const DrawOp *op = find_op_with_text(&L, "Hello");
    assert(op != NULL);
    assert(op->font_size == 24);
    printf("  ok: # H1 → bold, font_size=24\n");
}

static void test_h2_size(void)
{
    const char *md = "## Sub\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op = find_op_with_text(&L, "Sub");
    assert(op != NULL);
    assert(op->font_size == 18);          /* body+6 */
    printf("  ok: ## H2 → font_size=18\n");
}

static void test_h3_size(void)
{
    const char *md = "### Sub3\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op = find_op_with_text(&L, "Sub3");
    assert(op != NULL);
    assert(op->font_size == 14);          /* body+2 */
    printf("  ok: ### H3 → font_size=14\n");
}

static void test_body_size_12(void)
{
    const char *md = "Plain body text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op = find_op_with_text(&L, "body");
    assert(op != NULL);
    assert(op->font_size == 12);
    printf("  ok: body text → font_size=12\n");
}

static void test_bold_inline(void)
{
    const char *md = "This is **bold** text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(has_op_with_text(&L, "bold", DRAW_FACE_BOLD));
    /* Surrounding words must NOT be bold. */
    const DrawOp *op = find_op_with_text(&L, "This");
    assert(op != NULL);
    assert((op->face & DRAW_FACE_BOLD) == 0);
    printf("  ok: **bold** → DRAW_FACE_BOLD, surrounding text plain\n");
}

static void test_italic_inline(void)
{
    const char *md = "This is *italic* text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(has_op_with_text(&L, "italic", DRAW_FACE_ITALIC));
    const DrawOp *op = find_op_with_text(&L, "text.");
    assert(op != NULL);
    assert((op->face & DRAW_FACE_ITALIC) == 0);
    printf("  ok: *italic* → DRAW_FACE_ITALIC, surrounding text plain\n");
}

static void test_inline_code_mono(void)
{
    const char *md = "Use `printf` to print.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op = find_op_with_text(&L, "printf");
    assert(op != NULL);
    assert(op->family == DRAW_FAMILY_MONO);
    /* Surrounding words should be body family. */
    const DrawOp *op2 = find_op_with_text(&L, "Use");
    assert(op2 != NULL);
    assert(op2->family == DRAW_FAMILY_BODY);
    printf("  ok: `code` → DRAW_FAMILY_MONO\n");
}

static void test_unordered_bullet(void)
{
    const char *md = "- apple\n- banana\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(count_ops_kind(&L, DRAW_OP_BULLET) == 2);
    assert(has_op_with_text(&L, "apple",  0));
    assert(has_op_with_text(&L, "banana", 0));
    printf("  ok: - list → 2 DRAW_OP_BULLET ops + text ops\n");
}

static void test_ordered_bullet(void)
{
    const char *md = "1. first\n2. second\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    /* Ordered lists are rendered as bullets in v1. */
    assert(count_ops_kind(&L, DRAW_OP_BULLET) == 2);
    assert(has_op_with_text(&L, "first",  0));
    assert(has_op_with_text(&L, "second", 0));
    printf("  ok: 1. ordered list → 2 DRAW_OP_BULLET ops + text ops\n");
}

static void test_blank_line_paragraph_spacing(void)
{
    /* Two paragraphs separated by a blank line. The second paragraph must
     * have a larger y coordinate than the first, beyond just line height. */
    const char *md = "Para one.\n\nPara two.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op1 = find_op_with_text(&L, "one.");
    const DrawOp *op2 = find_op_with_text(&L, "two.");
    assert(op1 != NULL);
    assert(op2 != NULL);
    /* Paragraph gap > line height alone (body=12, line_height≈14). */
    assert(op2->y - op1->y > 14 + 1);
    printf("  ok: blank line → paragraph spacing (y gap > line height)\n");
}

static void test_heading_below_heading_vertically(void)
{
    const char *md = "# Top\n## Sub\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op1 = find_op_with_text(&L, "Top");
    const DrawOp *op2 = find_op_with_text(&L, "Sub");
    assert(op1 != NULL);
    assert(op2 != NULL);
    assert(op2->y > op1->y);
    printf("  ok: ## below # vertically\n");
}

static void test_word_wrap_respects_width(void)
{
    /* 20 six-character words at 12pt ≈ 720px → must wrap in a 120px box. */
    const char *md =
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet "
        "kilo lima mike november oscar papa quebec romeo sierra tango\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 120, 12);

    short min_y = 0x7FFF, max_y = -1;
    for (int i = 0; i < L.op_count; i++) {
        const DrawOp *op = &L.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->y < min_y) min_y = op->y;
        if (op->y > max_y) max_y = op->y;
    }
    /* Multiple lines means max_y > min_y. */
    assert(max_y > min_y);
    /* No text op should start past the content width. */
    for (int i = 0; i < L.op_count; i++) {
        const DrawOp *op = &L.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        assert(op->x + op->width <= L.content_width + 16);  /* allow 1-word overhang */
    }
    printf("  ok: word-wrap respects content_width\n");
}

static void test_fenced_code_block_mono(void)
{
    const char *md = "```\nint x = 1;\n```\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    /* The code inside must be monospace. */
    const DrawOp *op = find_op_with_text(&L, "int");
    assert(op != NULL);
    assert(op->family == DRAW_FAMILY_MONO);
    printf("  ok: fenced code block → DRAW_FAMILY_MONO for code lines\n");
}

static void test_blockquote_italic(void)
{
    const char *md = "> A quoted line.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op = find_op_with_text(&L, "A");
    assert(op != NULL);
    assert(op->face & DRAW_FACE_ITALIC);
    printf("  ok: > blockquote → DRAW_FACE_ITALIC\n");
}

static void test_link_shows_underline(void)
{
    const char *md = "See [the docs](README.md) for details.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    /* Link text must be underlined. */
    assert(has_op_with_text(&L, "the", DRAW_FACE_UNDERLINE));
    /* Surrounding words must NOT be underlined. */
    const DrawOp *op = find_op_with_text(&L, "See");
    assert(op != NULL);
    assert((op->face & DRAW_FACE_UNDERLINE) == 0);
    printf("  ok: [text](url) link text → DRAW_FACE_UNDERLINE\n");
}

static void test_empty_input(void)
{
    MdLayout L;
    md_layout_build(NULL, 0, &L, 400, 12);
    assert(L.op_count == 0);

    md_layout_build("", 0, &L, 400, 12);
    assert(L.op_count == 0);
    printf("  ok: empty/NULL input → no ops, no crash\n");
}

static void test_content_height_positive_for_content(void)
{
    const char *md = "# Title\nSome body text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(L.content_height > 0);
    printf("  ok: content_height > 0 after non-empty input\n");
}

static void test_underscore_bold(void)
{
    const char *md = "This is __strong__ text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(has_op_with_text(&L, "strong", DRAW_FACE_BOLD));
    printf("  ok: __bold__ → DRAW_FACE_BOLD\n");
}

static void test_underscore_italic(void)
{
    const char *md = "This is _em_ text.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    assert(has_op_with_text(&L, "em", DRAW_FACE_ITALIC));
    printf("  ok: _italic_ → DRAW_FACE_ITALIC\n");
}

static void test_multiple_bullets_on_different_y(void)
{
    const char *md = "- one\n- two\n- three\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    /* Count bullet ops. */
    int n = count_ops_kind(&L, DRAW_OP_BULLET);
    assert(n == 3);
    /* Each bullet op must have a unique y (items stack vertically). */
    short ys[16]; int yc = 0;
    for (int i = 0; i < L.op_count; i++) {
        if (L.ops[i].kind != DRAW_OP_BULLET) continue;
        for (int j = 0; j < yc; j++) assert(ys[j] != L.ops[i].y);
        ys[yc++] = L.ops[i].y;
    }
    printf("  ok: 3 list items → 3 bullets at distinct y positions\n");
}

static void test_h1_body_y_ordering(void)
{
    const char *md = "# Title\n\nBody.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op1 = find_op_with_text(&L, "Title");
    const DrawOp *op2 = find_op_with_text(&L, "Body.");
    assert(op1 != NULL);
    assert(op2 != NULL);
    assert(op2->y > op1->y);
    printf("  ok: body paragraph renders below H1\n");
}

static void test_thematic_break_spacing(void)
{
    const char *md = "Before.\n\n---\n\nAfter.\n";
    MdLayout L;
    md_layout_build(md, strlen(md), &L, 400, 12);
    const DrawOp *op1 = find_op_with_text(&L, "Before.");
    const DrawOp *op2 = find_op_with_text(&L, "After.");
    assert(op1 != NULL);
    assert(op2 != NULL);
    assert(op2->y > op1->y);
    printf("  ok: --- thematic break adds spacing between paragraphs\n");
}

/* ------------------------------------------------------------ main */

int main(void)
{
    printf("test_md_parse:\n");
    test_h1_bold_and_size();
    test_h2_size();
    test_h3_size();
    test_body_size_12();
    test_bold_inline();
    test_italic_inline();
    test_inline_code_mono();
    test_unordered_bullet();
    test_ordered_bullet();
    test_blank_line_paragraph_spacing();
    test_heading_below_heading_vertically();
    test_word_wrap_respects_width();
    test_fenced_code_block_mono();
    test_blockquote_italic();
    test_link_shows_underline();
    test_empty_input();
    test_content_height_positive_for_content();
    test_underscore_bold();
    test_underscore_italic();
    test_multiple_bullets_on_different_y();
    test_h1_body_y_ordering();
    test_thematic_break_spacing();
    printf("test_md_parse: PASS\n");
    return 0;
}
