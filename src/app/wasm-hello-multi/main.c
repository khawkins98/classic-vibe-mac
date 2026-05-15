/*
 * main.c — multi-file in-browser-compile demo (cv-mac #100 Phase A).
 *
 * Pairs with greet.c / greet.h. Demonstrates that the in-browser
 * compileToBin pipeline now handles projects with more than one .c
 * file: cc1 + as run once per source, ld links the resulting objects
 * + the libretrocrt/libInterface/libc/libgcc archives.
 *
 * The split is artificial — everything here could trivially live in
 * one file — but the point is to prove the multi-file plumbing works
 * end-to-end. A future "real" multi-file demo will involve a non-
 * trivial split (a UI shell + a domain-engine, say).
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

#include "greet.h"

QDGlobals qd;

int main(void) {
    /* Standard Toolbox init incantation. */
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(0);

    /* Draw two greetings from two different translation units. */
    MoveTo(100, 100);
    greet_world();

    MoveTo(100, 120);
    greet_named("from greet.c");

    /* Wait for a click, then exit. */
    {
        EventRecord ev;
        long sleepTicks = 0x7fffffff;
        while (!WaitNextEvent(mDownMask, &ev, sleepTicks, NULL))
            ;
    }
    return 0;
}
