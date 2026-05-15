/*
 * greet.h — public surface of the greet module (cv-mac #100 Phase A).
 *
 * Two functions: one parameterless, one taking a C string. main.c
 * calls both; greet.c implements both. Demonstrates the simplest
 * possible header-driven cross-translation-unit linkage.
 */

#ifndef GREET_H
#define GREET_H

/** Draw "Hello, World!" at the current pen position. */
void greet_world(void);

/** Draw "Hello, <suffix>!" at the current pen position. */
void greet_named(const char *suffix);

#endif /* GREET_H */
