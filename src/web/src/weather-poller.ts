/**
 * weather-poller.ts — fetch weather from open-meteo and surface it to the
 * emulated Mac as `:Unix:weather.json`.
 *
 * Architecture:
 *   - This runs INSIDE the BasiliskII worker (after the Module's preRun has
 *     created /Shared/), not on the main thread. The Module's FS lives in
 *     the worker, and BasiliskII's `extfs /Shared/` mounts that tree as
 *     the Mac volume "Unix:" — so a write to /Shared/weather.json in the
 *     worker shows up as :Unix:weather.json inside the guest.
 *   - We try `navigator.geolocation` (only available on the main thread, so
 *     the caller passes coords in if it has them; we fall back to the
 *     configured default otherwise).
 *   - Fetch interval: 15 minutes — open-meteo's free tier is generous and
 *     their data updates hourly, but 15 min lines up nicely with the user
 *     leaving the page open for a quick boot demo.
 *
 * Failure mode: on fetch error, we DO NOT write a stub error file — the
 * Mac side stays on whatever it had (or the friendly "no data" placeholder
 * if this is the first attempt). MacWeather watches modtime, not absence.
 */

export interface WeatherPollerConfig {
  /** Emscripten Module.FS instance, with /Shared/ already created. */
  emscriptenFs: any;
  /** Coordinates to use if no overriding source supplies any. */
  fallbackLat: number;
  fallbackLon: number;
  /** Optional override (e.g. from main-thread geolocation). */
  lat?: number;
  lon?: number;
  /** Override fetch interval. Default: 15 min. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Build the open-meteo URL for the given lat/lon. We ask for fahrenheit and
 * mph because that's what MacWeather displays — saves the Mac side a unit
 * conversion. forecast_days=4 gets us today + tomorrow + +2 + +3 (the daily
 * arrays are indexed [today, tomorrow, +2, +3] and MacWeather skips index 0).
 */
function buildUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(2),
    longitude: lon.toFixed(2),
    current:
      "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m",
    daily: "temperature_2m_max,temperature_2m_min,weather_code",
    temperature_unit: "fahrenheit",
    wind_speed_unit: "mph",
    timezone: "auto",
    forecast_days: "4",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

async function fetchAndWrite(
  fs: any,
  lat: number,
  lon: number,
): Promise<boolean> {
  try {
    const url = buildUrl(lat, lon);
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) {
      console.warn(
        `[weather-poller] HTTP ${resp.status} on ${url}; keeping previous data.`,
      );
      return false;
    }
    const text = await resp.text();
    const bytes = new TextEncoder().encode(text);
    const path = "/Shared/weather.json";
    if (fs.analyzePath(path).exists) fs.unlink(path);
    // FS.createDataFile arguments: parent, name, data, canRead, canWrite, canOwn.
    fs.createDataFile("/Shared", "weather.json", bytes, true, true, true);
    console.log(
      `[weather-poller] wrote ${bytes.length} bytes to /Shared/weather.json (Mac sees :Unix:weather.json)`,
    );
    return true;
  } catch (err) {
    console.warn("[weather-poller] fetch failed:", err);
    return false;
  }
}

/**
 * Start the poller. Returns a stop() function. The first fetch is fired
 * immediately; subsequent fetches happen on `intervalMs`.
 *
 * Safe to call before the Mac side is ready — we just write to the
 * Emscripten FS, and the Mac picks it up on the next 30-tick poll inside
 * MacWeather's event loop.
 */
export function startWeatherPoller(cfg: WeatherPollerConfig): () => void {
  const lat = typeof cfg.lat === "number" ? cfg.lat : cfg.fallbackLat;
  const lon = typeof cfg.lon === "number" ? cfg.lon : cfg.fallbackLon;
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Fire-and-forget the first fetch. We don't await it because callers
  // (like the worker's start() function) should not block the Mac boot
  // on a network round-trip.
  void fetchAndWrite(cfg.emscriptenFs, lat, lon);

  const handle = setInterval(() => {
    void fetchAndWrite(cfg.emscriptenFs, lat, lon);
  }, intervalMs);

  return () => clearInterval(handle);
}
