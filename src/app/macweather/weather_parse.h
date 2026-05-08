/*
 * weather_parse.h — minimal JSON parser scoped to open-meteo's response shape.
 *
 * Pure C, no Toolbox dependencies, host-testable via tests/unit/.
 *
 * The function `weather_parse` consumes a buffer of bytes (the JSON response
 * from api.open-meteo.com) and fills a fixed-shape WeatherData struct.
 * It does NOT allocate, does NOT mutate the input, and does NOT cope with
 * arbitrary JSON — only the small subset open-meteo emits for the queries
 * MacWeather makes. Missing fields default to 0; on a totally garbled or
 * empty body, `ok` stays 0 and the rest of the struct is zeroed.
 *
 * The point of having our own parser (rather than pulling cJSON or jsmn) is:
 *   - the dependency surface stays at zero
 *   - the binary stays small (Retro68 link is sensitive)
 *   - we don't have to decide what malloc behaves like in classic Mac OS
 */

#ifndef WEATHER_PARSE_H
#define WEATHER_PARSE_H

#include <stddef.h>

#define WEATHER_DAILY_COUNT 3

typedef struct {
    /* Current conditions. */
    short hour;            /* 0..23, parsed from "T14:00" in current.time */
    short minute;          /* 0..59 */
    short temp_f;          /* rounded from temperature_2m */
    short feels_like_f;    /* rounded from apparent_temperature */
    short wind_mph;        /* rounded from wind_speed_10m */
    unsigned char wind_dir;       /* 0..15 compass octant from wind_direction_10m */
    unsigned char humidity_pct;   /* 0..100, rounded from relative_humidity_2m */
    unsigned char wmo_code;       /* current weather_code */

    /* Forecast (tomorrow, +2, +3). Index 0 in the daily array is "today",
     * which we skip — the user already has "current" for that. */
    struct {
        unsigned char wmo_code;
        short hi_f;        /* rounded temperature_2m_max */
        short lo_f;        /* rounded temperature_2m_min */
        char dow[4];       /* short day-of-week label, e.g. "Tue" + NUL */
    } daily[WEATHER_DAILY_COUNT];

    /* 1 if we successfully parsed at least the current.temperature_2m field;
     * 0 if the body was empty/garbled or the required field was missing. */
    char ok;
} WeatherData;

/*
 * Parse `body` (length `len`) into `out`.
 *
 * Always zeroes `out` first. Returns 1 on success (i.e. ok=1), 0 otherwise.
 * Safe to call with NULL or zero-length input — returns 0.
 */
int weather_parse(const char *body, size_t len, WeatherData *out);

/*
 * Helper exposed for testing: round a float-string to the nearest short.
 * Handles negative numbers, decimals, and leading/trailing whitespace.
 * Returns 0 if the string is empty or doesn't start with a number.
 */
short weather_round_str(const char *s, size_t n);

/*
 * Helper exposed for testing: derive a 3-letter day-of-week abbrev from
 * an ISO date "YYYY-MM-DD". Writes 4 bytes into `out` (3 chars + NUL).
 * On parse failure, writes "???" + NUL. Uses Zeller's congruence so we
 * don't need a calendar library.
 */
void weather_dow_abbrev(const char *iso_date, size_t n, char out[4]);

#endif /* WEATHER_PARSE_H */
