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

import { DurableObject } from "cloudflare:workers";

export interface Env {
  ETHERNET_ZONE: DurableObjectNamespace<EthernetZone>;
  /**
   * Optional comma-separated list of allowed page origins
   * (e.g. "https://khawkins98.github.io,http://localhost:5173").
   * When unset, any origin may connect (backwards-compatible default).
   */
  ALLOWED_ORIGINS?: string;
}

/** Allowed zone name characters — prevents path traversal. */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** MAC address strings as sent by the client (hex with optional separators). */
const MAC_RE = /^[0-9a-zA-Z:.-]{1,32}$/;

/** Ethernet frame limits: 14-byte header min, 14 + 1500 payload max. */
const MIN_FRAME = 14;
const MAX_FRAME = 1514;

/**
 * Hard cap on a raw WebSocket message. A 1514-byte frame JSON-encoded as a
 * number array is at most ~5.5 KB; anything much larger is malformed/abusive.
 */
const MAX_MESSAGE_BYTES = 8 * 1024;

/** Maximum simultaneous participants per zone (bounds broadcast fan-out). */
const MAX_CLIENTS_PER_ZONE = 32;

/**
 * Per-socket rate limit (token bucket). 10 Mbit Ethernet tops out around
 * ~800 full-size frames/s, so this is generous for AppleTalk but stops one
 * client from amplifying a flood across the whole zone.
 */
const RATE_FRAMES_PER_SEC = 500;
const RATE_BURST = 1000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/zone\/([^/]+)\/(websocket|list)$/);
    if (!m) return new Response("Not found", { status: 404 });

    let zoneName: string;
    try {
      zoneName = decodeURIComponent(m[1]);
    } catch {
      // Malformed percent-encoding (e.g. "%E0%A4%A") throws URIError.
      return new Response("Invalid zone name", { status: 400 });
    }
    if (!ZONE_NAME_RE.test(zoneName)) {
      return new Response("Invalid zone name", { status: 400 });
    }

    if (m[2] === "websocket") {
      // Reject early so non-upgrade junk never wakes the Durable Object.
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      if (!originAllowed(request, env)) {
        return new Response("Forbidden origin", { status: 403 });
      }
    }

    const stub = env.ETHERNET_ZONE.get(env.ETHERNET_ZONE.idFromName(zoneName));
    return stub.fetch(request);
  },
};

function originAllowed(request: Request, env: Env): boolean {
  const allowed = env.ALLOWED_ORIGINS?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed || allowed.length === 0) return true;
  const origin = request.headers.get("Origin");
  return origin !== null && allowed.includes(origin);
}

/** Per-socket state, persisted via serializeAttachment (survives hibernation). */
type ZoneClient = {
  /** Lowercase MAC address string, e.g. "01:23:45:67:89:ab". "" until init. */
  macAddress: string;
};

type ClientMessage = {
  type?: unknown;
  macAddress?: unknown;
  dest?: unknown;
  packetArray?: unknown;
};

function isValidFrame(a: unknown): a is number[] {
  if (!Array.isArray(a) || a.length < MIN_FRAME || a.length > MAX_FRAME) {
    return false;
  }
  for (const b of a) {
    if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
      return false;
    }
  }
  return true;
}

export class EthernetZone extends DurableObject<Env> {
  /**
   * In-memory token buckets. Lost on hibernation, which is fine: a socket
   * idle long enough for the DO to hibernate would have a full bucket anyway.
   */
  #buckets = new WeakMap<WebSocket, { tokens: number; last: number }>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Debug: list connected MAC addresses.
    if (url.pathname.endsWith("/list")) {
      const macs = this.ctx
        .getWebSockets()
        .map((ws) => this.#client(ws)?.macAddress ?? "")
        .filter(Boolean);
      return Response.json(macs);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    if (this.ctx.getWebSockets().length >= MAX_CLIENTS_PER_ZONE) {
      return new Response("Zone is full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Hibernatable accept: the DO can be evicted from memory while sockets
    // stay open, so idle zones don't accrue duration charges. Per-socket
    // state lives in the attachment so it survives hibernation.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ macAddress: "" } satisfies ZoneClient);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) {
      ws.close(1009, "Message too large or not text");
      return;
    }

    let msg: ClientMessage;
    try {
      msg = JSON.parse(data) as ClientMessage;
    } catch {
      return; // ignore malformed JSON
    }
    if (!msg || typeof msg !== "object") return;

    const entry = this.#client(ws);
    if (!entry) return;

    switch (msg.type) {
      case "init": {
        // One init per socket, so a client can't hop between MACs.
        if (entry.macAddress) return;
        if (typeof msg.macAddress !== "string" || !MAC_RE.test(msg.macAddress)) {
          ws.close(1008, "Invalid MAC address");
          return;
        }
        ws.serializeAttachment({
          macAddress: msg.macAddress.toLowerCase(),
        } satisfies ZoneClient);
        break;
      }

      case "send": {
        if (!entry.macAddress) return; // must init first
        if (!isValidFrame(msg.packetArray)) return;
        const dest = typeof msg.dest === "string" ? msg.dest : "*";
        if (dest.length > 32) return;
        if (!this.#takeToken(ws)) return; // rate limited: drop frame
        this.#route(ws, dest, msg.packetArray);
        break;
      }

      case "close":
        ws.close(1000, "Client requested close");
        break;
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Reciprocate the close handshake. 1005/1006 are reserved and can't be sent.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "WebSocket error");
    } catch {
      /* already closed */
    }
  }

  #client(ws: WebSocket): ZoneClient | null {
    return (ws.deserializeAttachment() as ZoneClient | null) ?? null;
  }

  #takeToken(ws: WebSocket): boolean {
    const now = Date.now();
    let b = this.#buckets.get(ws);
    if (!b) {
      b = { tokens: RATE_BURST, last: now };
      this.#buckets.set(ws, b);
    }
    b.tokens = Math.min(
      RATE_BURST,
      b.tokens + ((now - b.last) / 1000) * RATE_FRAMES_PER_SEC,
    );
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  #route(sender: WebSocket, dest: string, packetArray: number[]): void {
    const payload = JSON.stringify({ type: "receive", packetArray });
    const destNorm = dest.toLowerCase();
    const isBroadcast = destNorm === "*" || destNorm === "at";

    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue; // never echo back to sender
      const entry = this.#client(ws);
      if (!entry?.macAddress) continue; // not yet initialised
      if (isBroadcast || destNorm === entry.macAddress) {
        try {
          ws.send(payload);
        } catch {
          /* peer socket is closing; webSocketClose will clean up */
        }
      }
    }
  }
}
