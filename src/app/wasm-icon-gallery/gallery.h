/*
 * gallery.h — wasm-icon-gallery shared types (cv-mac #233 6-star tier).
 *
 * Three modules:
 *   main.c    — Toolbox init, event loop, About menu
 *   gallery.c — opens "Icons" rsrc file, holds the icon handles
 *   render.c  — draws the 3×2 grid in the window
 */

#ifndef WASM_ICON_GALLERY_H
#define WASM_ICON_GALLERY_H

#include <Types.h>
#include <Resources.h>
#include <Quickdraw.h>

/* The six icons baked into icons.rsrc.bin by
 * scripts/build-icon-gallery-rsrc.mjs. Resource IDs start at 128. */
#define ICON_COUNT       6
#define FIRST_ICON_ID    128

/* Names rendered as labels under each icon. Same order as the
 * generator's `order` array. */
extern const char *kIconNames[ICON_COUNT];

/* Window dimensions (matches arkanoid's 360×280 footprint). */
#define WINDOW_ID        128
#define WIN_W            360
#define WIN_H            280

/* Grid layout — 3 columns × 2 rows; icons are 32 × 32 with text
 * label below; cell is 100 px wide × 80 px tall; centred in the
 * window's content area. */
#define GRID_COLS        3
#define GRID_ROWS        2
#define CELL_W           100
#define CELL_H           80
#define GRID_LEFT        30
#define GRID_TOP         40
#define ICON_SIZE        32

/* ── Gallery (resource loading) ────────────────────────────────── */

/** Open icons.rsrc and load all six icons. Returns false if any
 *  step fails — main.c shows an alert in that case. */
Boolean GalleryOpen(void);

/** Returns the loaded icon handle for icon index 0..ICON_COUNT-1,
 *  or NULL if the resource wasn't loaded. */
Handle GalleryIcon(short index);

/** Close the resource file (release at app exit). */
void GalleryClose(void);

/* ── Rendering ─────────────────────────────────────────────────── */

/** Repaint the entire window. */
void RenderGallery(void);

#endif /* WASM_ICON_GALLERY_H */
