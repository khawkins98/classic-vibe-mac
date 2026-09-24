/**
 * settings.test.mjs — unit tests for src/web/src/settings.ts.
 *
 * Shims `localStorage` and `window` (an EventTarget, for the cross-tab
 * `storage` listener) before importing the module. Covers defaults,
 * persistence, corrupt-value handling, throwing-storage fallbacks, and
 * listener subscribe / unsubscribe / cross-tab fan-out.
 *
 * Run as: node --test tests/unit/settings.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { transpileWeb } from "./_transpile.mjs";

class MemStorage {
  constructor() { this.m = new Map(); this.throwing = false; }
  getItem(k) { if (this.throwing) throw new Error("denied"); return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { if (this.throwing) throw new Error("denied"); this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const storage = new MemStorage();
const win = new EventTarget();
Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
Object.defineProperty(globalThis, "window", { value: win, configurable: true });

const url = transpileWeb(["settings.ts"]);
const s = await import(url("settings.ts"));

function storageEvent(key) {
  const ev = new Event("storage");
  ev.key = key;
  return ev;
}

beforeEach(() => {
  storage.clear();
  storage.throwing = false;
});

test("pauseWhenHidden defaults to true", () => {
  assert.equal(s.isPauseWhenHiddenEnabled(), true);
});

test("pauseWhenHidden persists false/true", () => {
  s.setPauseWhenHidden(false);
  assert.equal(storage.getItem("cvm.pauseWhenHidden"), "false");
  assert.equal(s.isPauseWhenHiddenEnabled(), false);
  s.setPauseWhenHidden(true);
  assert.equal(s.isPauseWhenHiddenEnabled(), true);
});

test("pauseWhenHidden treats any non-'false' value as enabled", () => {
  storage.setItem("cvm.pauseWhenHidden", "garbage");
  assert.equal(s.isPauseWhenHiddenEnabled(), true);
});

test("pauseWhenHidden defaults ON when storage throws, and still notifies", () => {
  storage.throwing = true;
  assert.equal(s.isPauseWhenHiddenEnabled(), true);
  let calls = 0;
  const off = s.onPauseWhenHiddenChange(() => calls++);
  assert.doesNotThrow(() => s.setPauseWhenHidden(false));
  assert.equal(calls, 1);
  off();
});

test("optLevel defaults to O0 and only accepts Os / O2", () => {
  assert.equal(s.getOptLevel(), "O0");
  s.setOptLevel("Os");
  assert.equal(s.getOptLevel(), "Os");
  s.setOptLevel("O2");
  assert.equal(s.getOptLevel(), "O2");
  storage.setItem("cvm.optLevel", "O3");
  assert.equal(s.getOptLevel(), "O0");
  storage.throwing = true;
  assert.equal(s.getOptLevel(), "O0");
});

test("listeners fire on set and stop after unsubscribe", () => {
  let pause = 0;
  let opt = 0;
  const offP = s.onPauseWhenHiddenChange(() => pause++);
  const offO = s.onOptLevelChange(() => opt++);
  s.setPauseWhenHidden(false);
  s.setOptLevel("O2");
  assert.deepEqual([pause, opt], [1, 1], "each setter only fires its own listeners");
  offP();
  offO();
  s.setPauseWhenHidden(true);
  s.setOptLevel("O0");
  assert.deepEqual([pause, opt], [1, 1]);
});

test("cross-tab storage events route to the matching listener set", () => {
  let pause = 0;
  let opt = 0;
  const offP = s.onPauseWhenHiddenChange(() => pause++);
  const offO = s.onOptLevelChange(() => opt++);
  win.dispatchEvent(storageEvent("cvm.pauseWhenHidden"));
  assert.deepEqual([pause, opt], [1, 0]);
  win.dispatchEvent(storageEvent("cvm.optLevel"));
  assert.deepEqual([pause, opt], [1, 1]);
  win.dispatchEvent(storageEvent("some.other.key"));
  assert.deepEqual([pause, opt], [1, 1]);
  offP();
  offO();
});
