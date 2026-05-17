/**
 * Tests for resourceForkMerger.mjs (#280 Path B Phase 2A).
 *
 * Validates: decode → re-encode round-trip preserves resources; merge
 * with conflict resolution (first-fork wins); empty-fork edge cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeResourceForks,
  decodeResourceFork,
  encodeResourceFork,
} from "../../src/web/src/playground/resourceForkMerger.mjs";

const r = (type, id, dataStr, name = null, attrs = 0) => ({
  type,
  id,
  name,
  attrs,
  data: new TextEncoder().encode(dataStr),
});

const eq = (a, b) =>
  assert.equal(a.length, b.length, `data length: ${a.length} vs ${b.length}`)
  || a.every((v, i) => v === b[i]);

test("encode → decode round-trip preserves resources", () => {
  const input = [
    r("PICT", 128, "pict-data-128"),
    r("PICT", 129, "pict-data-129"),
    r("snd ", 1000, "snd-data"),
  ];
  const fork = encodeResourceFork(input);
  const decoded = decodeResourceFork(fork);
  assert.equal(decoded.length, 3);
  // Sort both by (type, id) since encode preserves grouping but the test
  // input might be in mixed order.
  const sortKey = (x) => `${x.type}:${x.id}`;
  const sortedIn = [...input].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const sortedOut = [...decoded].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (let i = 0; i < sortedIn.length; i++) {
    assert.equal(sortedOut[i].type, sortedIn[i].type);
    assert.equal(sortedOut[i].id, sortedIn[i].id);
    assert.deepEqual(
      [...sortedOut[i].data],
      [...sortedIn[i].data],
      `data for ${sortedIn[i].type} ${sortedIn[i].id}`,
    );
  }
});

test("encode preserves resource names", () => {
  const input = [
    r("STR ", 128, "hello world", "Greeting"),
    r("STR ", 129, "goodbye", null), // unnamed
    r("STR ", 130, "hi again", "Hi"),
  ];
  const fork = encodeResourceFork(input);
  const decoded = decodeResourceFork(fork);
  const map = new Map(decoded.map((d) => [d.id, d]));
  assert.equal(map.get(128).name, "Greeting");
  assert.equal(map.get(129).name, null);
  assert.equal(map.get(130).name, "Hi");
});

test("encode preserves resource attributes", () => {
  const input = [
    r("CODE", 1, "code-data", null, 0x40), // resPurgeable
    r("CODE", 2, "code-data-2", null, 0x20), // resLocked
  ];
  const fork = encodeResourceFork(input);
  const decoded = decodeResourceFork(fork);
  const map = new Map(decoded.map((d) => [d.id, d]));
  assert.equal(map.get(1).attrs, 0x40);
  assert.equal(map.get(2).attrs, 0x20);
});

test("merge: first-fork wins on (type, id) conflict", () => {
  const a = encodeResourceFork([
    r("PICT", 128, "user-rez-pict"),
    r("STR ", 128, "user-rez-str"),
  ]);
  const b = encodeResourceFork([
    r("PICT", 128, "upstream-pict"),     // conflict: 'a' wins
    r("PICT", 129, "upstream-pict-129"), // unique: added
    r("snd ", 1000, "upstream-snd"),     // unique: added
  ]);
  const merged = mergeResourceForks([a, b]);
  const decoded = decodeResourceFork(merged);
  assert.equal(decoded.length, 4);
  const pickByKey = (type, id) =>
    decoded.find((r) => r.type === type && r.id === id);
  // a wins on PICT 128
  assert.equal(
    new TextDecoder().decode(pickByKey("PICT", 128).data),
    "user-rez-pict",
  );
  // b's unique entries land
  assert.equal(
    new TextDecoder().decode(pickByKey("PICT", 129).data),
    "upstream-pict-129",
  );
  assert.equal(
    new TextDecoder().decode(pickByKey("snd ", 1000).data),
    "upstream-snd",
  );
  // a's other unique entry kept
  assert.equal(
    new TextDecoder().decode(pickByKey("STR ", 128).data),
    "user-rez-str",
  );
});

test("merge: empty input array returns a valid empty fork", () => {
  const merged = mergeResourceForks([]);
  const decoded = decodeResourceFork(merged);
  assert.equal(decoded.length, 0);
});

test("merge: single fork returns equivalent fork", () => {
  const input = [r("PICT", 128, "lone")];
  const original = encodeResourceFork(input);
  const merged = mergeResourceForks([original]);
  const decoded = decodeResourceFork(merged);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].type, "PICT");
  assert.equal(decoded[0].id, 128);
  assert.equal(new TextDecoder().decode(decoded[0].data), "lone");
});

test("merge: many forks, many conflicts", () => {
  const f1 = encodeResourceFork([r("STR ", 1, "A1"), r("STR ", 2, "A2")]);
  const f2 = encodeResourceFork([r("STR ", 1, "B1"), r("STR ", 3, "B3")]);
  const f3 = encodeResourceFork([r("STR ", 2, "C2"), r("STR ", 3, "C3"), r("STR ", 4, "C4")]);
  const merged = mergeResourceForks([f1, f2, f3]);
  const decoded = decodeResourceFork(merged);
  const byId = new Map(decoded.map((d) => [d.id, new TextDecoder().decode(d.data)]));
  // f1 wins on 1 + 2; f2 wins on 3 (since f3 comes after); f3 unique on 4
  assert.equal(byId.get(1), "A1");
  assert.equal(byId.get(2), "A2");
  assert.equal(byId.get(3), "B3");
  assert.equal(byId.get(4), "C4");
  assert.equal(decoded.length, 4);
});

test("decode: handles multi-type fork (CODE/DATA/RELA pattern)", () => {
  // Mimics what wasm-cc1 + ld + Elf2Mac actually produce for a small app.
  const input = [];
  for (let i = 0; i < 9; i++) input.push(r("CODE", i, `code-segment-${i}`));
  input.push(r("DATA", 0, "data-segment-init"));
  for (let i = 0; i < 9; i++) input.push(r("RELA", i, `rela-${i}`));
  const fork = encodeResourceFork(input);
  const decoded = decodeResourceFork(fork);
  assert.equal(decoded.length, 19);
  const types = new Set(decoded.map((d) => d.type));
  assert.deepEqual([...types].sort(), ["CODE", "DATA", "RELA"]);
});

test("decode rejects truncated fork", () => {
  assert.throws(() => decodeResourceFork(new Uint8Array(4)), /too short/);
});
