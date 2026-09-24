/*
 * greet.c — implementation of the greet module (cv-mac #100 Phase A).
 *
 * Lives in its own translation unit so the in-browser compileToBin
 * pipeline has to actually compile two .c files and link the two
 * resulting .o's together. The Pascal-string helpers below are
 * deliberately tiny to keep this file focused on "the second .c is
 * really being compiled."
 */

#include <Types.h>
#include <Quickdraw.h>

#include "greet.h"

/* Pascal "Hello, World!" — byte 0 is length. */
static const unsigned char HELLO_WORLD[] = {
    13, 'H', 'e', 'l', 'l', 'o', ',', ' ',
    'W', 'o', 'r', 'l', 'd', '!',
};

/* Append a C string at `dst`, stopping at `end` so a long suffix can't
 * overflow the caller's fixed-size buffer. Returns the new write
 * position. We use this inside greet_named to build "Hello, <suffix>!"
 * on the fly. */
static unsigned char *pstrcpy(unsigned char *dst, const unsigned char *end,
                              const char *src) {
    unsigned char *p = dst;
    while (*src && p < end) *p++ = (unsigned char)*src++;
    return p;
}

void greet_world(void) {
    DrawString(HELLO_WORLD);
}

void greet_named(const char *suffix) {
    unsigned char buf[64];
    /* Stop one byte short of the end to leave room for the closing '!'. */
    const unsigned char *end = buf + sizeof(buf) - 1;
    unsigned char *p = buf + 1;          /* byte 0 holds the length */
    p = pstrcpy(p, end, "Hello, ");
    p = pstrcpy(p, end, suffix);
    *p++ = '!';
    buf[0] = (unsigned char)((p - buf) - 1);
    DrawString(buf);
}
