/*
 * gallery.c — open icons.rsrc and load the ICN# resources at
 * IDs 128–133 into memory. This is the file that exercises the
 * splice infrastructure from #251: the resource file lives on
 * the disk alongside the app (shipped via PatchOptions.extraFiles
 * with resourceFork populated), and we use the standard Resource
 * Manager to read it at runtime.
 *
 * `OpenResFile` searches the current working directory by default,
 * which on classic Mac is the directory the app launched from —
 * which is our volume root, where the build pipeline drops both
 * the app and the icons.rsrc file. So a bare filename works.
 */

#include <Files.h>
#include <Resources.h>
#include "gallery.h"

const char *kIconNames[ICON_COUNT] = {
    "Heart", "Star", "Diamond", "Circle", "Triangle", "Square"
};

static short gResFile = -1;
static Handle gIcons[ICON_COUNT];

/* Helper: build a Pascal string in a fixed-size buffer for OpenResFile. */
static void CStrToPString(const char *src, Str255 dst) {
    short i = 0;
    while (src[i] != '\0' && i < 255) {
        dst[i + 1] = (unsigned char)src[i];
        i++;
    }
    dst[0] = (unsigned char)i;
}

Boolean GalleryOpen(void) {
    Str255 fname;
    short i;
    CStrToPString("Icons", fname);
    gResFile = OpenResFile(fname);
    if (gResFile == -1) {
        return false;
    }
    /* Force the new file to be the search-order top so GetResource
     * picks our ICN#s, not any same-ID resources from System or
     * the app's own fork. */
    UseResFile(gResFile);
    for (i = 0; i < ICON_COUNT; i++) {
        gIcons[i] = GetResource('ICN#', FIRST_ICON_ID + i);
        if (gIcons[i] == NULL) {
            /* Partial load — caller decides; we report success only on
             * a fully-loaded gallery. */
            return false;
        }
    }
    return true;
}

Handle GalleryIcon(short index) {
    if (index < 0 || index >= ICON_COUNT) return NULL;
    return gIcons[index];
}

void GalleryClose(void) {
    if (gResFile != -1) {
        CloseResFile(gResFile);
        gResFile = -1;
    }
}
