# Architecture

_Last updated: 2026-05-09._

The technical shape of `classic-vibe-mac` as it stands today. Companion
docs: [`PLAYGROUND.md`](./PLAYGROUND.md) for the in-browser
resource-fork editor design rationale (Epic #21), and
[`AGENT-PROCESS.md`](./AGENT-PROCESS.md) for the dev workflow this
project has converged on. See also
[`DEVELOPMENT.md`](./DEVELOPMENT.md) for the actual iteration loops,
[`PRD.md`](../PRD.md) for product intent, and [`LEARNINGS.md`](../LEARNINGS.md)
for the running gotcha log.

## The big picture

A static GitHub Pages site boots a 1993 Macintosh in the visitor's
browser tab. By default there is no relay and no auth; the site ships
HTML + JS + WASM + a chunked HFS disk image, and every byte after
that runs in the user's tab. The one opt-in exception is AppleTalk
zone networking, which the main thread enables only when `?zone=` is
present and a relay base URL was compiled in.

```text
                         visitor's browser tab
  +--------------------------------------------------------------+
  |  index.html  -> coi-serviceworker (1st nav reload)           |
  |       |                                                      |
  |       v                                                      |
  |  Vite-built TS host  (src/web/src/main.ts + emulator-loader) |
  |   - draws System 7 chrome                                    |
  |   - HEAD-checks chunked manifest                             |
  |   - spawns Web Worker (type:'module')                        |
  |   - rAF loop: SAB framebuffer -> putImageData                |
  |   - main-thread weather poller (fetch open-meteo)            |
  |   - optional ?zone=<name> -> EthernetZoneProvider            |
  |       |                              |                       |
  |       | postMessage({ weather_data, bytes })                 |
  |       |                              | WebSocket frames      |
  |       v                              v                       |
  |  +--------------------------------------------------------+  |
  |  | Web Worker (emulator-worker.ts)                        |  |
  |  |   - allocates SABs (video, videoMode, input ring)      |  |
  |  |   - chunked-disk reader (synchronous XHR per 256KiB)   |  |
  |  |   - exposes globalThis.workerApi (EmulatorWorkerApi)   |  |
  |  |   - import('/emulator/BasiliskII.js')                  |  |
  |  |       |                                                |  |
  |  |       v                                                |  |
  |  |  +--------------------------------------------------+  |  |
  |  |  | BasiliskII.wasm  (Quadra 650, 68040)            |  |  |
  |  |  |   - Emscripten FS: ROM, prefs, /Shared/         |  |  |
  |  |  |     extfs mount surfaces as guest "Unix:" vol   |  |  |
  |  |  |       |                                          |  |  |
  |  |  |       v                                          |  |  |
  |  |  |  +--------------------------------------------+ |  |  |
  |  |  |  | System 7.5.5 boot disk (HFS)              | |  |  |
  |  |  |  |   :System Folder:Startup Items:Reader      | |  |  |
  |  |  |  |   :System Folder:Startup Items:MacWeather  | |  |  |
  |  |  |  |   :Applications: Hello Mac, Pixel Pad,     | |  |  |
  |  |  |  |                  Markdown Viewer, Reader,  | |  |  |
  |  |  |  |                  MacWeather                | |  |  |
  |  |  |  |   :Shared: (HTML pages baked at build)     | |  |  |
  |  |  |  +--------------------------------------------+ |  |  |
  |  |  +--------------------------------------------------+  |  |
  |  +--------------------------------------------------------+  |
  +-------------------------------+------------------------------+
                                  |
                                  | optional AppleTalk relay
                                  v
                     Cloudflare Durable Object (EthernetZone)
```

If zone networking is active, the main thread also allocates an
optional `ethernetRxBuffer` `SharedArrayBuffer` (~24.3 KiB) and passes
it in the worker `start` message. If not, that path stays stubbed.

Data flows both ways across the JS/Mac boundary, but the rule is:
**JS owns the network**, Mac owns the rendering and event loop. The
weather poller hits `api.open-meteo.com` from the page's main thread
and ships bytes into the worker; the Mac side polls a file's modtime
and redraws. There is no socket inside the Mac.

## The boot pipeline

What happens between "user navigates" and "Reader paints its first
window."

1. **First navigation** lands on `index.html`. `coi-serviceworker.min.js`
   loads as a non-module `<script>` at the top of `<head>`, registers a
   service worker, and triggers exactly one page reload. The second
   navigation is cross-origin isolated — `crossOriginIsolated === true`,
   `SharedArrayBuffer` constructable. Vite dev sets COOP/COEP itself
   (`Cross-Origin-Opener-Policy: same-origin`,
   `Cross-Origin-Embedder-Policy: credentialless` — see
   [`LEARNINGS.md`](../LEARNINGS.md) on why `credentialless`, not
   `require-corp`, in dev). GitHub Pages can't set headers, so the SW
   shim fakes them client-side.
2. **`emulator-loader.ts`** mounts a period progress bar inside
   `#emulator-canvas-mount`, gates on `crossOriginIsolated`, and
   HEAD-checks `${bootDiskUrl}.json` (the chunked manifest). If the
   manifest's missing it falls cleanly to STUB.
3. **Worker spawn.** `new Worker(new URL('./emulator-worker.ts',
   import.meta.url), { type: 'module' })`. The loader posts a start
   message with manifest URL, ROM URL, screen + RAM config, and — if
   zone networking is active — the optional `ethernetRxBuffer` SAB.
4. **Worker init.** Allocates three `SharedArrayBuffer`s:
   - **video framebuffer** — sized to `screenWidth * screenHeight * 4`
     (BGRA out of WASM, RGBA into canvas; the loop does the swizzle).
   - **videoMode** — 16 bytes of metadata so a mid-boot resolution
     change can be relayed without re-allocating.
   - **input ring** — `Int32Array` whose offsets match Infinite Mac's
     `InputBufferAddresses` exactly. The four-state cyclical lock
     (`READY_FOR_UI_THREAD` → `UI_THREAD_LOCK` →
     `READY_FOR_EMUL_THREAD` → `EMUL_THREAD_LOCK`) is
     `Atomics.wait`/`Atomics.notify` on index 0; the layout has to
     match the WASM ABI byte-for-byte or mouse coords arrive
     transposed. (Names mirror `emulator-worker-types.ts`.)
5. **Disk + prefs into Emscripten FS.** Worker reads ROM via
   `fetch().arrayBuffer()`, renders the prefs template (the `BASE_PREFS`
   string in `emulator-worker.ts`, including the load-bearing
   `modelid 30` — `gestaltID − 6` for Quadra 650; getting that wrong
   bombs boot with "unimplemented trap"; see [`LEARNINGS.md`](../LEARNINGS.md)),
   then mounts the chunked boot disk via the disks API. The chunked
   reader does **synchronous** XHR — BasiliskII calls `disk.read()`
   from inside Wasm, on the worker thread, and expects bytes back
   before the call returns. 256 KiB chunks, 1 in flight at a time.
6. **`import('/emulator/BasiliskII.js')`.** Emscripten ES-module
   factory. Calls `globalThis.workerApi.*` for video blits, idle
   waits, input polling. `globalThis.workerApi` must match upstream
   `EmulatorWorkerApi` exactly — that interface is the WASM ABI.
7. **Boot.** System 7.5.5 paints, blesses its System Folder, runs
   Startup Items. Reader and MacWeather both auto-launch.

Total wall time on the deployed site: ~5-10s on a warm cache.

## The two-way `:Shared:` data flow

The project's most distinctive feature, and the part that took the most
debugging. There are **two** parallel paths and they don't behave the
same.

### JS → Mac: `:Shared:` baked at build time (works)

`scripts/build-boot-disk.sh` mounts the System 7.5.5 image with
`hmount`, copies `src/web/public/shared/*.html` into the boot
volume's `:Shared:` folder, and re-chunks. At guest boot, Reader does
`HOpen(0, 0, "\p:Shared:index.html", fsRdPerm, ...)` and reads
straight off the boot disk. **Reliable. This is the path Reader
uses.**

### JS → Mac: `/Shared/` extfs runtime (partial)

BasiliskII has an "extfs" pref that exposes a host directory as a Mac
volume. We mount `/Shared/` from the Emscripten FS. The Mac sees it
as a volume named `Unix:` (not `Shared:` — that's the BlueSCSI bridge
convention; see [`LEARNINGS.md`](../LEARNINGS.md) `extfs surfaces as
Mac volume Unix:`). The plumbing works, but in System 7.5.5 the
volume isn't always in the VCB chain at app launch — `HOpen` returns
`-35 nsvErr` non-deterministically. **Treat this as best-effort.**
MacWeather two-tiers: try `:Unix:weather.json` live first, fall back
to baked `:Shared:weather.json`.

### Mac → JS: extfs writes the host polls (works)

Same `/Shared/` mount, other direction. The Mac writes a file via
`FSWrite` to `:Unix:foo`; the host page polls for it through the
worker's postMessage bridge and reads `/Shared/foo`. This is the base
primitive both the Reader URL bar (#14) and Pixel Pad export (#17)
build on.

### Mac → JS: URL bar request/response

Reader's URL bar uses `:Unix:__url-request.txt` as a request inbox. The
Mac writes `<requestId>\n<url>\n` via `FSWrite`; `shared-poller.ts`
asks the worker to `poll_url_request` every 500 ms. When a request
appears, the main thread fetches the URL, cancelling any older in-flight
fetch with an `AbortController`, and writes the HTML response to
`:Unix:__url-result-<id>.html`. Reader polls for that exact filename and
reads it when it appears. The request ID is load-bearing: it correlates
replies and prevents stale responses from a previous URL from being
misread as the current one.

The fetch runs on the host page, not in the worker. BasiliskII spends
long stretches in `Atomics.wait`; a worker-local `fetch()` needs
microtasks to resolve, so the worker can starve its own network
promises. Let the main thread own the network.

### Mac → JS: Pixel Pad drawing export

Pixel Pad writes `:Unix:__drawing.bin` via `FSWrite`. The file is a
fixed 64×64 1-bit bitmap: 512 bytes total, MSB-first, `0 = white`,
`1 = black`. `drawing-watcher.ts` asks the worker to `poll_drawing`;
the worker reads `/Shared/__drawing.bin` and posts `{ type:
"drawing_data", bytes }` back to the main thread. The host expands the
bits to pixels and renders a live PNG preview below the emulator.

### The visibility issue is real

Don't paper over it. If you're designing something that needs
**writes the Mac sees in the same boot** (host writes a file, the Mac
reads it without a reboot), the extfs path is unreliable today.
Either bake the data onto `:Shared:` at build time and reboot, or
two-tier with a baked fallback. There's a long-standing question on
whether it's a 7.5.5 trap-table issue, a pref-syntax issue, or a
timing issue (`extfs` mount happening after `:System Folder:Startup
Items:` scan). Resolving it is on the TODO list but not blocking the
playground (which uses worker re-spawn + a fresh boot disk per
edit — see [`PLAYGROUND.md`](./PLAYGROUND.md) Phase 3).

## The Ethernet relay (optional)

This path is opt-in. If the page URL has `?zone=<name>` and the build
was produced with `VITE_ETHERNET_WS_BASE`, the main thread enables an
AppleTalk-over-WebSocket relay. If either is missing, BasiliskII's
ethernet hooks stay stubbed and System 7 boots exactly as before.

### RX ring buffer in a SAB

`src/web/src/ethernet.ts` is the shared, no-DOM transport core. The main
thread allocates `ethernetRxBuffer: SharedArrayBuffer(ETHERNET_RX_SAB_SIZE)`
and passes it in the worker `start` message. Layout: 8 header bytes
(`writeIdx`, `readIdx`) plus 16 fixed slots × 1516 bytes, so about
24.3 KiB total. It's a strict single-producer/single-consumer ring:
`rbPush(sab, frame)` runs only on the main thread (WebSocket `message`),
`rbPop(sab, buf)` only on the worker thread (BasiliskII's `etherRead()`),
and the indices use unsigned arithmetic (`>>> 0`) so Int32 wrap-around
is harmless.

### TX path

BasiliskII's `etherWrite()` copies a frame out of the WASM heap and
calls the worker bridge, which posts `{ type: "ethernet_frame", dest,
data }` to the main thread. `EthernetZoneProvider`
(`src/web/src/ethernet-provider.ts`) maintains the zone WebSocket,
auto-reconnects, and sends that JSON to the relay. On the relay side,
`worker/ethernet-zone.ts` hosts the `EthernetZone` Durable Object, which
routes by MAC: broadcast for `*` and `AT`, unicast for specific
destination MACs.

### RX path

Incoming WebSocket frames land on the main thread. `EthernetZoneProvider`
pushes each one into the ring with `rbPush(rxSab, frame)` and then calls
`signalEthernetInterrupt()` so the worker wakes up just like it does for
other host-driven interrupts. BasiliskII's `etherRead()` drains the ring
with `rbPop(rxSab, buf)` and copies the bytes back into the WASM heap.

### Deployment / absence behavior

The relay worker lives under `worker/`, with `worker/wrangler.toml`
providing the Wrangler v3 deployment config. This path is deliberately
optional: no `?zone=`, no `VITE_ETHERNET_WS_BASE`, no networking setup,
no boot failure — the emulator just keeps its stub ethernet methods and
runs normally.

## The multi-app model

`src/app/` is a CMake aggregator with one subdirectory per Mac app.
See [`src/app/README.md`](../src/app/README.md) for the canonical guide.

```
src/app/
  CMakeLists.txt              -> add_subdirectory(reader); add_subdirectory(macweather);
                                add_subdirectory(hello-mac); add_subdirectory(pixelpad);
                                add_subdirectory(markdownviewer);
  reader/
    reader.c                  Toolbox shell (event loop, drawing, menus)
    reader.r                  Rez resources (WIND, MBAR, MENU, ALRT, BNDL/FREF/ICN# as raw data)
    html_parse.{c,h}          pure-C engine, host-testable
    CMakeLists.txt            add_application(Reader CREATOR CVMR ...)
  macweather/
    macweather.c              Toolbox shell
    macweather.r              Rez resources
    weather_parse.{c,h}       pure-C JSON parser (host-testable)
    weather_glyphs.{c,h}      1-bit pixel-art QuickDraw routines
    CMakeLists.txt            add_application(MacWeather CREATOR CVMW ...)
  hello-mac/
    hello.c                   minimal Toolbox shell / starter example
    hello.r                   Rez resources
    CMakeLists.txt            add_application(HelloMac CREATOR CVHM ...)
  pixelpad/
    pixelpad.c                64×64 drawing shell + export hook
    pixelpad.r                Rez resources
    CMakeLists.txt            add_application(PixelPad CREATOR CVPP ...)
  markdownviewer/
    markdownviewer.c          Toolbox shell
    markdownviewer.r          Rez resources
    markdown_parse.{c,h}      pure-C Markdown parser (host-testable)
    CMakeLists.txt            add_application(MarkdownViewer CREATOR CVMV ...)
```

Each app:

- has its own four-letter creator code (Reader=`CVMR`,
  MacWeather=`CVMW`, HelloMac=`CVHM`, PixelPad=`CVPP`,
  MarkdownViewer=`CVMV`) — passed to
  `add_application(... CREATOR XXXX ...)` so the `-c` flag reaches Rez
  and the MacBinary header carries `APPL/XXXX`. Without the creator,
  Finder binding silently no-ops
  (see [`LEARNINGS.md`](../LEARNINGS.md) on BNDL/FREF/ICN#).
- emits `BNDL`, `FREF`, `ICN#` and the signature resource as raw
  `data` blobs in the `.r` file — Retro68's RIncludes don't ship
  `Finder.r` macros, so the bytes are written longhand.
- splits cleanly into a **Toolbox shell** (`<app>.c`) and a **pure-C
  engine** (`html_parse.c`, `weather_parse.c`). The engine compiles
  with both Retro68 and the host `cc`, so `tests/unit/` runs in
  milliseconds without ever touching an emulator. See
  [`tests/README.md`](../tests/README.md).

`scripts/build-boot-disk.sh` takes a comma-separated list of `.bin`
paths and packs all of them into the same boot disk — both
`:System Folder:Startup Items:` (auto-launch) and `:Applications:`
(re-launch from desktop). Adding a new app is one
`add_subdirectory()` line + a directory under `src/app/` + a comma
in CI's invocation.

## The CI pipeline

`.github/workflows/build.yml`. End to end, ~3-4 min on a warm
runner.

```text
push / PR ----+-> Retro68 container (ghcr.io/autc04/retro68:latest)
              |     - apt install hfsutils
              |     - cmake -S src/app -B build (Retro68 toolchain file)
              |     - cmake --build build --parallel
              |       => build/<app>/<App>.{bin,dsk,APPL}
              |
              +-> scripts/build-disk-image.sh => dist/app.dsk (~1.4MB, secondary)
              |
              +-> scripts/build-boot-disk.sh:
              |     - download System 7.5.5 from archive.org (cached, SHA-256 pinned)
              |     - hmount + hcopy each .bin into Startup Items + Applications
              |     - hcopy src/web/public/shared/*.html into :Shared:
              |     - scripts/write-chunked-manifest.py: 256KiB chunks,
              |       blake2b-16 salted "raw", JSON manifest matching
              |       EmulatorChunkedFileSpec
              |       => dist/system755-vibe.dsk{,.json}, dist/system755-vibe-chunks/
              |
              +-> Vite build (src/web/) with VITE_BASE=/<repo>/
              |     - copies dist/app.dsk + dist/system755-vibe.dsk{,.json}
              |       + chunks into src/web/dist/
              |
              +-> if main + non-PR:
                    actions/upload-pages-artifact + actions/deploy-pages
                    => https://<user>.github.io/<repo>/
```

PRs run the full build for CI signal; only `main` deploys. Algorithm
for the chunked manifest is ported from
`mihaip/infinite-mac@30112da0db :: scripts/import-disks.py`.

## Browser APIs we depend on

| API | What for | Notes |
|-----|----------|-------|
| `SharedArrayBuffer` | video framebuffer + input ring shared with worker; optional Ethernet RX ring | Hard requirement for the emulator core. The Ethernet ring is only allocated when zone networking is active, but it still needs cross-origin isolation. |
| `Atomics.wait` / `Atomics.notify` / `Atomics.store` | the four-state input lock between UI and worker; optional ethernet interrupt wake-up | Cyclical lock for input, plus the same wake/signal pattern for `signalEthernetInterrupt()`. The layout still has to match Infinite Mac's `InputBufferAddresses` byte-for-byte. |
| `WebSocket` | optional AppleTalk zone relay on the main thread | Only active when `?zone=` is present and `VITE_ETHERNET_WS_BASE` was compiled in. |
| COOP `same-origin` + COEP `require-corp` (or `credentialless` in dev) | gate for SAB | Vite sets dev headers; GH Pages uses the `coi-serviceworker` shim. |
| Web Worker `type: 'module'` | spawn `emulator-worker.ts` with ES `import()` | All evergreen browsers. Safari got module workers in 15 (2021). |
| `IndexedDB` | playground's editor persistence (Epic #21 Phase 1) | Detect availability — Firefox PB disables it; fall back to in-memory + banner. |
| Synchronous XHR (in worker) | the chunked-disk `read()` BasiliskII calls from Wasm | Deprecated on the main thread; still allowed in workers. |

## What we deliberately avoid

The hard project constraint, restated by the user every time it
matters: **everything runs as JavaScript in the visitor's browser. No
server infrastructure.** Two closed Epics make this concrete:

- **[Epic #12](https://github.com/khawkins98/classic-vibe-mac/issues/12)**
  proposed real Mac TCP/IP via a WebSocket relay. Killed by the
  five-reviewer pass. Three independent show-stoppers:
  Cloudflare's Self-Serve §2.2.1(j) explicitly forbids "VPN or other
  similar proxy services," BasiliskII's `ether js` mode emits L2
  Ethernet frames so a real bridge needs a SLIRP-class userland TCP
  stack on the relay (not "100-200 lines TS"), and iCab 2.x is
  actively-licensed shareware so vendoring it would be unauthorized
  redistribution.
- **[Epic #19](https://github.com/khawkins98/classic-vibe-mac/issues/19)**
  proposed an in-browser IDE with full C compilation. Killed by the
  five-reviewer pass. The two header-line failures: Phase 2C needed
  GitHub OAuth `repo` scope (full read/write on every repo the user
  is in — disproportionate and only achievable via a token-exchange
  relay, which is a backend), and Phase 3 silently assumed an
  in-browser HFS writer that doesn't exist anywhere in the stack.

The constraint isn't a religious one — it's an architectural one
about staying within the deploy target (GitHub Pages, free, no auth,
no abuse surface). When something can't be done in the browser it
either gets reframed (Epic #19 → Epic #21, resource-fork-only, no
GCC, no auth) or deferred indefinitely.

The same constraint rules out, in advance: OAuth flows that need a
secret, custom DNS, VPN/relay services, server-side compilation,
shared databases, anything that puts the maintainer's account or
infra on the line for an abuse complaint. If you find yourself
proposing a worker that proxies anything, stop and re-read this
section.
