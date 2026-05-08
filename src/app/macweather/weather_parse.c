/*
 * weather_parse.c — minimal hand-rolled JSON parser for open-meteo responses.
 *
 * Scope choice up front: this is NOT a generic JSON parser. We don't
 * walk the JSON tree, build an AST, or normalise types. We just scan
 * for the literal byte sequences `"key":` we know we want, and read the
 * value that follows as either a number, a string, or a small array.
 * That's enough for open-meteo's response shape and a fraction of the
 * code (and binary footprint) of cJSON or jsmn — both of which we
 * tried briefly and abandoned for binary-size reasons (Retro68 link is
 * sensitive on a 1 MB heap budget).
 *
 * If you point this at a different JSON API, this code won't help —
 * but it also won't crash. Missing keys default to zero, the
 * `WeatherData.ok` flag stays 0, and the UI shows "Waiting...".
 *
 * Pure C, no Toolbox dependencies. Compiles under Retro68 (m68k) for
 * the Mac and the host toolchain for unit tests
 * (tests/unit/test_weather_parse.c).
 *
 * We pluck the specific fields MacWeather queries:
 *
 *   current.time                    "2026-05-08T14:00"  → hour, minute
 *   current.temperature_2m          53.4                → temp_f (rounded)
 *   current.apparent_temperature    49.2                → feels_like_f
 *   current.weather_code            2                   → wmo_code
 *   current.wind_speed_10m          8.3                 → wind_mph
 *   current.wind_direction_10m      315                 → wind_dir (octant)
 *   current.relative_humidity_2m    67                  → humidity_pct
 *   daily.time[]                    ["2026-05-08", …]  → dow labels
 *   daily.temperature_2m_max[]      [60.1, …]           → hi_f
 *   daily.temperature_2m_min[]      [42.0, …]           → lo_f
 *   daily.weather_code[]            [2, …]              → wmo_code per day
 *
 * Strategy: linear scan looking for the literal key (with surrounding
 * `"`s); read the immediately following JSON value as a number, string,
 * or array of numbers/strings depending on the key.
 *
 * Limitations:
 *   - Doesn't handle Unicode escapes in strings (open-meteo doesn't emit
 *     any in our queries).
 *   - Treats nesting loosely. If a key is shadowed by an identical key in
 *     a different object, we take whichever comes first in the buffer
 *     after the "current" / "daily" containing key.
 *   - Doesn't decode \" or \\ in date strings (none in practice).
 */

#include "weather_parse.h"

#include <string.h>
#include <stddef.h>

/* ------------------------------------------------------------ utils */

static int is_space(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }
static int is_digit(char c) { return c >= '0' && c <= '9'; }

/* Find the byte offset of `needle` (length `nlen`) in `hay[start..end)`,
 * or -1 if absent. Plain memmem-style search. */
static long find_substr(const char *hay, size_t start, size_t end,
                        const char *needle, size_t nlen)
{
    if (nlen == 0 || end < start || end - start < nlen) return -1;
    size_t last = end - nlen;
    for (size_t i = start; i <= last; i++) {
        if (hay[i] == needle[0] && memcmp(hay + i, needle, nlen) == 0) {
            return (long)i;
        }
    }
    return -1;
}

/* Find the offset just AFTER `"key":` in hay[start..end). Returns the
 * index of the first byte of the value (skipping spaces). -1 if not found. */
static long find_value_after_key(const char *hay, size_t start, size_t end,
                                  const char *key)
{
    /* Build "\"key\":" pattern. The keys we care about are short; cap at 64. */
    char pattern[80];
    size_t klen = strlen(key);
    if (klen + 4 >= sizeof(pattern)) return -1;
    pattern[0] = '"';
    memcpy(pattern + 1, key, klen);
    pattern[1 + klen] = '"';
    pattern[2 + klen] = ':';
    long off = find_substr(hay, start, end, pattern, klen + 3);
    if (off < 0) return -1;
    size_t i = (size_t)off + klen + 3;
    while (i < end && is_space(hay[i])) i++;
    return (long)i;
}

