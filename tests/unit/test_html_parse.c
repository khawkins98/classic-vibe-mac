/*
 * test_html_parse.c — host-compiled unit tests for html_parse.c.
 *
 * Compiles with the host gcc/clang. No Mac Toolbox involvement.
 */

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "html_parse.h"

/* ------------------------------------------------------------ helpers */

static int has_op_with_text(const HtmlLayout *L, const char *want, unsigned char face_mask)
{
    size_t want_len = strlen(want);
    for (int i = 0; i < L->op_count; i++) {
        const DrawOp *op = &L->ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len != want_len) continue;
        if (memcmp(L->strpool + op->text_off, want, want_len) != 0) continue;
        if ((op->face & face_mask) == face_mask) return 1;
    }
    return 0;
}

static int count_ops_kind(const HtmlLayout *L, DrawOpKind kind)
{
    int n = 0;
    for (int i = 0; i < L->op_count; i++) if (L->ops[i].kind == kind) n++;
    return n;
}

/* ------------------------------------------------------------ tests */

static void test_tokenize_basic_tags(void)
{
    const char *html = "<p>hello</p><br><div>x</div>";
    HtmlTokenList toks;
    html_tokenize(html, strlen(html), &toks);

    /* Expected sequence: <p> open, "hello" text, </p> close, <br> self,
     * <div> open (UNKNOWN), "x" text, </div> close (UNKNOWN). */
    assert(toks.count == 7);
    assert(toks.tokens[0].kind == HTML_TOK_TAG_OPEN);
    assert(toks.tokens[0].tag == HTML_TAG_P);
    assert(toks.tokens[1].kind == HTML_TOK_TEXT);
    assert(toks.tokens[1].text_len == 5);
    assert(memcmp(toks.tokens[1].text, "hello", 5) == 0);
    assert(toks.tokens[2].kind == HTML_TOK_TAG_CLOSE);
    assert(toks.tokens[2].tag == HTML_TAG_P);
    assert(toks.tokens[3].kind == HTML_TOK_TAG_SELF);
    assert(toks.tokens[3].tag == HTML_TAG_BR);
    assert(toks.tokens[4].kind == HTML_TOK_TAG_OPEN);
    assert(toks.tokens[4].tag == HTML_TAG_UNKNOWN);
    assert(toks.tokens[5].kind == HTML_TOK_TEXT);
    assert(toks.tokens[6].kind == HTML_TOK_TAG_CLOSE);
    printf("  ok: tokenize basic tags (open/close/self/text)\n");
}

static void test_tag_id_case_insensitive(void)
{
    assert(html_tag_id("P", 1)       == HTML_TAG_P);
    assert(html_tag_id("p", 1)       == HTML_TAG_P);
    assert(html_tag_id("STRONG", 6)  == HTML_TAG_STRONG);
    assert(html_tag_id("strong", 6)  == HTML_TAG_STRONG);
    assert(html_tag_id("xyz", 3)     == HTML_TAG_UNKNOWN);
    printf("  ok: tag id is case-insensitive\n");
}

static void test_layout_simple_h1_p(void)
{
    const char *html = "<h1>Title</h1><p>Body.</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);

    /* Title must appear bold; body must appear non-bold. */
    assert(has_op_with_text(&layout, "Title", DRAW_FACE_BOLD));
    int found_body_plain = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len == 5 &&
            memcmp(layout.strpool + op->text_off, "Body.", 5) == 0) {
            assert((op->face & DRAW_FACE_BOLD) == 0);
            found_body_plain = 1;
        }
    }
    assert(found_body_plain);

    /* Heading font size > body. */
    int title_size = 0, body_size = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len == 5 && memcmp(layout.strpool + op->text_off, "Title", 5) == 0)
            title_size = op->font_size;
        if (op->text_len == 5 && memcmp(layout.strpool + op->text_off, "Body.", 5) == 0)
            body_size = op->font_size;
    }
    assert(title_size > body_size);
    assert(body_size == 12);

    /* Body must sit below the heading. */
    short title_y = 0, body_y = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->text_len == 5 && memcmp(layout.strpool + op->text_off, "Title", 5) == 0)
            title_y = op->y;
        if (op->text_len == 5 && memcmp(layout.strpool + op->text_off, "Body.", 5) == 0)
            body_y = op->y;
    }
    assert(body_y > title_y);
    printf("  ok: layout <h1> + <p> emits bold heading + plain body, body below heading\n");
}

static void test_word_wrap_respects_width(void)
{
    /* A run wider than the content width MUST wrap onto more than one
     * baseline. With body=12, ~6px/char, "word " ~30px each → 50 words
     * is ~1500px; in a 120px box we expect many lines. */
    const char *html =
        "<p>"
        "alpha bravo charlie delta echo foxtrot golf hotel india juliet "
        "kilo lima mike november oscar papa quebec romeo sierra tango"
        "</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 120, 12);

    short min_y = 0x7FFF, max_y = -1;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        if (op->y < min_y) min_y = op->y;
        if (op->y > max_y) max_y = op->y;
    }
    assert(max_y > min_y);
    /* Every text op's right edge must be inside (or at) the content width
     * once we've allowed for the first word on a line. (Long single tokens
     * can exceed width by design — none of the words above are >120px.) */
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        assert(op->x + op->width <= layout.content_width + 8);
    }
    printf("  ok: word-wrap respects content width\n");
}

