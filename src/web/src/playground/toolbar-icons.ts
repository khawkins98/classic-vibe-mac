/**
 * toolbar-icons.ts — hand-drawn 16×16 pixel-art SVG icons for the
 * Playground build toolbar (cv-mac #229 item 1).
 *
 * The ticket: "emoji are the single biggest immersion-breaker. Real
 * Platinum icons were 1-bit (sometimes 4-bit color) 16×16 pixel art,
 * hand-drawn. Replacing the four emoji with hand-drawn 16×16 SVGs
 * […] is the highest-impact single visual change in the IDE."
 *
 * Each icon is a 16×16 viewBox SVG with `shape-rendering="crispEdges"`
 * so paths render as 1-bit pixel art (no anti-aliasing) — the period-
 * appropriate look. `fill="currentColor"` lets the buttons control
 * the color through CSS (matches `.cvm-pg-iconbtn` text color).
 *
 * Icons:
 *   - build       hammer (head + diagonal handle)
 *   - buildrun    rightward-pointing solid play triangle
 *   - download    classic 3.5" floppy disk silhouette
 *   - reset       curved-arrow / refresh glyph
 *   - showasm     CPU/chip with pin marks
 *
 * These are intentionally chunky — Mac OS 8 icon designers aimed for
 * recognizability at glyph-height (12–18 px), not delicate filigree.
 * Each shape is composed of integer-coordinate rects/polygons so the
 * pixel grid stays honest at the 14 px the toolbar renders them at.
 */

export const ICON_BUILD = /* html */ `
  <svg viewBox="0 0 16 16" shape-rendering="crispEdges"
       focusable="false" aria-hidden="true">
    <!-- hammer head: 6 wide, 4 tall, top-right corner -->
    <rect x="8" y="2" width="6" height="4" fill="currentColor"/>
    <!-- claw slot (white pixel in the head) -->
    <rect x="13" y="3" width="1" height="2" fill="#ffffff"/>
    <!-- diagonal handle, 2 px thick, from head down to bottom-left -->
    <rect x="9" y="6" width="2" height="1" fill="currentColor"/>
    <rect x="8" y="7" width="2" height="1" fill="currentColor"/>
    <rect x="7" y="8" width="2" height="1" fill="currentColor"/>
    <rect x="6" y="9" width="2" height="1" fill="currentColor"/>
    <rect x="5" y="10" width="2" height="1" fill="currentColor"/>
    <rect x="4" y="11" width="2" height="1" fill="currentColor"/>
    <rect x="3" y="12" width="2" height="1" fill="currentColor"/>
    <rect x="2" y="13" width="2" height="1" fill="currentColor"/>
  </svg>
`;

export const ICON_BUILDRUN = /* html */ `
  <svg viewBox="0 0 16 16" shape-rendering="crispEdges"
       focusable="false" aria-hidden="true">
    <!-- Right-pointing solid play triangle, drawn as horizontal
         scanlines for crisp pixel-art edges. -->
    <rect x="4" y="3" width="2" height="10" fill="currentColor"/>
    <rect x="6" y="4" width="2" height="8" fill="currentColor"/>
    <rect x="8" y="5" width="2" height="6" fill="currentColor"/>
    <rect x="10" y="6" width="2" height="4" fill="currentColor"/>
    <rect x="12" y="7" width="1" height="2" fill="currentColor"/>
  </svg>
`;

export const ICON_DOWNLOAD = /* html */ `
  <svg viewBox="0 0 16 16" shape-rendering="crispEdges"
       focusable="false" aria-hidden="true">
    <!-- Classic 3.5" floppy disk silhouette. Outer body 12×14, with
         a metal shutter at the top and a paper label in the lower half. -->
    <!-- body outline (top, bottom, left, right) -->
    <rect x="2" y="1" width="12" height="1" fill="currentColor"/>
    <rect x="2" y="14" width="12" height="1" fill="currentColor"/>
    <rect x="2" y="1" width="1" height="14" fill="currentColor"/>
    <rect x="13" y="1" width="1" height="14" fill="currentColor"/>
    <!-- metal shutter (filled rect across top, with small slot) -->
    <rect x="4" y="2" width="8" height="4" fill="currentColor"/>
    <rect x="9" y="3" width="2" height="2" fill="#ffffff"/>
    <!-- label area (outlined rectangle in the lower half) -->
    <rect x="3" y="7" width="10" height="1" fill="currentColor"/>
    <rect x="3" y="13" width="10" height="1" fill="currentColor"/>
    <rect x="3" y="7" width="1" height="6" fill="currentColor"/>
    <rect x="12" y="7" width="1" height="6" fill="currentColor"/>
    <!-- one label "text" line for affordance -->
    <rect x="5" y="10" width="6" height="1" fill="currentColor"/>
  </svg>
`;