/* ------------------------------------------------------------ rounding */

/* Round a JSON-style number to the nearest short, using only integer
 * arithmetic. We deliberately avoid pulling in libm / sscanf("%f") —
 * Retro68 can do floating-point but it bloats the binary, and we only
 * need integer accuracy to display "53°F". Strategy: parse the whole
 * part as a long, then peek at the first digit after the decimal point;
 * 5..9 rounds up, 0..4 truncates. Negatives flip at the end. */
short weather_round_str(const char *s, size_t n)
{
    /* skip leading whitespace */
    size_t i = 0;
    while (i < n && is_space(s[i])) i++;
    if (i >= n) return 0;

    int neg = 0;
    if (s[i] == '-') { neg = 1; i++; }
    else if (s[i] == '+') { i++; }
    if (i >= n || (!is_digit(s[i]) && s[i] != '.')) return 0;

    long whole = 0;
    int saw_digit = 0;
    while (i < n && is_digit(s[i])) {
        whole = whole * 10 + (s[i] - '0');
        saw_digit = 1;
        i++;
    }
    int round_up = 0;
    if (i < n && s[i] == '.') {
        i++;
        if (i < n && is_digit(s[i])) {
            saw_digit = 1;
            /* Look at the first decimal digit: 5..9 rounds up. */
            if (s[i] >= '5' && s[i] <= '9') round_up = 1;
            i++;
        }
    }
    if (!saw_digit) return 0;
    if (round_up) whole++;
    if (neg) whole = -whole;
    if (whole > 32767) whole = 32767;
    if (whole < -32768) whole = -32768;
    return (short)whole;
}

/* Read a JSON number starting at hay[i]. Returns the rounded short value
 * via *out. Advances *end_off to the byte AFTER the number. Returns 1 on
 * success, 0 if no number found. */
static int read_number(const char *hay, size_t i, size_t end,
                       short *out, size_t *end_off)
{
    size_t start = i;
    if (i < end && (hay[i] == '-' || hay[i] == '+')) i++;
    if (i >= end) return 0;
    if (!is_digit(hay[i]) && hay[i] != '.') return 0;
    while (i < end && (is_digit(hay[i]) || hay[i] == '.' || hay[i] == 'e' ||
                        hay[i] == 'E' || hay[i] == '+' || hay[i] == '-')) i++;
    *out = weather_round_str(hay + start, i - start);
    if (end_off) *end_off = i;
    return 1;
}

/* Read a JSON string starting at hay[i] (must be `"`). Stores pointer +
 * length of the contents (between the quotes). Advances *end_off past the
 * closing quote. Returns 1 on success, 0 if not a quoted string. */
static int read_string(const char *hay, size_t i, size_t end,
                       const char **out_p, size_t *out_len, size_t *end_off)
{
    if (i >= end || hay[i] != '"') return 0;
    i++;
    size_t s = i;
    while (i < end && hay[i] != '"') {
        if (hay[i] == '\\' && i + 1 < end) i++;
        i++;
    }
    if (i >= end) return 0;
    *out_p = hay + s;
    *out_len = i - s;
    if (end_off) *end_off = i + 1;   /* past the closing quote */
    return 1;
}

/* ------------------------------------------------------------ ISO date → DOW */

/* Zeller's congruence: a closed-form formula that gives the day-of-week
 * for any Gregorian date, no calendar table required. Discovered by
 * Christian Zeller in 1882, it's the standard "I have a date, give me a
 * weekday" trick when you can't or don't want to ship a calendar
 * library. The formula treats January and February as months 13 and 14
 * of the previous year (which is why we shift `m += 12; y -= 1` for
 * those two), then combines the day, the month-shift constant
 * `(13*(m+1))/5`, and the century / year-of-century terms with
 * mod-7 arithmetic. The output ordering is Zeller's own (0=Sat) — we
 * map it to a string table at the call site.
 *
 * y, m, d are unsigned ints (m is 1..12, d is 1..31). Returns 0..6 where
 * 0=Sat, 1=Sun, 2=Mon, ..., 6=Fri. */
