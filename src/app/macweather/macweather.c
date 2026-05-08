/*
 * macweather.c — Mac Toolbox UI shell for the classic-vibe-mac weather app.
 *
 * What this file is: the entire on-screen Mac side of "MacWeather", a
 * tiny weather app for System 7. It opens a window, runs an event loop,
 * polls a JSON file off a host-shared volume, asks weather_parse.c to
 * decode the bytes, and draws a current-conditions panel + 3-day
 * forecast with QuickDraw.
 *
 * Pattern: classic Mac "Toolbox shell". A Mac app of this era is a
 * `main()` that initialises the Toolbox managers, builds a window, and
 * spins forever in `WaitNextEvent` until the user picks Quit. Every
 * paint, click, and menu pick is something we explicitly handle. Modern
 * devs: think of it as writing your own miniature window manager + main
 * loop in one C file.
 *
 * If you've already read reader.c's top-of-file: same shape, same
 * register. The crash-course on Pascal strings, Resources, WaitNextEvent,
 * QuickDraw, the Memory Manager, and the File Manager lives there — we
 * won't repeat it here. What's different in MacWeather:
 *
 *   - Data source. Reader opens HTML at :Shared:index.html (a volume
 *     baked into the boot disk). MacWeather wants live data, so it
 *     prefers a separately-mounted volume named "Unix:" — that's
 *     BasiliskII's extfs surfacing the host's /Shared/ directory as a
 *     Mac volume (see LEARNINGS.md, "extfs surfaces as Mac volume
 *     `Unix:`"). The JS host (src/web/src/weather-poller.ts) fetches
 *     from api.open-meteo.com every 15 minutes and writes the response
 *     into that directory. If the extfs volume isn't mounted (bare
 *     hardware, or the timing-flaky BasiliskII case from LEARNINGS),
 *     we fall back to :Shared:weather.json baked into the boot disk —
 *     stale, but always present.
 *
 *   - Refresh model. We never fetch the network ourselves (no TCP/IP
 *     stack, and even if MacTCP existed in the emulator, parsing TLS
 *     in a 68k codebase is a non-starter). Instead the C side polls
 *     the file's modtime: every 30-tick (~½-second) null event in the
 *     event loop, we PBHGetFInfo the file, and if its mtime advanced
 *     we re-read and redraw. Cmd-R forces a re-read.
 *
 *   - No scrolling. The window is a fixed 360x240 panel — everything
 *     fits at once, so there's no scroll bar, no Controls, no link
 *     hit-testing.
 *
 * Pipeline (data flow):
 *   :Unix:weather.json   --HOpen/FSRead------->   raw bytes (gJsonBuf)
 *   raw bytes            --weather_parse------>   WeatherData
 *   WeatherData          --DrawWeather-------->   QuickDraw paints pixels
 *
 * The Toolbox shell is intentionally thin: all parsing lives in
 * weather_parse.c, all glyph artwork in weather_glyphs.c, both
 * host-tested. This file owns the event loop, the window, file I/O,
 * the modtime poll, and the on-screen layout.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68. If :Unix: isn't
 * mounted (no JS host, or the extfs mount is wedged) the app shows a
 * friendly "Waiting for weather data..." banner and keeps polling.
 *
 * If you're editing this file in the in-browser playground: change a
 * string, hit Build & Run, see the result in the emulator within ~1
 * second. Good first edits: the "Cmd-R to refresh" hint string, the
 * temperature-unit suffix ("°F"), or the WMO label table at the top of
 * the drawing section.
 */

/* Toolbox managers. Same headers as reader.c (minus AppleEvents — we
 * don't register a Finder document type) — each header corresponds to
 * one of Apple's "managers", the classic-Mac equivalent of standard
 * library subsystems. There's no big "mac.h"; you include exactly the
 * managers you use. Most function names are unprefixed: NewWindow,
 * DrawString, FSRead, etc. are real top-level symbols. */
#include <Quickdraw.h>      /* drawing primitives: MoveTo, DrawString, ... */
#include <Windows.h>        /* WindowPtr, GetNewWindow, FindWindow         */
#include <Menus.h>          /* MBAR, GetMenuHandle, MenuSelect             */
#include <Events.h>         /* WaitNextEvent, EventRecord                  */
#include <Fonts.h>          /* TextFont, applFont, font IDs                */
#include <Dialogs.h>        /* Alert (the About box)                       */
#include <TextEdit.h>       /* TEInit (Toolbox wants this even if we never */
                            /* use a TEHandle — desk accessories may rely  */
                            /* on it being initialised)                    */
