/**
 * ethernet-provider.ts — WebSocket-backed Ethernet zone provider.
 *
 * Runs on the **main thread** only. Connects to a Cloudflare Durable Object
 * zone relay via WebSocket, and bridges frames between the relay and the SAB
 * ring buffer (see ethernet.ts).
 *
 * Zone WebSocket URL is derived from VITE_ETHERNET_WS_BASE (build-time env):
 *   `${VITE_ETHERNET_WS_BASE}/zone/${zoneName}/websocket`
 *
 * Usage:
 *   1. Allocate `new SharedArrayBuffer(ETHERNET_RX_SAB_SIZE)` in the main thread.
 *   2. Pass it to the worker in the `start` message as `ethernetRxBuffer`.
 *   3. Construct `new EthernetZoneProvider(rxSab, zoneWsUrl)`.
 *   4. When the worker sends `ethernet_init { macAddress }`, call
 *      `provider.connect(macAddress)`.
 *   5. When the worker sends `ethernet_frame { dest, data }`, call
 *      `provider.send(dest, data)`.
 *   6. On session dispose, call `provider.dispose()`.
 *
 * License: Apache-2.0. Adapted from mihaip/infinite-mac.
 */

import { rbPush } from "./ethernet";
import { signalEthernetInterrupt } from "./emulator-input";

/** Regex for valid zone names (prevent path injection). */
const ZONE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Derive the WebSocket URL for a zone from the Vite env variable
 * `VITE_ETHERNET_WS_BASE`.  Returns `null` if the env var is absent or
 * the zone name is invalid.
 */
export function makeZoneWsUrl(zone: string): string | null {
  const wsBase = (import.meta.env as Record<string, unknown>).VITE_ETHERNET_WS_BASE as
    | string
    | undefined;
  if (!wsBase) {
    console.warn(
      "[ethernet] VITE_ETHERNET_WS_BASE is not set — ethernet zone disabled. " +
        "Set it to your Cloudflare Worker URL (e.g. wss://ethernet.example.workers.dev).",
    );
    return null;
  }
  if (!ZONE_NAME_RE.test(zone)) {
    console.warn(`[ethernet] invalid zone name "${zone}" — ethernet zone disabled.`);
    return null;
  }
  return `${wsBase}/zone/${encodeURIComponent(zone)}/websocket`;
}

/**
 * Connects to the Cloudflare Durable Object zone relay via WebSocket and
 * bridges frames between the relay and the SAB ring buffer.
 *
 * JSON protocol:
 *   Client → server: `{ type: "init", macAddress: string }`
 *   Client → server: `{ type: "send", dest: string, packetArray: number[] }`
 *   Server → client: `{ type: "receive", packetArray: number[] }`
 */
export class EthernetZoneProvider {
  readonly #rxSab: SharedArrayBuffer;
  readonly #zoneUrl: string;
  #ws: WebSocket | null = null;
  #macAddress = "";
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rxSab: SharedArrayBuffer, zoneUrl: string) {
    this.#rxSab = rxSab;
    this.#zoneUrl = zoneUrl;
  }

  /**
   * Connect to the zone using the given MAC address string.
   * Called when the worker sends `ethernet_init { macAddress }`.
   */
  connect(macAddress: string): void {
    this.#macAddress = macAddress;
    this.#open();
  }

  /**
   * Send a TX frame to the zone relay.
   * Called when the worker sends `ethernet_frame { dest, data }`.
   */
  send(dest: string, frame: Uint8Array): void {
    if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(
      JSON.stringify({
        type: "send",
        dest,
        packetArray: Array.from(frame),
      }),
    );
  }

  /** Tear down the connection (called on session dispose). */
  dispose(): void {
    this.#closed = true;
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#ws?.close();
    this.#ws = null;
  }

  #open(): void {
    if (this.#closed) return;
    const ws = new WebSocket(this.#zoneUrl);
    this.#ws = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "init", macAddress: this.#macAddress }));
      console.log(`[ethernet] connected to zone (MAC ${this.#macAddress})`);
    });

    ws.addEventListener("message", (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data as string) as {
          type: string;
          packetArray?: number[];
        };
        if (msg.type === "receive" && msg.packetArray) {
          const frame = new Uint8Array(msg.packetArray);
          if (rbPush(this.#rxSab, frame)) {
            signalEthernetInterrupt();
          }
          // If ring was full, the frame is dropped. BasiliskII will see the
          // gap during its next etherRead poll (same as any packet loss).
        }
      } catch {
        /* ignore parse errors */
      }
    });

    ws.addEventListener("error", () => {
      console.warn("[ethernet] WebSocket error");
    });

    ws.addEventListener("close", () => {
      if (!this.#closed) {
        console.warn("[ethernet] WebSocket closed — reconnecting in 1 s");
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = null;
          this.#open();
        }, 1000);
      }
    });
  }
}