static int zeller(int y, int m, int d)
{
    if (m < 3) { m += 12; y -= 1; }
    int K = y % 100;
    int J = y / 100;
    int h = (d + (13 * (m + 1)) / 5 + K + K / 4 + J / 4 + 5 * J) % 7;
    return h;
}

void weather_dow_abbrev(const char *iso, size_t n, char out[4])
{
    /* Expect "YYYY-MM-DD" — exactly 10 chars, dashes at positions 4 and 7. */
    if (n < 10 || iso[4] != '-' || iso[7] != '-' ||
        !is_digit(iso[0]) || !is_digit(iso[1]) || !is_digit(iso[2]) || !is_digit(iso[3]) ||
        !is_digit(iso[5]) || !is_digit(iso[6]) ||
        !is_digit(iso[8]) || !is_digit(iso[9])) {
        out[0] = '?'; out[1] = '?'; out[2] = '?'; out[3] = 0;
        return;
    }
    int y = (iso[0] - '0') * 1000 + (iso[1] - '0') * 100 +
            (iso[2] - '0') * 10   + (iso[3] - '0');
    int m = (iso[5] - '0') * 10 + (iso[6] - '0');
    int d = (iso[8] - '0') * 10 + (iso[9] - '0');
    int z = zeller(y, m, d);
    /* Zeller: 0=Sat 1=Sun 2=Mon 3=Tue 4=Wed 5=Thu 6=Fri */
    static const char *names[7] = { "Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri" };
    const char *src = names[z];
    out[0] = src[0]; out[1] = src[1]; out[2] = src[2]; out[3] = 0;
}

/* ------------------------------------------------------------ array readers */

/* Find the matching closing bracket for the `[` at hay[i]. Doesn't handle
 * nested arrays inside the array (open-meteo doesn't emit those for our
 * queries) but skips over nested objects/strings for safety. */
static long find_array_end(const char *hay, size_t i, size_t end)
{
    if (i >= end || hay[i] != '[') return -1;
    int depth = 0;
    while (i < end) {
        char c = hay[i];
        if (c == '[') depth++;
        else if (c == ']') { depth--; if (depth == 0) return (long)i; }
        else if (c == '"') {
            i++;
            while (i < end && hay[i] != '"') {
                if (hay[i] == '\\' && i + 1 < end) i++;
                i++;
            }
        }
        i++;
    }
    return -1;
}

/* Read up to `cap` numbers from a JSON array starting at hay[i].
 * Stores them into `out`. Returns the number of elements actually read. */
static int read_number_array(const char *hay, size_t i, size_t end,
                             short *out, int cap)
{
    if (i >= end || hay[i] != '[') return 0;
    long arr_end = find_array_end(hay, i, end);
    if (arr_end < 0) return 0;
    size_t e = (size_t)arr_end;
    i++;   /* past '[' */
    int n = 0;
    while (i < e && n < cap) {
        while (i < e && (is_space(hay[i]) || hay[i] == ',')) i++;
        if (i >= e) break;
        size_t adv;
        short v;
        if (!read_number(hay, i, e, &v, &adv)) break;
        out[n++] = v;
        i = adv;
    }
    return n;
}

/* Read up to `cap` strings from a JSON array; calls cb(idx, ptr, len) for
 * each. Returns the number actually read. */
