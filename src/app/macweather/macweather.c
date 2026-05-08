/*
 * macweather.c — Mac Toolbox UI shell for the classic-vibe-mac weather app.
 *
 * Reads weather data from `:Unix:weather.json` (the Emscripten /Shared/
 * tree, mounted by BasiliskII's extfs as the Mac volume "Unix:" — see
 * LEARNINGS.md, "extfs surfaces as Mac volume `Unix:`"). The host JS
 * (src/web/src/weather-poller.ts) fetches from api.open-meteo.com and
 * writes the JSON there every 15 minutes.
 *
 * Pipeline:
 *   :Unix:weather.json  --HOpen/FSRead-->  raw bytes (gJsonBuf)
 *   raw bytes           --weather_parse--> WeatherData
 *   WeatherData         --DrawWeather-->   on-screen pixels (QuickDraw)
 *
 * Refresh:
 *   - Every 30-tick null event: stat the file, redraw if mtime advanced.
 *   - Cmd-R (View > Refresh): force re-read and redraw.
 *   - We never fetch the network ourselves — that's the JS host's job.
 *
 * Target: 68k Mac, System 7+, compiled with Retro68. If :Unix: isn't
 * mounted (bare hardware, no JS host) the app shows a friendly "no data"
 * banner and keeps looking.
 */

#include <Quickdraw.h>
#include <Windows.h>
#include <Menus.h>
#include <Events.h>
#include <Fonts.h>
#include <Dialogs.h>
#include <TextEdit.h>
#include <TextUtils.h>
#include <Devices.h>
#include <OSUtils.h>
#include <Resources.h>
#include <Files.h>

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
 * volume (baked at build time by scripts/build-boot-disk.sh). */
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
 * onto the boot disk at build time. Returns the byte count or -1. */
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
 * caller should redraw). `force` skips the modtime short-circuit. */
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
    if (gReadFromBoot) {
        DrawCStr("  (baked)");
    } else {
        DrawCStr("  (live)");
    }

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