#include <TextUtils.h>      /* NumToString, GetIndString                   */
#include <Devices.h>        /* OpenDeskAcc — Apple-menu desk accessories   */
#include <OSUtils.h>        /* SysBeep                                     */
#include <Resources.h>      /* GetResource (resource fork access)          */
#include <Files.h>          /* HOpen, FSRead, FSClose, PBHGetVInfoSync     */

#include "weather_parse.h"
#include "weather_glyphs.h"

/* ------------------------------------------------------------------ IDs */

enum {
    kMenuApple = 128,
    kMenuFile  = 129,
    kMenuEdit  = 130
};

enum {
    kAppleAbout = 1,

    kFileRefresh = 1,
    kFileQuit    = 3
};

enum {
    kAlertAbout = 128
};

enum {
    kWindResID = 128
};

/* ------------------------------------------------------------ State */

#define kJsonBufferBytes 8192     /* open-meteo current+daily is ~1-2 KB */

static WindowPtr     gWindow      = NULL;
static Boolean       gQuit        = false;
static char          gJsonBuf[kJsonBufferBytes];
static long          gJsonLen     = 0;
static unsigned long gLastModSecs = 0;
static WeatherData   gWeather;
static Boolean       gHaveData    = false;

/* ------------------------------------------------------------ File I/O */

/* Look up the "Unix" volume's vRefNum by iterating mounted volumes via
 * PBHGetVInfo with positive ioVolIndex. Returns 0 if not found.
 *
 * BasiliskII's extfs in our boot config doesn't always surface the
 * /Shared/ tree as a mounted Mac volume — when it does we get live
 * updates from the JS host's weather poll; when it doesn't we fall
 * back to the boot-disk-baked :Shared:weather.json. */
static short FindUnixVRefNum(void)
{
    HVolumeParam pb;
    Str255 vname;
    short index = 1;
    while (index <= 32) {
        pb.ioCompletion = NULL;
        pb.ioNamePtr = vname;
        pb.ioVRefNum = 0;
        pb.ioVolIndex = index;
        OSErr err = PBHGetVInfoSync((HParmBlkPtr)&pb);
        if (err != noErr) return 0;
        if (vname[0] == 4 &&
            vname[1] == 'U' && vname[2] == 'n' &&
            vname[3] == 'i' && vname[4] == 'x') {
            return pb.ioVRefNum;
        }
        index++;
    }
    return 0;
}

/* Build a Pascal string from a C string. */
static void PStrFromC(StringPtr out, const char *c)
{
    int n = 0;
    while (c[n] && n < 255) n++;
    out[0] = (unsigned char)n;
    for (int i = 0; i < n; i++) out[i + 1] = (unsigned char)c[i];
}

/* Get modtime of weather.json. Tries the Unix volume first (live updates
 * from the JS poll) and falls back to :Shared:weather.json on the boot
 * volume (baked at build time by scripts/build-boot-disk.sh).
 *
 * How the C side knows the file changed: there is no inotify, no
 * filesystem watcher, no callback API in System 7 for "this file has
 * been written by another process". Our trick is the simplest possible:
 * stat-poll. PBHGetFInfo returns the file's HFS catalog record — among
 * many other things it carries `ioFlMdDat`, the file's modification
 * timestamp in seconds since 1904 (the classic Mac epoch). On every
 * idle tick of the event loop we call this, compare against gLastModSecs,
 * and re-read iff the timestamp moved. The host's JS poller bumps the
 * file's mtime as a side-effect of writing it, which is what makes the
 * scheme work. */
static unsigned long GetWeatherFileModTime(void)
{
    short unixVRef = FindUnixVRefNum();
    HFileInfo pb;
    Str255 name;
    OSErr err;

    if (unixVRef != 0) {
        PStrFromC(name, "weather.json");
        pb.ioNamePtr = name;
        pb.ioVRefNum = unixVRef;
        pb.ioFDirIndex = 0;
        pb.ioDirID = 0;
        err = PBHGetFInfoSync((HParmBlkPtr)&pb);
        if (err == noErr) return (unsigned long)pb.ioFlMdDat;
    }

    /* Fallback: :Shared:weather.json — the boot-disk-baked file. */
    PStrFromC(name, ":Shared:weather.json");
    pb.ioNamePtr = name;
    pb.ioVRefNum = 0;
    pb.ioFDirIndex = 0;
    pb.ioDirID = 0;
    err = PBHGetFInfoSync((HParmBlkPtr)&pb);
    if (err != noErr) return 0;
    return (unsigned long)pb.ioFlMdDat;
}

