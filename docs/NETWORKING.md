# Networking

`classic-vibe-mac` can optionally relay AppleTalk traffic between multiple in-browser Macs. If two or more browser tabs — or two or more visitors — load the emulator with the same `?zone=` value, their sessions join the same named Ethernet relay and can see each other as peers on that virtual LAN.

This is **opt-in**:

- No `?zone=` parameter: the emulator boots normally, with Ethernet stubbed out.
- `?zone=` present but no relay configured: the emulator still boots normally, with Ethernet disabled.

The relay is a Cloudflare Durable Object that forwards raw layer-2 Ethernet frames between members of the same zone. It does **not** give the guest Mac general internet access — it only links Macs that joined the same zone.

For the implementation deep-dive, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Quick start

As a visitor, joining a zone is just a URL change:

```text
https://khawkins98.github.io/classic-vibe-mac/?zone=myfriends
```

If another browser tab or another visitor loads the same deployment with the same zone name, those Macs join the same AppleTalk network.

A few important caveats:

- The site must be built with `VITE_ETHERNET_WS_BASE` set.
- A compatible zone relay must actually be deployed and reachable at that URL.
- If either of those is missing, Ethernet stays disabled and the emulator falls back to its normal single-user behavior.
- Zone names must match `^[a-zA-Z0-9_-]{1,64}$`. Invalid names are rejected client-side and server-side.

If you are using the official deployment, check whether the deployment you are visiting was built with a zone relay configured. If not, `?zone=` will not do anything yet.

## Deploying the zone relay

To enable networking on your own deployment, you need to deploy the Cloudflare Worker/Durable Object relay and point the Vite app at it.

### 1) Install Wrangler

Use a global install or `npx`:

```sh
npm install -g wrangler
```

Or skip the global install and use `npx wrangler` in the steps below.

### 2) Log in to Cloudflare

```sh
wrangler login
```

### 3) Deploy the Worker

```sh
cd worker
npx wrangler deploy
```

This uses `worker/wrangler.toml` and deploys the Durable Object defined in `worker/ethernet-zone.ts`.

### 4) Note the deployed URL

After deploy, Wrangler will print a Worker URL similar to:

```text
https://classic-vibe-mac-ethernet.<your-account>.workers.dev
```

For the browser app, you will use the WebSocket form of that base URL:

```text
wss://classic-vibe-mac-ethernet.<your-account>.workers.dev
```

### 5) Set `VITE_ETHERNET_WS_BASE`

Create a `.env.local` file at the project root:

```dotenv
VITE_ETHERNET_WS_BASE=wss://classic-vibe-mac-ethernet.<your-account>.workers.dev
```

The app derives per-zone WebSocket endpoints from this base as:

```text
${VITE_ETHERNET_WS_BASE}/zone/<zone-name>/websocket
```

### 6) Rebuild and redeploy the site

Rebuild the Vite app and redeploy your static site as you normally would.

```sh
npm run build
```

Without rebuilding, the client will not see the new environment variable.

### 7) Test locally

Run the relay locally:

```sh
cd worker
npx wrangler dev
```

Point the web app at the local Worker in `.env.local`:

```dotenv
VITE_ETHERNET_WS_BASE=ws://localhost:8787
```

Then start the site from the project root:

```sh
npm run dev
```

Open two tabs with the same `?zone=` and test AppleTalk inside System 7.5.5.

## Using it in System 7.5.5

Once both visitors are in the same zone:

1. Load the same emulator URL with the same `?zone=<name>` value.
2. In System 7.5.5, open **Apple menu → Chooser**.
3. Turn **AppleTalk** on.
4. Open AppleShare or another network-aware app.
5. If other Macs are present in the same zone, they should appear there.

Zone names are just shared strings. Pick any short, memorable name and give it to everyone who should join the same virtual network.

## Architecture

At a high level, the browser page owns the network connection, the worker owns the BasiliskII/WASM instance, and a `SharedArrayBuffer` ring buffer bridges inbound Ethernet frames into the emulator.

```text
Mac in browser tab A
  -> BasiliskII etherWrite()
  -> worker posts ethernet_frame
  -> main thread sends JSON over WebSocket
  -> Cloudflare Durable Object relay
  -> WebSocket to browser tab B
  -> main thread rbPush(rxSab, frame)
  -> signalEthernetInterrupt()
  -> worker rbPop(...)
  -> BasiliskII etherRead()
  -> Mac in browser tab B
```

### End-to-end flow

1. A visitor loads a URL like `?zone=myfriends`.
2. `src/web/src/emulator-loader.ts` reads the `zone` query parameter and `VITE_ETHERNET_WS_BASE`.
3. If both are valid, it allocates an RX `SharedArrayBuffer` (`ETHERNET_RX_SAB_SIZE`, about 24 KB), creates an `EthernetZoneProvider`, and passes the SAB to the worker.
4. When BasiliskII's Ethernet driver initializes, the worker posts `ethernet_init { macAddress }`, and the main thread opens the zone WebSocket.
5. **TX path:** `etherWrite(dest, ptr, len)` copies a frame out of the WASM heap, posts it to the main thread, and the main thread sends `{ type: "send", dest, packetArray }` to the relay.
6. **RX path:** the relay sends `{ type: "receive", packetArray }`, the main thread enqueues it with `rbPush(...)`, wakes the emulator with `signalEthernetInterrupt()`, and the worker later drains it via `rbPop(...)` inside `etherRead(ptr, max)`.
7. `worker/ethernet-zone.ts` routes broadcast traffic for `"*"` and `"AT"`, routes unicast by MAC address, and never echoes a frame back to the sender.

### SPSC ring buffer

The receive path uses the SPSC ring buffer in `src/web/src/ethernet.ts`:

- 16 slots × 1516 bytes each = about 24.3 KB total SAB
- Each slot stores a 2-byte big-endian frame length plus up to 1514 bytes of frame data
- Sequence counters are `Int32` values in shared memory but compared as unsigned via `>>> 0`
- The main thread is the sole producer; the worker is the sole consumer

This keeps the hot receive path simple and lock-free.

### Durable Object routing

`worker/ethernet-zone.ts` is the zone relay:

- One Durable Object instance per zone name
- WebSocket clients identify themselves with a MAC address
- `dest="*"` or `dest="AT"` broadcasts to every other peer in the zone
- `dest=<MAC>` unicasts to a matching peer
- The sender never receives its own frame back

Primary source files:

- `src/web/src/ethernet.ts`
- `src/web/src/ethernet-provider.ts`
- `worker/ethernet-zone.ts`
- `worker/wrangler.toml`

For the broader emulator design and boot pipeline, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Limitations and considerations

- **Privacy:** zone names are not secret. Anyone who guesses the same zone name can join.
- **No Mac-side internet:** this is only a peer-to-peer layer-2 relay between zone members.
- **Max frame size:** frames larger than 1514 bytes are dropped.
- **Ring capacity:** only 16 frames can be queued at once; if the guest falls behind, later frames are dropped.
- **Reconnect behavior:** the browser provider automatically reconnects after disconnects with a 1 second backoff.
- **Validation:** invalid zone names leave Ethernet stubbed out instead of partially connecting.

## Tips

- Use short, memorable zone names for ad-hoc testing.
- Open two tabs side by side to test quickly before trying multiple devices.
- If networking does not appear to work, first confirm the deployment was built with `VITE_ETHERNET_WS_BASE` and that the Cloudflare relay is live.