export const ICON_RESET = /* html */ `
  <svg viewBox="0 0 16 16" shape-rendering="crispEdges"
       focusable="false" aria-hidden="true">
    <!-- Curved-arrow refresh glyph: a ~270° arc with a small
         arrowhead at one end. Drawn from chunky 2×1 / 1×2 rects so
         the arc reads as 1-bit pixel art rather than a smooth
         anti-aliased SVG path. -->
    <!-- top arc -->
    <rect x="6" y="2" width="4" height="1" fill="currentColor"/>
    <rect x="4" y="3" width="2" height="1" fill="currentColor"/>
    <rect x="10" y="3" width="2" height="1" fill="currentColor"/>
    <rect x="3" y="4" width="1" height="2" fill="currentColor"/>
    <rect x="12" y="4" width="1" height="2" fill="currentColor"/>
    <!-- left + right sides -->
    <rect x="2" y="6" width="1" height="4" fill="currentColor"/>
    <rect x="13" y="6" width="1" height="4" fill="currentColor"/>
    <!-- bottom arc -->
    <rect x="3" y="10" width="1" height="2" fill="currentColor"/>
    <rect x="12" y="10" width="1" height="2" fill="currentColor"/>
    <rect x="4" y="12" width="2" height="1" fill="currentColor"/>
    <rect x="10" y="12" width="2" height="1" fill="currentColor"/>
    <rect x="6" y="13" width="4" height="1" fill="currentColor"/>
    <!-- arrow break at top-right (open the loop) -->
    <rect x="10" y="2" width="3" height="1" fill="#ffffff"/>
    <rect x="11" y="3" width="2" height="1" fill="#ffffff"/>
    <!-- arrowhead pointing down-left at the break -->
    <rect x="9" y="3" width="1" height="1" fill="currentColor"/>
    <rect x="9" y="4" width="2" height="1" fill="currentColor"/>
    <rect x="10" y="5" width="1" height="1" fill="currentColor"/>
  </svg>
`;

export const ICON_SHOWASM = /* html */ `
  <svg viewBox="0 0 16 16" shape-rendering="crispEdges"
       focusable="false" aria-hidden="true">
    <!-- Microchip / CPU silhouette: a square body with short "pins"
         on all four sides. Reads as "code/assembly" without leaning
         on the gear glyph (gears suggest settings, not output). -->
    <!-- body outline -->
    <rect x="4" y="4" width="8" height="1" fill="currentColor"/>
    <rect x="4" y="11" width="8" height="1" fill="currentColor"/>
    <rect x="4" y="4" width="1" height="8" fill="currentColor"/>
    <rect x="11" y="4" width="1" height="8" fill="currentColor"/>
    <!-- centre dot (orientation mark, like a real chip's pin-1 dot) -->
    <rect x="6" y="6" width="2" height="2" fill="currentColor"/>
    <!-- top pins -->
    <rect x="5" y="2" width="1" height="2" fill="currentColor"/>
    <rect x="7" y="2" width="1" height="2" fill="currentColor"/>
    <rect x="9" y="2" width="1" height="2" fill="currentColor"/>
    <!-- bottom pins -->
    <rect x="5" y="12" width="1" height="2" fill="currentColor"/>
    <rect x="7" y="12" width="1" height="2" fill="currentColor"/>
    <rect x="9" y="12" width="1" height="2" fill="currentColor"/>
    <!-- left pins -->
    <rect x="2" y="5" width="2" height="1" fill="currentColor"/>
    <rect x="2" y="7" width="2" height="1" fill="currentColor"/>
    <rect x="2" y="9" width="2" height="1" fill="currentColor"/>
    <!-- right pins -->
    <rect x="12" y="5" width="2" height="1" fill="currentColor"/>
    <rect x="12" y="7" width="2" height="1" fill="currentColor"/>
    <rect x="12" y="9" width="2" height="1" fill="currentColor"/>
  </svg>
`;