typedef void (*str_array_cb)(int idx, const char *p, size_t len, void *ctx);
static int read_string_array(const char *hay, size_t i, size_t end,
                             int cap, str_array_cb cb, void *ctx)
{
    if (i >= end || hay[i] != '[') return 0;
    long arr_end = find_array_end(hay, i, end);
    if (arr_end < 0) return 0;
    size_t e = (size_t)arr_end;
    i++;
    int n = 0;
    while (i < e && n < cap) {
        while (i < e && (is_space(hay[i]) || hay[i] == ',')) i++;
        if (i >= e) break;
        if (hay[i] != '"') break;
        const char *sp;
        size_t sl;
        size_t adv;
        if (!read_string(hay, i, e, &sp, &sl, &adv)) break;
        cb(n, sp, sl, ctx);
        n++;
        i = adv;
    }
    return n;
}

/* Find the byte range of the JSON object value after a key.
 * Returns 1 with out_start/out_end set to the inside of the {} braces,
 * or 0 if the key isn't an object. */
static int find_object_range(const char *hay, size_t buf_start, size_t buf_end,
                             const char *key, size_t *out_start, size_t *out_end)
{
    long val = find_value_after_key(hay, buf_start, buf_end, key);
    if (val < 0) return 0;
    size_t i = (size_t)val;
    if (i >= buf_end || hay[i] != '{') return 0;
    int depth = 0;
    size_t j = i;
    while (j < buf_end) {
        char c = hay[j];
        if (c == '{') depth++;
        else if (c == '}') { depth--; if (depth == 0) { *out_start = i + 1; *out_end = j; return 1; } }
        else if (c == '"') {
            j++;
            while (j < buf_end && hay[j] != '"') {
                if (hay[j] == '\\' && j + 1 < buf_end) j++;
                j++;
            }
        }
        j++;
    }
    return 0;
}

/* ------------------------------------------------------------ wind direction */

/* Map 0..360° degree heading to a 0..15 octant index for the 16-point
 * compass (N, NNE, NE, ENE, ..., NNW). open-meteo gives us the wind
 * direction as a degree value (0 = north, 90 = east, etc.); we want a
 * cardinal-letter label. Each compass slot is 22.5° wide centred on
 * its label: N covers (-11.25°, +11.25°), NNE covers (11.25°, 33.75°),
 * and so on. Integer-only nearest-rounding: shift the input by half a
 * slot (11.25° → +112 in tenths-of-degrees) and divide by the slot
 * width (22.5° → 225 in tenths). */
static unsigned char deg_to_octant(short deg)
{
    /* Normalize to [0, 360). */
    while (deg < 0) deg += 360;
    while (deg >= 360) deg -= 360;
    /* 22.5° per slot. Round nearest: (deg + 11.25) / 22.5. */
    int oct = ((int)deg * 10 + 112) / 225;
    if (oct >= 16) oct = 0;
    return (unsigned char)oct;
}

/* ------------------------------------------------------------ context for daily date callback */

struct daily_dow_ctx {
    WeatherData *out;
};

static void daily_dow_set(int idx, const char *p, size_t len, void *vctx)
{
    struct daily_dow_ctx *c = (struct daily_dow_ctx *)vctx;
    /* Skip index 0 (today). Map daily[1..3] in the JSON to out->daily[0..2]. */
    if (idx < 1 || idx > WEATHER_DAILY_COUNT) return;
    weather_dow_abbrev(p, len, c->out->daily[idx - 1].dow);
}

/* ------------------------------------------------------------ entry point */