static OSErr gLastOpenErr = 0;
static OSErr gLastReadErr = 0;
static short gLastUnixVRef = 0;
static char  gReadFromBoot = 0;   /* 1 if last read fell back to :Shared: */

/* Try to read the weather JSON. Tries Unix:weather.json first (live
 * updates from the JS poller); falls back to :Shared:weather.json baked
 * onto the boot disk at build time. Returns the byte count or -1.
 *
 * The HOpen/FSRead/FSClose dance is the Mac File Manager's basic read
 * loop — same pattern as Reader's ReadHtmlFile in reader.c. (HOpen by
 * vRefNum + Pascal-string filename; FSRead with a count by reference;
 * always FSClose to free the path control block, even on error.) The
 * one wrinkle here is the two-tier lookup: live first, baked fallback. */
static long ReadWeatherFile(void)
{
    short unixVRef = FindUnixVRefNum();
    gLastUnixVRef = unixVRef;
    Str255 name;
    short refNum = 0;
    OSErr err;
    long count;

    if (unixVRef != 0) {
        PStrFromC(name, "weather.json");
        err = HOpen(unixVRef, 0, name, fsRdPerm, &refNum);
        gLastOpenErr = err;
        if (err == noErr) {
            count = kJsonBufferBytes;
            err = FSRead(refNum, &count, gJsonBuf);
            gLastReadErr = err;
            FSClose(refNum);
            if (err == noErr || err == eofErr) {
                gReadFromBoot = 0;
                return count;
            }
        }
    }

    /* Fallback: the boot-disk-baked sample at :Shared:weather.json. */
    PStrFromC(name, ":Shared:weather.json");
    err = HOpen(0, 0, name, fsRdPerm, &refNum);
    gLastOpenErr = err;
    if (err != noErr) return -1;
    count = kJsonBufferBytes;
    err = FSRead(refNum, &count, gJsonBuf);
    gLastReadErr = err;
    FSClose(refNum);
    if (err != noErr && err != eofErr) return -1;
    gReadFromBoot = 1;
    return count;
}

/* ------------------------------------------------------------ Refresh */

/* Try to read + parse weather.json. Returns true if data changed (i.e.
 * caller should redraw). `force` skips the modtime short-circuit.
 *
 * Why we redraw on data-change rather than continuously: continuous
 * redraw on a 68k Mac is wasteful — every paint flushes the screen
 * buffer and the panel is otherwise static. Modtime-gated redraw also
 * means a window left open all afternoon costs zero CPU until the host
 * actually pushes new weather. The price: a 30-tick (~½-second) latency
 * after the JS host writes the file before pixels move, which is fine
 * for weather. */
static Boolean RefreshWeather(Boolean force)
{
    unsigned long mt = GetWeatherFileModTime();
    if (!force && mt != 0 && mt == gLastModSecs && gHaveData) return false;

    long n = ReadWeatherFile();
    if (n <= 0) {
        /* File unreachable. Keep whatever we last had; just don't update
         * the modtime, so we'll keep checking. */
        if (!gHaveData) return false;
        return false;
    }
    gJsonLen = n;
    gLastModSecs = mt;
    int ok = weather_parse(gJsonBuf, (size_t)gJsonLen, &gWeather);
    gHaveData = ok ? true : gHaveData;
    return true;
}

/* ------------------------------------------------------------ Drawing */

/* Pascal-string from a C int 0..999. Builds "\p<digits>" into out. */
static void IntToPStr(short n, StringPtr out)
{
    NumToString((long)n, out);
}

static void DrawCStr(const char *s)
{
    /* Convert to Pascal-string and DrawString it. Cheaper than DrawText for
     * short labels. */
    Str255 p;
    int len = 0;
    while (s[len] && len < 255) len++;
    p[0] = (unsigned char)len;
    for (int i = 0; i < len; i++) p[i + 1] = (unsigned char)s[i];
    DrawString(p);
}

