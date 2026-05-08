/**
 * weather-poller.ts — fetch weather from open-meteo on the main thread and
 * surface it to the emulated Mac as `:Unix:weather.json`.
 *
 * Architecture:
 *   - Runs on the **main thread**, not in the BasiliskII worker. The
 *     worker's microtask queue is starved by the WASM event loop (it
 *     blocks inside `Atomics.wait` between blits), so a `fetch()` issued
 *     from the worker never gets its `then()` callback scheduled. The
 *     main thread is idle in between requestAnimationFrame frames and
 *     can run fetch promises normally.
 *   - The poller posts the JSON bytes to the worker via
 *     `worker.postMessage({ type: "weather_data", bytes })`. The worker
 *     handler writes them into the Emscripten FS at /Shared/weather.json,
 *     which BasiliskII's `extfs /Shared/` mounts as the Mac volume
 *     "Unix:" — so MacWeather sees :Unix:weather.json.
 *   - Fetch interval: 15 minutes. open-meteo's data updates hourly.
 *
 * Failure mode: on fetch error, we DO NOT post anything — the Mac side
 * stays on whatever it had (or the "no data" placeholder if this is the
 * first attempt). MacWeather watches modtime, not absence.
 */

export interface WeatherPollerConfig {
  /** Worker to which we post `{ type: "weather_data", bytes }` messages. */
  worker: Worker;
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

async function fetchAndPost(
  worker: Worker,
  lat: number,
  lon: number,
): Promise<boolean> {
  try {
    const url = buildUrl(lat, lon);
    console.log("[weather-poller] GET", url);
    const resp = await fetch(url, {
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });
    if (!resp.ok) {
      console.warn(
        `[weather-poller] HTTP ${resp.status} on ${url}; keeping previous data.`,
      );
      return false;
    }
    const text = await resp.text();
    const bytes = new TextEncoder().encode(text);
    const n = bytes.length;
    console.log(`[weather-poller] received ${n} bytes from open-meteo`);
    // Transfer the underlying buffer to avoid a copy. The worker handler
    // immediately writes the bytes into FS and discards them.
    worker.postMessage(
      { type: "weather_data", bytes },
      [bytes.buffer],
    );
    console.log(
      `[weather-poller] posted ${n} bytes to worker (Mac will see :Unix:weather.json)`,
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
 * Safe to call before the Mac side is ready — the worker buffers the
 * write until preRun has created /Shared/, and the Mac picks the file
 * up on the next 30-tick poll inside MacWeather's event loop.
 *
 * Visibility gating: when the page is hidden, the emulator worker is
 * paused (see emulator-loader.ts → makeVisibilityController). There's no
 * point fetching weather data the user can't see — the Mac side is
 * frozen and would just buffer one more snapshot. We skip the periodic
 * fetch when `document.visibilityState === "hidden"`, and trigger an
 * immediate fetch on the next visibility-restore so the data is fresh
 * when the user comes back. The first fetch always runs (the page
 * starting hidden is rare; if it happens, MacWeather just sees the
 * data slightly later than usual).
 */
export function startWeatherPoller(cfg: WeatherPollerConfig): () => void {
  const lat = typeof cfg.lat === "number" ? cfg.lat : cfg.fallbackLat;
  const lon = typeof cfg.lon === "number" ? cfg.lon : cfg.fallbackLon;
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL_MS;

  console.log(
    `[weather-poller] starting (lat=${lat}, lon=${lon}, interval=${intervalMs}ms)`,
  );
  fetchAndPost(cfg.worker, lat, lon).catch((err) =>
    console.warn("[weather-poller] first fetch threw:", err),
  );

  const handle = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      // User can't see it; the Mac side is paused anyway. Skip.
      return;
    }
    void fetchAndPost(cfg.worker, lat, lon);
  }, intervalMs);

  // When the user comes back, fire one immediately if it's been a while.
  // We don't track "last successful fetch" precisely — fetching on every
  // restore is fine (open-meteo is rate-permissive, and the data is small).
  let onVisibility: (() => void) | undefined;
  if (typeof document !== "undefined") {
    onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchAndPost(cfg.worker, lat, lon);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
  }

  return () => {
    clearInterval(handle);
    if (onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
