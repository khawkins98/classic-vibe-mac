// Session-wide accumulator for network/resource-fetch wall time across
// the build pipeline. Lets the session-stats line in the build log
// distinguish "spent compiling" from "spent waiting for the network or
// the dynamic-import of a wasm tool" — useful for understanding why a
// cold-cache first build of the session takes much longer than later
// builds (which reuse cached sysroot blobs and tool factories).
//
// Each call site wraps its fetch/import in `await timeFetch("label", () => ...)`
// and the elapsed wall-time is added to a module-scoped counter.
// `consumeFetchMs()` reads the counter and resets it — meant to be
// called once per build by the stats accumulator in editor.ts.

let totalFetchMs = 0;

/** Wrap a fetch/import promise; adds its wall time to the session counter.
 *  Also emits a `[cvm-fetch]` line for each fetch that takes >50ms so the
 *  build log shows individual cache-cold resource loads (the build log
 *  proxy in main.ts mirrors anything starting with `[cvm-fetch]`). Below
 *  50ms we skip — a warm cache load is sub-millisecond and not worth
 *  the noise. */
export async function timeFetch<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - t0;
    totalFetchMs += ms;
    if (ms >= 50) {
      console.info(`[cvm-fetch] ${label} ${Math.round(ms)}ms`);
    }
  }
}

/** Read-and-reset the accumulated fetch time. Returns ms since the
 *  last call. */
export function consumeFetchMs(): number {
  const v = totalFetchMs;
  totalFetchMs = 0;
  return v;
}
