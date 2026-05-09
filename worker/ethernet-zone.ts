/**
 * ethernet-zone.ts — Cloudflare Durable Object that relays L2 Ethernet frames
 * between all visitors connected to the same "zone".
 *
 * Deploy this with Wrangler (see wrangler.toml in this directory).
 *
 * URL scheme:
 *   GET /zone/:name/websocket  → WebSocket upgrade (zone participant)
 *   GET /zone/:name/list       → JSON array of connected MAC addresses (debug)
 *
 * JSON message protocol (all messages are JSON strings over WebSocket):
 *
 *   Client → server:
 *     { type: "init", macAddress: string }
 *       — Register this client's MAC address.  Must be the first message.
 *     { type: "send", dest: string, packetArray: number[] }
 *       — Relay an Ethernet frame. `dest` controls routing (see below).
 *     { type: "close" }
 *       — Politely disconnect.
 *
 *   Server → client:
 *     { type: "receive", packetArray: number[] }
 *       — A frame destined for this client.
 *
 * Routing (the `dest` field):
 *   "*"        → broadcast to every other client in the zone
 *   "AT"       → AppleTalk broadcast (synonym for "*")
 *   <MAC>      → unicast to the client whose MAC matches (case-insensitive);
 *                 frame is dropped if no match is found
 *
 * Ported from mihaip/infinite-mac worker/ethernet-zone.ts.
 * License: Apache-2.0.
 */

export interface Env {
  ETHERNET_ZONE: DurableObjectNamespace;
}

/** Allowed zone name characters — prevents path traversal. */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/zone\/([^/]+)\/(websocket|list)$/);
    if (!m) return new Response("Not found", { status: 404 });

    const zoneName = decodeURIComponent(m[1]);
    if (!ZONE_NAME_RE.test(zoneName)) {
      return new Response("Invalid zone name", { status: 400 });
    }

    const id = env.ETHERNET_ZONE.idFromName(zoneName);
    const stub = env.ETHERNET_ZONE.get(id);
    return stub.fetch(request);
  },
};

type ZoneClient = {
  /** Lowercase hex MAC address string, e.g. "01:23:45:67:89:ab". */
  macAddress: string;
};

export class EthernetZone implements DurableObject {
  #clients = new Map<WebSocket, ZoneClient>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Debug: list connected MAC addresses.
    if (url.pathname.endsWith("/list")) {
      const macs = Array.from(this.#clients.values()).map((c) => c.macAddress);
      return new Response(JSON.stringify(macs), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.#clients.set(server, { macAddress: "" });
    server.accept();

    server.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data as string) as {
          type: string;
          macAddress?: string;
          dest?: string;
          packetArray?: number[];
        };
        switch (msg.type) {
          case "init":
            if (msg.macAddress) {
              const entry = this.#clients.get(server);
              if (entry) entry.macAddress = msg.macAddress.toLowerCase();
            }
            break;

          case "send":
            if (msg.packetArray) {
              this.#route(server, msg.dest ?? "*", msg.packetArray);
            }
            break;

          case "close":
            this.#clients.delete(server);
            server.close();
            break;
        }
      } catch {
        /* ignore parse errors */
      }
    });

    server.addEventListener("close", () => this.#clients.delete(server));
    server.addEventListener("error", () => this.#clients.delete(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  #route(sender: WebSocket, dest: string, packetArray: number[]): void {
    const payload = JSON.stringify({ type: "receive", packetArray });
    const destNorm = dest.toLowerCase();
    const isBroadcast = destNorm === "*" || destNorm === "at";

    for (const [ws, entry] of this.#clients) {
      if (ws === sender) continue; // never echo back to sender
      if (isBroadcast || destNorm === entry.macAddress) {
        ws.send(payload);
      }
    }
  }
}
