/**
 * polling-watcher.test.mjs — unit tests for src/web/src/pollingWatcher.ts
 * and src/web/src/playground/fetchStats.ts.
 *
 * pollingWatcher: uses node:test mock timers for setInterval and a fake
 * Worker (an EventTarget with postMessage) to check fire-immediately,
 * interval ticks, reply-type filtering, and that stop() both clears the
 * timer and detaches the message listener.
 *
 * fetchStats: checks accumulation, read-and-reset, in-flight tracking,
 * and that a rejected fetch still decrements the in-flight counter.
 *
 * Run as: node --test tests/unit/polling-watcher.test.mjs
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { transpileWeb } from "./_transpile.mjs";

// pollingWatcher calls window.setInterval / window.clearInterval.
// Delegate lazily so mock.timers (which patches globalThis) applies.
Object.defineProperty(globalThis, "window", {
  value: {
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (h) => globalThis.clearInterval(h),
  },
  configurable: true,
});

const url = transpileWeb(["pollingWatcher.ts", "playground/fetchStats.ts"]);
const { createPollingWatcher } = await import(url("pollingWatcher.ts"));
const fetchStats = await import(url("playground/fetchStats.ts"));

class FakeWorker extends EventTarget {
  constructor() { super(); this.posted = []; this.listeners = 0; }
  postMessage(m) { this.posted.push(m); }
  addEventListener(t, fn) { if (t === "message") this.listeners++; super.addEventListener(t, fn); }
  removeEventListener(t, fn) { if (t === "message") this.listeners--; super.removeEventListener(t, fn); }
  reply(data) { const ev = new Event("message"); ev.data = data; this.dispatchEvent(ev); }
}

test("polls immediately, then every interval; stop() clears timer + listener", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const w = new FakeWorker();
    let n = 0;
    const stop = createPollingWatcher({
      worker: w,
      buildPollMessage: () => ({ type: "poll_x", n: n++ }),
      replyType: "x_data",
      onReply: () => {},
      intervalMs: 500,
    });
    assert.deepEqual(w.posted, [{ type: "poll_x", n: 0 }]);
    assert.equal(w.listeners, 1);
    mock.timers.tick(499);
    assert.equal(w.posted.length, 1);
    mock.timers.tick(1);
    mock.timers.tick(500);
    assert.deepEqual(w.posted.map((m) => m.n), [0, 1, 2], "message rebuilt each tick");
    stop();
    assert.equal(w.listeners, 0);
    mock.timers.tick(5000);
    assert.equal(w.posted.length, 3);
  } finally {
    mock.timers.reset();
  }
});

test("fireImmediately:false waits for the first tick; default interval is 2000ms", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const w = new FakeWorker();
    const stop = createPollingWatcher({
      worker: w,
      buildPollMessage: () => ({ type: "poll_x" }),
      replyType: "x_data",
      onReply: () => {},
      fireImmediately: false,
    });
    assert.equal(w.posted.length, 0);
    mock.timers.tick(1999);
    assert.equal(w.posted.length, 0);
    mock.timers.tick(1);
    assert.equal(w.posted.length, 1);
    stop();
  } finally {
    mock.timers.reset();
  }
});

test("onReply only sees matching reply types, and none after stop()", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const w = new FakeWorker();
    const seen = [];
    const stop = createPollingWatcher({
      worker: w,
      buildPollMessage: () => ({ type: "poll_x" }),
      replyType: "x_data",
      onReply: (d) => seen.push(d),
    });
    w.reply({ type: "other_data", v: 1 });
    w.reply(null);
    w.reply(undefined);
    w.reply({ type: "x_data", v: 2 });
    assert.deepEqual(seen, [{ type: "x_data", v: 2 }]);
    stop();
    w.reply({ type: "x_data", v: 3 });
    assert.equal(seen.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test("fetchStats: accumulates, peeks, consumes-and-resets, tracks in-flight", async () => {
  fetchStats.consumeFetchMs();
  assert.equal(fetchStats.isAnyFetchInflight(), false);
  let release;
  const gate = new Promise((r) => { release = r; });
  const p = fetchStats.timeFetch("slow", () => gate.then(() => "ok"));
  assert.equal(fetchStats.isAnyFetchInflight(), true);
  release();
  assert.equal(await p, "ok");
  assert.equal(fetchStats.isAnyFetchInflight(), false);
  const peek = fetchStats.peekFetchMs();
  assert.ok(peek >= 0);
  assert.equal(fetchStats.peekFetchMs(), peek, "peek does not reset");
  assert.equal(fetchStats.consumeFetchMs(), peek);
  assert.equal(fetchStats.peekFetchMs(), 0, "consume resets");
});

test("fetchStats: rejected fetch propagates and still clears in-flight", async () => {
  await assert.rejects(
    fetchStats.timeFetch("boom", async () => { throw new Error("net down"); }),
    /net down/,
  );
  assert.equal(fetchStats.isAnyFetchInflight(), false);
});
