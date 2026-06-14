// wasmFetch.ts — resilient one-shot fetch of the vendored wasm tool binaries.
//
// Why this exists (fix/wasm-toolchain-fetch-resilience):
//
//   The toolchain wasm (cc1.wasm ~12 MB raw / ~4.7 MB gzip) is served as a
//   static asset by GitHub Pages. Two things made it fragile in production:
//
//   1. Emscripten, left to fetch its own .wasm, tries `instantiateStreaming`
//      first. Behind the coi-serviceworker shim the reconstructed response can
//      lose its `application/wasm` MIME type, so streaming throws and Emscripten
//      falls back to a SECOND full ArrayBuffer fetch. On a cold Fastly edge
//      (every redeploy invalidates it — see headers: `x-cache: MISS`) that is
//      two sequential multi-MB downloads.
//
//   2. coi-serviceworker historically swallowed any failed fetch into
//      `undefined` (now patched), which surfaced as Emscripten's opaque
//      "both async and sync fetching of the wasm failed" abort.
//
//   The robust fix is to take fetching away from Emscripten entirely: we fetch
//   the bytes ONCE here (with retry + backoff), cache them in module scope for
//   the session, and pass them to the factory via `Module.wasmBinary`. With
//   wasmBinary set, Emscripten never touches the network — no streaming MIME
//   path, no double-fetch.
//
//   Note on parallelism / splitting: HTTP Range requests are NOT a usable
//   speedup here. GitHub Pages serves Range over the *gzip* representation when
//   the client sends `Accept-Encoding: gzip` (Content-Range total == the gzip
//   size), and a partial slice of a gzip stream cannot be decoded on its own —
//   `fetch()` always auto-decompresses Content-Encoding, so ranged chunks come
//   back as garbage. Disabling gzip to range the raw bytes would triple the wire
//   cost (12 MB vs 4.7 MB). A single gzipped GET is the cheapest correct option.
//   See LEARNINGS.md "2026-06-13 — toolchain wasm fetch resilience".

import { timeFetch } from "./fetchStats";

/** Tunables for {@link fetchWasmBinary}. */
export interface FetchWasmOptions {
  /** Total attempts before giving up. Default 3 (1 try + 2 retries). */
  retries?: number;
  /** Base backoff in ms; attempt N waits baseDelayMs * 2^(N-1). Default 500. */
  baseDelayMs?: number;
  /** Per-attempt deadline in ms. A connection that opens but then stalls
   *  mid-body (the cold-edge failure mode this whole module targets) never
   *  resolves or rejects on its own — without a deadline the retry loop would
   *  never fire. We abort the attempt and let the next retry start fresh.
   *  Default 60_000: generous enough for a legit slow ~4.7 MB gzip download
   *  while still bounding an indefinite hang. */
  timeoutMs?: number;
}

/** Module-scoped cache of the fetched bytes, keyed by absolute URL. The four
 *  tool Modules are re-created per compile (cc1 et al. are not re-entrant — see
 *  cc1.ts), but the wasm bytes are immutable, so we keep them in JS rather than
 *  re-paying even a warm HTTP-cache round-trip on every Build. A rejected fetch
 *  clears its slot so a later Build can retry from scratch.
 *
 *  Memory note: this deliberately retains the decoded bytes for the whole
 *  session — ~15 MB total (cc1 ~12.7 + as ~0.8 + ld ~1.0 + Elf2Mac ~0.3). That
 *  trade (RAM for never re-fetching) is the point; if it ever matters, evicting
 *  after a Build completes is the lever. */
const binaryCache = new Map<string, Promise<Uint8Array>>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOnce(url: string, timeoutMs: number): Promise<Uint8Array> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    // A 0-byte body almost always means a truncated/aborted transfer that still
    // returned 200 — treat it as a failure so the retry loop gets another go.
    if (buf.byteLength === 0) throw new Error(`${url}: empty body`);
    return new Uint8Array(buf);
  } catch (err) {
    // Normalize the abort into a clearer, retryable error.
    if (ac.signal.aborted) {
      throw new Error(`${url}: timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch a wasm binary as raw bytes, with retry + exponential backoff, caching
 * the result for the session. The bytes are meant to be handed to an Emscripten
 * factory as `Module.wasmBinary` so the runtime performs no fetch of its own.
 *
 * @param url   Absolute URL of the .wasm asset.
 * @param label Short label for the `[cvm-fetch]` build-log line (e.g. "cc1.wasm").
 */
export function fetchWasmBinary(
  url: string,
  label: string,
  opts: FetchWasmOptions = {},
): Promise<Uint8Array> {
  const cached = binaryCache.get(url);
  if (cached) return cached;

  const retries = Math.max(1, opts.retries ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const promise = timeFetch(`wasm:${label}`, async () => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fetchOnce(url, timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          const delay = baseDelayMs * 2 ** (attempt - 1);
          console.info(
            `[cvm-fetch] ${label} attempt ${attempt}/${retries} failed ` +
              `(${err instanceof Error ? err.message : String(err)}) — ` +
              `retrying in ${delay}ms`,
          );
          await sleep(delay);
        }
      }
    }
    throw new Error(
      `Failed to fetch ${label} after ${retries} attempts: ` +
        `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  });

  binaryCache.set(url, promise);
  // Don't poison the cache on failure — let the next Build retry from scratch.
  promise.catch(() => binaryCache.delete(url));
  return promise;
}
