#!/usr/bin/env node
// Smoke test for the Ethernet zone relay. Run against `npx wrangler dev`:
//   cd worker && npx wrangler dev --port 8787
//   node scripts/smoke.mjs [ws://localhost:8787]
// Requires Node 22+ (global WebSocket).

const BASE = process.argv[2] ?? "ws://localhost:8787";
const HTTP = BASE.replace(/^ws/, "http");
const zone = `smoke-${Date.now()}`;
const url = `${BASE}/zone/${zone}/websocket`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const report = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.received = [];
    ws.closeInfo = null;
    ws.addEventListener("message", (e) => ws.received.push(JSON.parse(e.data)));
    ws.addEventListener("close", (e) => (ws.closeInfo = { code: e.code, reason: e.reason }));
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
  });
}

async function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

const frame = (n = 60, tag = 0) => {
  const a = new Array(n).fill(0);
  a[0] = 0xff; a[1] = 0xff; a[2] = 0xff; a[3] = 0xff; a[4] = 0xff; a[5] = 0xff;
  a[12] = 0x80; a[13] = 0x9b;
  a[14] = tag & 0xff; a[15] = (tag >> 8) & 0xff;
  return a;
};

const MAC_A = "02:00:00:00:00:0a";
const MAC_B = "02:00:00:00:00:0b";

// 1. Relay A -> B (broadcast and unicast), no echo to sender.
const a = await open();
const b = await open();
a.send(JSON.stringify({ type: "init", macAddress: MAC_A }));
b.send(JSON.stringify({ type: "init", macAddress: MAC_B }));
await sleep(100);
a.send(JSON.stringify({ type: "send", dest: "*", packetArray: frame(60, 1) }));
let ok = await waitFor(() => b.received.some((m) => m.type === "receive" && m.packetArray[14] === 1));
report("broadcast frame A->B delivered", ok);
a.send(JSON.stringify({ type: "send", dest: MAC_B.toUpperCase(), packetArray: frame(60, 2) }));
ok = await waitFor(() => b.received.some((m) => m.packetArray?.[14] === 2));
report("unicast frame A->B (case-insensitive MAC) delivered", ok);
await sleep(100);
report("sender does not receive its own frame", a.received.length === 0, `A got ${a.received.length}`);

// 2. /list endpoint is gone.
const listRes = await fetch(`${HTTP}/zone/${zone}/list`);
report("/zone/:name/list returns 404", listRes.status === 404, `status ${listRes.status}`);

// 3. Oversized message -> close 1009.
const big = await open();
big.send(JSON.stringify({ type: "init", macAddress: "02:00:00:00:00:0c" }));
big.send("x".repeat(9 * 1024));
ok = await waitFor(() => big.closeInfo !== null);
report("oversized message closes with 1009", ok && big.closeInfo.code === 1009, JSON.stringify(big.closeInfo));

// 4. Invalid MAC init -> close 1008.
const bad = await open();
bad.send(JSON.stringify({ type: "init", macAddress: "not a mac!!" }));
ok = await waitFor(() => bad.closeInfo !== null);
report("invalid MAC init closes with 1008", ok && bad.closeInfo.code === 1008, JSON.stringify(bad.closeInfo));

// 5. Flood > rate limit (burst 1000, 500/s) -> drops.
b.received.length = 0;
const N = 3000;
const f = frame(60, 9);
const t0 = Date.now();
for (let i = 0; i < N; i++) a.send(JSON.stringify({ type: "send", dest: MAC_B, packetArray: f }));
await waitFor(() => false, 3000); // let the relay drain
const got = b.received.length;
const elapsed = (Date.now() - t0) / 1000;
report(
  "flood is rate-limited (some frames dropped)",
  got > 0 && got < N,
  `sent ${N}, B received ${got} in ~${elapsed.toFixed(1)}s`,
);

for (const ws of [a, b]) ws.close();
await sleep(100);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
