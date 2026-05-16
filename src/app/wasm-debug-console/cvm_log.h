/*
 * cvm_log.h — append-to-host-file logger for the cv-mac Debug Console.
 *
 * The cv-mac IDE's Output panel has a Console tab that polls a file on
 * the Shared (extfs) volume and surfaces new lines in near-real-time.
 * This header provides the Mac-side helpers your app calls to put text
 * into that file.
 *
 * Two ways to pull this in from any cv-mac playground project:
 *
 *   #include <cvm_log.h>      // system header — mounted by cc1.ts on
 *                             // the playground sysroot. Preferred. No
 *                             // need to bundle this file with your
 *                             // project.
 *
 *   #include "cvm_log.h"      // project-local — only works if you've
 *                             // also added cvm_log.h to your project's
 *                             // file list (vite.config.ts SEED_FILES).
 *                             // Useful if you want to read/edit the
 *                             // implementation alongside your own code.
 *
 *   cvm_log("Initialised.");                 // C string (NUL-terminated)
 *   cvm_log_p("\pPlayer scored.");           // Pascal string literal
 *   cvm_log_reset();                         // wipe — useful at app start
 *
 * Implementation: appends to :Unix:__cvm_console.log (BasiliskII surfaces
 * the host's /Shared/ folder as the `Unix` volume; the cvm console
 * watcher polls /Shared/__cvm_console.log every ~1s). Pattern follows
 * the canonical classic-Mac write recipe documented in cv-mac LEARNINGS:
 * HCreate (ignore dupFNErr) -> HOpen(fsWrPerm) -> SetFPos(EOF) -> FSWrite.
 *
 * Functions are `static` so multiple .c files including this header
 * don't fight at link time. The cost is a few hundred bytes per
 * compilation unit; for a debug aid that's fine.
 *
 * Strings cross the browser-to-Mac-Toolbox boundary as MacRoman bytes
 * (cv-mac LEARNINGS 2026-05-16). The watcher decodes high-byte chars
 * for the most common typographic glyphs (smart quotes, em-dash, …,
 * ™/®/©); ASCII (the typical log-line case) is identity-mapped.
 *
 * The header is intentionally dependency-light — Types.h + Files.h +
 * a few helpers. Pulls no new toolbox managers and so safe to include
 * in tiny test apps that haven't called InitGraf etc.
 */

#ifndef CVM_LOG_H
#define CVM_LOG_H

#include <Types.h>
#include <Files.h>
#include <Errors.h>

/* The Pascal-string path to the log file on the extfs `Unix` volume.
 * 24 chars = max 25-byte Pascal string. Bytes: length prefix (24),
 * then ":Unix:__cvm_console.log". */
#define CVM_LOG_PATH_ "\p:Unix:__cvm_console.log"

/* Append `count` bytes from `buf` to the log file. Returns noErr on
 * success or the OSErr from whichever step failed. Quiet on failure
 * (no alert) — Debug Console is by definition non-essential. */
static OSErr cvm_log_write_(const void *buf, long count)
{
    Str255 path;
    short refNum;
    long  eof;
    OSErr err;
    int i;
    const char *src = CVM_LOG_PATH_;

    /* Pascal-string copy of the path (the Toolbox APIs take a writeable
     * StringPtr in many places; safer to make our own copy than to cast
     * away the const of a literal). */
    path[0] = (unsigned char) src[0];
    for (i = 1; i <= (int) path[0]; i++) path[i] = src[i];

    /* Best-effort create. dupFNErr (-48) just means the file already
     * exists, which is the happy path for the second-and-later calls. */
    err = HCreate(0, 0, path, 'CVMC', 'TEXT');
    if (err != noErr && err != dupFNErr) return err;

    err = HOpen(0, 0, path, fsWrPerm, &refNum);
    if (err != noErr) return err;

    err = GetEOF(refNum, &eof);
    if (err != noErr) { FSClose(refNum); return err; }
    err = SetFPos(refNum, fsFromStart, eof);
    if (err != noErr) { FSClose(refNum); return err; }

    err = FSWrite(refNum, &count, (Ptr) buf);
    FSClose(refNum);
    return err;
}

/* cvm_log — append a NUL-terminated C string + newline to the console. */
static OSErr cvm_log(const char *s)
{
    long len = 0;
    if (s) while (s[len]) len++;
    if (len > 0) {
        OSErr err = cvm_log_write_(s, len);
        if (err != noErr) return err;
    }
    return cvm_log_write_("\n", 1);
}

/* cvm_log_p — append a Pascal string literal + newline to the console.
 *   cvm_log_p("\pHello");
 * The leading length byte is skipped automatically. */
static OSErr cvm_log_p(ConstStr255Param s)
{
    if (!s) return paramErr;
    if (s[0] > 0) {
        OSErr err = cvm_log_write_(&s[1], (long) s[0]);
        if (err != noErr) return err;
    }
    return cvm_log_write_("\n", 1);
}

/* cvm_log_reset — truncate the log file. Useful at app startup so each
 * run shows only its own output. The watcher detects the truncation
 * and wipes its UI accordingly. */
static OSErr cvm_log_reset(void)
{
    Str255 path;
    int i;
    const char *src = CVM_LOG_PATH_;
    path[0] = (unsigned char) src[0];
    for (i = 1; i <= (int) path[0]; i++) path[i] = src[i];

    /* HDelete returns fnfErr (-43) if the file isn't there; that's fine
     * — there was nothing to clear in the first place. */
    OSErr err = HDelete(0, 0, path);
    if (err == fnfErr) return noErr;
    return err;
}

#endif /* CVM_LOG_H */