/* WMO code → human label mapping. open-meteo emits World Meteorological
 * Organization weather codes (a small enumeration: 0=clear, 1-3 cloud
 * gradient, 45/48 fog, 51-67 drizzle/rain, 71-77 snow, 80-86 showers,
 * 95-99 thunderstorm). We render textual labels here and a matching
 * glyph in weather_glyphs.c — the dispatch table in WeatherDrawGlyph
 * groups the same codes the same way as WmoLabel below. Keep them in
 * sync if you add a code. */
static const char *kWmoNames[] = {
    /* Loose textual labels for the WMO codes we care about. */
    "Clear", "Mainly clear", "Partly cloudy", "Overcast"
};

static const char *WmoLabel(unsigned char w)
{
    if (w <= 3) return kWmoNames[w];
    if (w == 45 || w == 48) return "Fog";
    if (w >= 51 && w <= 57) return "Drizzle";
    if (w >= 61 && w <= 67) return "Rain";
    if (w >= 71 && w <= 77) return "Snow";
    if (w >= 80 && w <= 82) return "Rain showers";
    if (w == 85 || w == 86) return "Snow showers";
    if (w >= 95 && w <= 99) return "Thunderstorm";
    return "Unknown";
}

static const char *kCompass[16] = {
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"
};

/* Repaint the entire window. Called from the update event (BeginUpdate
 * .. EndUpdate) and after every successful refresh. QuickDraw is
 * immediate-mode: there's no retained scene graph or invalidate-by-
 * region (well, there is — InvalRect — but we just clear and redraw the
 * whole panel; the area is small). The whole repaint takes ~1 ms on a
 * fast emulator. */