static void test_link_region(void)
{
    const char *html = "<p>see <a href=\"about.html\">about</a> please</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);

    int link_count = count_ops_kind(&layout, DRAW_OP_LINK_REGION);
    assert(link_count >= 1);

    /* Find the LINK_REGION and check its href. */
    int found = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_LINK_REGION) continue;
        assert(op->href_len == strlen("about.html"));
        assert(memcmp(layout.strpool + op->href_off, "about.html", op->href_len) == 0);
        assert(op->link_right > op->link_left);
        assert(op->link_bottom > op->link_top);
        /* Hit-test inside the region returns this index. */
        short hx = (short)((op->link_left + op->link_right) / 2);
        short hy = (short)((op->link_top + op->link_bottom) / 2);
        assert(html_layout_hit_link(&layout, hx, hy) == i);
        /* Hit-test far outside returns -1. */
        assert(html_layout_hit_link(&layout, -100, -100) == -1);
        found = 1;
    }
    assert(found);

    /* The "about" word must be drawn with underline. */
    assert(has_op_with_text(&layout, "about", DRAW_FACE_UNDERLINE));
    printf("  ok: <a href> recorded as link region with correct href + bounds\n");
}

static void test_nested_formatting(void)
{
    const char *html = "<p>This is <b>bold and <i>italic</i></b>.</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);

    /* "This" is plain (no bold/italic). */
    int saw_plain = 0, saw_bold = 0, saw_bold_italic = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        const char *s = layout.strpool + op->text_off;
        if (op->text_len == 4 && memcmp(s, "This", 4) == 0) {
            assert((op->face & DRAW_FACE_BOLD) == 0);
            assert((op->face & DRAW_FACE_ITALIC) == 0);
            saw_plain = 1;
        }
        if (op->text_len == 4 && memcmp(s, "bold", 4) == 0) {
            assert(op->face & DRAW_FACE_BOLD);
            assert((op->face & DRAW_FACE_ITALIC) == 0);
            saw_bold = 1;
        }
        if (op->text_len == 6 && memcmp(s, "italic", 6) == 0) {
            assert(op->face & DRAW_FACE_BOLD);
            assert(op->face & DRAW_FACE_ITALIC);
            saw_bold_italic = 1;
        }
    }
    assert(saw_plain);
    assert(saw_bold);
    assert(saw_bold_italic);
    printf("  ok: nested <b>/<i> emits correct face mask per word\n");
}

static void test_unknown_tags_render_text(void)
{
    /* <span> isn't supported; its text content must still appear. */
    const char *html = "<p>before <span class=\"x\">middle</span> after</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);
    assert(has_op_with_text(&layout, "before", 0));
    assert(has_op_with_text(&layout, "middle", 0));
    assert(has_op_with_text(&layout, "after",  0));
    printf("  ok: unknown tags are dropped, their text still renders\n");
}

static void test_br_breaks_line(void)
{
    const char *html = "<p>line1<br>line2</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);
    short y1 = 0, y2 = 0;
    for (int i = 0; i < layout.op_count; i++) {
        const DrawOp *op = &layout.ops[i];
        if (op->kind != DRAW_OP_TEXT) continue;
        const char *s = layout.strpool + op->text_off;
        if (op->text_len == 5 && memcmp(s, "line1", 5) == 0) y1 = op->y;
        if (op->text_len == 5 && memcmp(s, "line2", 5) == 0) y2 = op->y;
    }
    assert(y1 > 0);
    assert(y2 > y1);
    printf("  ok: <br> advances baseline\n");
}

static void test_empty_input(void)
{
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(NULL, 0, &toks);
    assert(toks.count == 0);
    html_layout_build(&toks, &layout, 400, 12);
    assert(layout.op_count == 0);

    html_tokenize("", 0, &toks);
    assert(toks.count == 0);
    printf("  ok: empty input produces empty layout, no crash\n");
}

static void test_ul_li_emits_bullets(void)
{
    const char *html = "<ul><li>one</li><li>two</li></ul>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);
    assert(count_ops_kind(&layout, DRAW_OP_BULLET) == 2);
    assert(has_op_with_text(&layout, "one", 0));
    assert(has_op_with_text(&layout, "two", 0));
    printf("  ok: <ul><li> emits bullets and items\n");
}

static void test_entities_decode(void)
{
    const char *html = "<p>tom&amp;jerry</p>";
    HtmlTokenList toks;
    HtmlLayout    layout;
    html_tokenize(html, strlen(html), &toks);
    html_layout_build(&toks, &layout, 400, 12);
    assert(has_op_with_text(&layout, "tom&jerry", 0));
    printf("  ok: &amp; decoded to '&' in word output\n");
}

int main(void)
{
    printf("test_html_parse:\n");
    test_tokenize_basic_tags();
    test_tag_id_case_insensitive();
    test_layout_simple_h1_p();
    test_word_wrap_respects_width();
    test_link_region();
    test_nested_formatting();
    test_unknown_tags_render_text();
    test_br_breaks_line();
    test_empty_input();
    test_ul_li_emits_bullets();
    test_entities_decode();
    printf("test_html_parse: PASS\n");
    return 0;
}