int weather_parse(const char *body, size_t len, WeatherData *out)
{
    if (!out) return 0;
    memset(out, 0, sizeof(*out));
    if (!body || len == 0) return 0;

    /* Parse "current": ... */
    size_t cur_s = 0, cur_e = len;
    int has_current = find_object_range(body, 0, len, "current", &cur_s, &cur_e);

    if (has_current) {
        long off;

        off = find_value_after_key(body, cur_s, cur_e, "time");
        if (off >= 0) {
            const char *sp; size_t sl; size_t adv;
            if (read_string(body, (size_t)off, cur_e, &sp, &sl, &adv)) {
                /* Look for 'T' followed by HH:MM. */
                for (size_t k = 0; k + 4 < sl; k++) {
                    if (sp[k] == 'T' && is_digit(sp[k+1]) && is_digit(sp[k+2]) &&
                        sp[k+3] == ':' && is_digit(sp[k+4])) {
                        out->hour = (short)((sp[k+1]-'0') * 10 + (sp[k+2]-'0'));
                        out->minute = (short)((sp[k+4]-'0') * 10 +
                                               (k+5 < sl && is_digit(sp[k+5]) ? (sp[k+5]-'0') : 0));
                        break;
                    }
                }
            }
        }

        off = find_value_after_key(body, cur_s, cur_e, "temperature_2m");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) {
                out->temp_f = v;
                out->ok = 1;
            }
        }

        off = find_value_after_key(body, cur_s, cur_e, "apparent_temperature");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) out->feels_like_f = v;
        }

        off = find_value_after_key(body, cur_s, cur_e, "weather_code");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) {
                out->wmo_code = (unsigned char)(v < 0 ? 0 : (v > 99 ? 99 : v));
            }
        }

        off = find_value_after_key(body, cur_s, cur_e, "wind_speed_10m");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) out->wind_mph = v;
        }

        off = find_value_after_key(body, cur_s, cur_e, "wind_direction_10m");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) {
                out->wind_dir = deg_to_octant(v);
            }
        }

        off = find_value_after_key(body, cur_s, cur_e, "relative_humidity_2m");
        if (off >= 0) {
            size_t adv; short v;
            if (read_number(body, (size_t)off, cur_e, &v, &adv)) {
                if (v < 0) v = 0;
                if (v > 100) v = 100;
                out->humidity_pct = (unsigned char)v;
            }
        }
    }

    /* Parse "daily": ... */
    size_t day_s = 0, day_e = len;
    int has_daily = find_object_range(body, 0, len, "daily", &day_s, &day_e);
    if (has_daily) {
        long off;

        /* daily.time[] — convert ISO date strings to DOW abbrevs. */
        off = find_value_after_key(body, day_s, day_e, "time");
        if (off >= 0) {
            struct daily_dow_ctx ctx;
            ctx.out = out;
            (void)read_string_array(body, (size_t)off, day_e,
                                     WEATHER_DAILY_COUNT + 1,
                                     daily_dow_set, &ctx);
        }

        /* daily.temperature_2m_max[] — skip index 0 (today). */
        off = find_value_after_key(body, day_s, day_e, "temperature_2m_max");
        if (off >= 0) {
            short tmp[WEATHER_DAILY_COUNT + 1];
            int n = read_number_array(body, (size_t)off, day_e, tmp,
                                       WEATHER_DAILY_COUNT + 1);
            for (int i = 1; i < n && (i - 1) < WEATHER_DAILY_COUNT; i++) {
                out->daily[i - 1].hi_f = tmp[i];
            }
        }

        off = find_value_after_key(body, day_s, day_e, "temperature_2m_min");
        if (off >= 0) {
            short tmp[WEATHER_DAILY_COUNT + 1];
            int n = read_number_array(body, (size_t)off, day_e, tmp,
                                       WEATHER_DAILY_COUNT + 1);
            for (int i = 1; i < n && (i - 1) < WEATHER_DAILY_COUNT; i++) {
                out->daily[i - 1].lo_f = tmp[i];
            }
        }

        off = find_value_after_key(body, day_s, day_e, "weather_code");
        if (off >= 0) {
            short tmp[WEATHER_DAILY_COUNT + 1];
            int n = read_number_array(body, (size_t)off, day_e, tmp,
                                       WEATHER_DAILY_COUNT + 1);
            for (int i = 1; i < n && (i - 1) < WEATHER_DAILY_COUNT; i++) {
                short v = tmp[i];
                if (v < 0) v = 0;
                if (v > 99) v = 99;
                out->daily[i - 1].wmo_code = (unsigned char)v;
            }
        }
    }

    return out->ok ? 1 : 0;
}