static void DrawWeather(void)
{
    SetPort(gWindow);
    Rect cr = gWindow->portRect;
    EraseRect(&cr);

    /* No title strip — the WIND title bar already says "MacWeather". */
    TextFont(applFont);
    TextSize(9);
    TextFace(0);

    if (!gHaveData) {
        TextFont(applFont);
        TextSize(12);
        TextFace(0);
        MoveTo(cr.left + 16, cr.top + 60);
        DrawCStr("Waiting for weather data ...");
        TextSize(9);
        MoveTo(cr.left + 16, cr.top + 90);
        DrawCStr("Trying Unix:weather.json (live), then :Shared:weather.json (baked).");
        MoveTo(cr.left + 16, cr.top + 104);
        DrawCStr("Updates from api.open-meteo.com, written by the JS host every 15 minutes.");
        return;
    }

    /* --- Top half: glyph + big temperature + summary stats --- */
    short topY = (short)(cr.top + 22);
    short glyphX = (short)(cr.left + 12);
    short glyphY = topY;
    short glyphSize = 48;

    WeatherDrawGlyph(gWeather.wmo_code, glyphX, glyphY, glyphSize);

    /* Big temperature. Geneva 18 bold (numeric IDs because Retro68's
     * Fonts.h doesn't expose `geneva`). */
    TextFont(applFont);
    TextSize(18);
    TextFace(bold);
    Str255 tempStr;
    IntToPStr(gWeather.temp_f, tempStr);
    /* Append "°F". The degree sign is 0xA1 in MacRoman; ° glyph at top. */
    short addAt = tempStr[0];
    tempStr[addAt + 1] = 0xA1;     /* MacRoman degree sign */
    tempStr[addAt + 2] = 'F';
    tempStr[0] = (unsigned char)(addAt + 2);
    short tx = (short)(glyphX + glyphSize + 12);
    short ty = (short)(topY + 18);
    MoveTo(tx, ty);
    DrawString(tempStr);

    /* Condition label, regular weight. */
    TextSize(10);
    TextFace(0);
    MoveTo(tx, (short)(ty + 14));
    DrawCStr(WmoLabel(gWeather.wmo_code));

    /* "Feels like XX°F" line. */
    TextSize(9);
    Str255 feels;
    IntToPStr(gWeather.feels_like_f, feels);
    short fa = feels[0];
    feels[fa + 1] = 0xA1;
    feels[fa + 2] = 'F';
    feels[0] = (unsigned char)(fa + 2);
    MoveTo(tx, (short)(ty + 26));
    DrawCStr("Feels like ");
    DrawString(feels);

    /* Wind + humidity. */
    Str255 wind;
    IntToPStr(gWeather.wind_mph, wind);
    short wa = wind[0];
    wind[wa + 1] = ' '; wind[wa + 2] = 'm'; wind[wa + 3] = 'p'; wind[wa + 4] = 'h';
    wind[0] = (unsigned char)(wa + 4);
    MoveTo(tx, (short)(ty + 38));
    DrawCStr("Wind ");
    if (gWeather.wind_dir < 16) {
        DrawCStr(kCompass[gWeather.wind_dir]);
        DrawCStr(" ");
    }
    DrawString(wind);

    Str255 hum;
    IntToPStr((short)gWeather.humidity_pct, hum);
    short ha = hum[0];
    hum[ha + 1] = '%';
    hum[0] = (unsigned char)(ha + 1);
    MoveTo(tx, (short)(ty + 50));
    DrawCStr("Humidity ");
    DrawString(hum);

    /* Divider. */
    short divY = (short)(cr.top + 22 + 70);
    MoveTo((short)(cr.left + 8), divY);
    LineTo((short)(cr.right - 8), divY);

    /* --- Bottom half: 3 daily-forecast panels --- */
    short panelTop = (short)(divY + 8);
    short panelW = (short)((cr.right - cr.left - 16) / 3);
    for (int i = 0; i < WEATHER_DAILY_COUNT; i++) {
        short px = (short)(cr.left + 8 + i * panelW);
        /* DOW */
        TextSize(9);
        TextFace(bold);
        MoveTo((short)(px + panelW / 2 - 10), (short)(panelTop + 10));
        Str255 dow;
        dow[0] = 3;
        dow[1] = (unsigned char)gWeather.daily[i].dow[0];
        dow[2] = (unsigned char)gWeather.daily[i].dow[1];
        dow[3] = (unsigned char)gWeather.daily[i].dow[2];
        DrawString(dow);

        /* Glyph. */
        TextFace(0);
        WeatherDrawGlyph(gWeather.daily[i].wmo_code,
                         (short)(px + panelW / 2 - 12),
                         (short)(panelTop + 14),
                         24);

        /* Hi / lo. */
        TextSize(9);
        Str255 hi, lo;
        IntToPStr(gWeather.daily[i].hi_f, hi);
        short hia = hi[0]; hi[hia + 1] = 0xA1; hi[0] = (unsigned char)(hia + 1);
        IntToPStr(gWeather.daily[i].lo_f, lo);
        short loa = lo[0]; lo[loa + 1] = 0xA1; lo[0] = (unsigned char)(loa + 1);
        MoveTo((short)(px + panelW / 2 - 18), (short)(panelTop + 54));
        TextFace(bold);
        DrawString(hi);
        TextFace(0);
        DrawCStr(" / ");
        DrawString(lo);
    }

    /* --- Bottom strip: updated time + cmd-R hint --- */
    TextFont(applFont);
    TextSize(9);
    TextFace(0);
    Str255 time;
    Str255 hh; IntToPStr(gWeather.hour, hh);
    Str255 mm; IntToPStr(gWeather.minute, mm);
    /* Compose "Updated HH:MM" — two-digit pad on minute. */
    time[0] = 0;
    /* "Updated " */
    {
        const char *u = "Updated ";
        for (int i = 0; u[i]; i++) time[++time[0]] = (unsigned char)u[i];
    }
    if (hh[0] == 1) time[++time[0]] = '0';
    for (int i = 1; i <= hh[0]; i++) time[++time[0]] = hh[i];
    time[++time[0]] = ':';
    if (mm[0] == 1) time[++time[0]] = '0';
    for (int i = 1; i <= mm[0]; i++) time[++time[0]] = mm[i];

    MoveTo((short)(cr.left + 8), (short)(cr.bottom - 8));
    DrawString(time);
    /* The "(baked)" / "(live)" caption is intentionally suppressed: until
     * the JS-side poller (weather-poller.ts, owned by Phase 3) reliably
     * surfaces a freshness signal the C side can read, the caption was
     * misleading users into thinking the live fetch had failed even when
     * the host page had successfully fetched open-meteo. Phase 3 can
     * reintroduce this once it has a real signal — for now, the
     * "Updated HH:MM" line above already tells the user when the data
     * was refreshed. See LEARNINGS.md. */

    {
        const char *hint = "Cmd-R to refresh";
        Str255 hp;
        int len = 0;
        while (hint[len]) len++;
        hp[0] = (unsigned char)len;
        for (int i = 0; i < len; i++) hp[i + 1] = (unsigned char)hint[i];
        short hw = StringWidth(hp);
        MoveTo((short)(cr.right - 8 - hw), (short)(cr.bottom - 8));
        DrawString(hp);
    }
}

