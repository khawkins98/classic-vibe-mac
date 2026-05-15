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

/* Append a C string to a Pascal-string buffer. Caller guarantees the
 * destination has room. Returns the new total length. We use this
 * inside greet_named to build "Hello, <suffix>" on the fly. */
static unsigned char *pstrcpy(unsigned char *dst, const char *src) {
    unsigned char *p = dst;
    while (*src) *p++ = (unsigned char)*src++;
    return p;
}

void greet_world(void) {
    DrawString(HELLO_WORLD);
}

void greet_named(const char *suffix) {
    unsigned char buf[64];
    unsigned char *p = buf + 1;
    p = pstrcpy(p, "Hello, ");
    p = pstrcpy(p, suffix);
    *p++ = '!';
    buf[0] = (unsigned char)((p - buf) - 1);
    DrawString(buf);
}
