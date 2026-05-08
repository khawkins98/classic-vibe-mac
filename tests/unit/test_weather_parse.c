/*
 * test_weather_parse.c — host-compiled unit tests for weather_parse.c.
 *
 * Compiles with the host gcc/clang. No Mac Toolbox involvement.
 */

#include <assert.h>
#include <stdio.h>
#include <string.h>

#include "weather_parse.h"

static const char *SAMPLE_FULL =
    "{"
      "\"current\":{"
        "\"time\":\"2026-05-08T14:00\","
        "\"temperature_2m\":53.4,"
        "\"apparent_temperature\":49.2,"
        "\"weather_code\":2,"
        "\"wind_speed_10m\":8.3,"
        "\"wind_direction_10m\":315,"
        "\"relative_humidity_2m\":67"
      "},"
      "\"daily\":{"
        "\"time\":[\"2026-05-08\",\"2026-05-09\",\"2026-05-10\",\"2026-05-11\"],"
        "\"temperature_2m_max\":[60.1,58.0,51.3,60.2],"
        "\"temperature_2m_min\":[42.0,42.5,38.4,45.1],"
        "\"weather_code\":[2,3,61,0]"
      "}"
    "}";

static void test_parses_full_response(void)
{
    WeatherData w;
    int r = weather_parse(SAMPLE_FULL, strlen(SAMPLE_FULL), &w);
    assert(r == 1);
    assert(w.ok == 1);
    assert(w.hour == 14);
    assert(w.minute == 0);
    assert(w.temp_f == 53);
    assert(w.feels_like_f == 49);
    assert(w.wmo_code == 2);
    assert(w.wind_mph == 8);
    /* 315° → octant 14 (NW). 22.5° per slot, 315/22.5 = 14. */
    assert(w.wind_dir == 14);
    assert(w.humidity_pct == 67);

    /* Daily index 1 (tomorrow, 2026-05-09 = Sat) → out->daily[0]. */
    assert(w.daily[0].hi_f == 58);   /* 58.0 → 58 */
    assert(w.daily[0].lo_f == 43);   /* 42.5 rounds up */
    assert(w.daily[0].wmo_code == 3);
    /* 2026-05-09 is Saturday. */
    assert(strcmp(w.daily[0].dow, "Sat") == 0);

    assert(w.daily[1].hi_f == 51);
    assert(w.daily[1].lo_f == 38);
    assert(w.daily[1].wmo_code == 61);
    assert(strcmp(w.daily[1].dow, "Sun") == 0);

    assert(w.daily[2].hi_f == 60);
    assert(w.daily[2].lo_f == 45);
    assert(w.daily[2].wmo_code == 0);
    assert(strcmp(w.daily[2].dow, "Mon") == 0);
    printf("  ok: parses the open-meteo example response shape\n");
}

static void test_missing_fields_dont_crash(void)
{
    /* Just current.temperature_2m present — others should default to 0. */
    const char *partial = "{\"current\":{\"temperature_2m\":42.0}}";
    WeatherData w;
    int r = weather_parse(partial, strlen(partial), &w);
    assert(r == 1);
    assert(w.ok == 1);
    assert(w.temp_f == 42);
    assert(w.feels_like_f == 0);
    assert(w.wmo_code == 0);
    assert(w.wind_mph == 0);
    assert(w.daily[0].hi_f == 0);
    assert(w.daily[0].lo_f == 0);
    printf("  ok: missing fields default to 0, ok=1\n");
}

static void test_empty_body(void)
{
    WeatherData w;
    int r = weather_parse(NULL, 0, &w);
    assert(r == 0);
    assert(w.ok == 0);

    r = weather_parse("", 0, &w);
    assert(r == 0);
    assert(w.ok == 0);

    r = weather_parse("not json at all", 15, &w);
    assert(r == 0);
    assert(w.ok == 0);
    printf("  ok: empty/garbled body returns ok=0\n");
}

static void test_rounding(void)
{
    /* 53.4 → 53, 53.6 → 54, 53.5 → 54, -1.6 → -2. */
    assert(weather_round_str("53.4", 4) == 53);
    assert(weather_round_str("53.6", 4) == 54);
    assert(weather_round_str("53.5", 4) == 54);
    assert(weather_round_str("-1.6", 4) == -2);
    assert(weather_round_str("0", 1) == 0);
    assert(weather_round_str("-0.5", 4) == -1);   /* -0.5 actually rounds to -1 with our digit-only check; documents the behavior */
    assert(weather_round_str("100", 3) == 100);
    assert(weather_round_str("", 0) == 0);
    assert(weather_round_str("abc", 3) == 0);
    printf("  ok: rounding works for positive/negative/integers/edge cases\n");
}

static void test_dow_abbrev(void)
{
    char out[4];
    /* 2026-05-08 is a Friday. */
    weather_dow_abbrev("2026-05-08", 10, out);
    assert(strcmp(out, "Fri") == 0);
    weather_dow_abbrev("2026-05-09", 10, out);
    assert(strcmp(out, "Sat") == 0);
    /* 2024-01-01 is a Monday. */
    weather_dow_abbrev("2024-01-01", 10, out);
    assert(strcmp(out, "Mon") == 0);
    /* Garbled: write "???". */
    weather_dow_abbrev("garbage", 7, out);
    assert(strcmp(out, "???") == 0);
    printf("  ok: ISO date → 3-letter day-of-week\n");
}

static void test_wind_octant(void)
{
    /* Most-lazy way to spot-check the octant mapping is via parse(). */
    const char *zero  = "{\"current\":{\"temperature_2m\":1,\"wind_direction_10m\":0}}";
    const char *east  = "{\"current\":{\"temperature_2m\":1,\"wind_direction_10m\":90}}";
    const char *south = "{\"current\":{\"temperature_2m\":1,\"wind_direction_10m\":180}}";
    const char *west  = "{\"current\":{\"temperature_2m\":1,\"wind_direction_10m\":270}}";
    const char *almost_north = "{\"current\":{\"temperature_2m\":1,\"wind_direction_10m\":355}}";
    WeatherData w;
    weather_parse(zero, strlen(zero), &w);   assert(w.wind_dir == 0);
    weather_parse(east, strlen(east), &w);   assert(w.wind_dir == 4);
    weather_parse(south, strlen(south), &w); assert(w.wind_dir == 8);
    weather_parse(west, strlen(west), &w);   assert(w.wind_dir == 12);
    /* 355° rounds to 0 (north). */
    weather_parse(almost_north, strlen(almost_north), &w); assert(w.wind_dir == 0);
    printf("  ok: wind_direction_10m → 16-point compass octant\n");
}

static void test_extra_whitespace_and_newlines(void)
{
    /* Open-meteo emits compact JSON, but make sure pretty-printed input
     * also parses. */
    const char *pretty =
        "{\n"
        "  \"current\": {\n"
        "    \"time\": \"2026-05-08T09:30\",\n"
        "    \"temperature_2m\": 22.7\n"
        "  }\n"
        "}\n";
    WeatherData w;
    int r = weather_parse(pretty, strlen(pretty), &w);
    assert(r == 1);
    assert(w.hour == 9);
    assert(w.minute == 30);
    assert(w.temp_f == 23);
    printf("  ok: handles pretty-printed JSON with whitespace/newlines\n");
}

int main(void)
{
    printf("test_weather_parse:\n");
    test_parses_full_response();
    test_missing_fields_dont_crash();
    test_empty_body();
    test_rounding();
    test_dow_abbrev();
    test_wind_octant();
    test_extra_whitespace_and_newlines();
    printf("test_weather_parse: PASS\n");
    return 0;
}