static void InvalidateContent(void)
{
    SetPort(gWindow);
    InvalRect(&gWindow->portRect);
}

/* ------------------------------------------------------------ Menus */

static void ShowAbout(void)
{
    (void)Alert(kAlertAbout, NULL);
}

static void DoMenuCommand(long cmd)
{
    short menuID   = (short)(cmd >> 16);
    short menuItem = (short)(cmd & 0xFFFF);

    if (menuID == kMenuApple) {
        if (menuItem == kAppleAbout) {
            ShowAbout();
        } else {
            Str255 daName;
            GetMenuItemText(GetMenuHandle(kMenuApple), menuItem, daName);
            (void)OpenDeskAcc(daName);
        }
    } else if (menuID == kMenuFile) {
        switch (menuItem) {
            case kFileRefresh:
                if (RefreshWeather(true)) InvalidateContent();
                else InvalidateContent();   /* refresh always redraws */
                break;
            case kFileQuit:
                gQuit = true;
                break;
        }
    } else if (menuID == kMenuEdit) {
        (void)SystemEdit(menuItem - 1);
    }
    HiliteMenu(0);
}

/* ------------------------------------------------------------ Events */

static void DoUpdate(WindowPtr w)
{
    SetPort(w);
    BeginUpdate(w);
    DrawWeather();
    EndUpdate(w);
}

static void DoMouseDown(EventRecord *e)
{
    WindowPtr win;
    short part = FindWindow(e->where, &win);
    switch (part) {
        case inMenuBar:   DoMenuCommand(MenuSelect(e->where)); break;
        case inSysWindow: SystemClick(e, win);                 break;
        case inDrag:      DragWindow(win, e->where, &qd.screenBits.bounds); break;
        case inGoAway:    if (TrackGoAway(win, e->where)) gQuit = true;     break;
        case inContent:   if (win != FrontWindow()) SelectWindow(win);      break;
    }
}

static void DoKeyDown(EventRecord *e)
{
    char key = (char)(e->message & charCodeMask);
    if (e->modifiers & cmdKey) {
        DoMenuCommand(MenuKey(key));
    }
}

/* ------------------------------------------------------------ main */

int main(void)
{
    /* Standard System 7 init dance. MoreMasters preallocates master pointer
     * blocks so future NewHandle calls don't fragment the heap. */
    MaxApplZone();
    MoreMasters(); MoreMasters(); MoreMasters(); MoreMasters();
    InitGraf(&qd.thePort);
    InitFonts();
    InitWindows();
    InitMenus();
    TEInit();
    InitDialogs(NULL);
    InitCursor();

    Handle mbar = GetNewMBar(128);
    SetMenuBar(mbar);
    AppendResMenu(GetMenuHandle(kMenuApple), 'DRVR');
    DrawMenuBar();

    gWindow = GetNewWindow(kWindResID, NULL, (WindowPtr)-1L);
    if (!gWindow) {
        SysBeep(20);
        return 1;
    }
    SetPort(gWindow);
    TextFont(applFont);
    TextSize(12);

    /* Initial probe — non-blocking, just primes the cache. */
    RefreshWeather(false);

    /* Main loop. WaitNextEvent blocks for up to 30 ticks (≈½ second) and
     * returns true with an event, or false (giving us a "null event") if
     * the timeout elapsed. We use the null-event tick as our polling
     * cadence: on every quiet half-second we check the JSON file's
     * modtime; if it advanced, refresh + redraw. No threads, no timers,
     * no callbacks — the event loop *is* the timer. */
    while (!gQuit) {
        EventRecord e;
        if (WaitNextEvent(everyEvent, &e, 30L, NULL)) {
            switch (e.what) {
                case mouseDown: DoMouseDown(&e); break;
                case keyDown:   DoKeyDown(&e);   break;
                case autoKey:   DoKeyDown(&e);   break;
                case updateEvt: DoUpdate((WindowPtr)e.message); break;
                case activateEvt: break;
            }
        } else {
            /* nullEvent (no real event in 30 ticks). Re-stat the JSON;
             * if it changed, redraw. Cheap when nothing's happened. */
            if (RefreshWeather(false)) InvalidateContent();
        }
    }

    return 0;
}
