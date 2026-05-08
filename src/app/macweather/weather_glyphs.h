/*
 * weather_glyphs.h — pixel-honest weather glyphs for QuickDraw.
 *
 * Each glyph is drawn at (x, y) anchored to its top-left corner, scaled
 * loosely by `size` (intended values: 32 for current conditions, 16 for
 * the daily-forecast cells). Drawing happens in the current GrafPort.
 *
 * The dispatch function `WeatherDrawGlyph` maps a WMO weather code to
 * the right rendering function. Codes we don't recognise fall back to
 * a generic "?" glyph (so a fresh open-meteo code addition doesn't make
 * the app paint nothing).
 */

#ifndef WEATHER_GLYPHS_H
#define WEATHER_GLYPHS_H

void WeatherDrawGlyph(unsigned char wmo_code, short x, short y, short size);

#endif /* WEATHER_GLYPHS_H */
