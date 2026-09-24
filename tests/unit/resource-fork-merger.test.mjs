/**
 * Tests for resourceForkMerger.mjs (#280 Path B Phase 2A).
 *
 * Validates: decode → re-encode round-trip preserves resources; merge
 * with conflict resolution (onConflict "first" default / "last");
 * canonical encoder layout; empty-fork edge cases.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeResourceForks,
  decodeResourceFork,
  decodeResourceForkMap,
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

test("decode: honours a non-canonical type list offset", () => {
  // Take a canonical fork (type list at map+28) and splice two padding
  // bytes in front of the type list, bumping typeListOff / nameListOff /
  // mapLen accordingly. Ref-list offsets are relative to the type list so
  // they stay valid. The decoder used to read numTypes-1 from map+28
  // regardless of typeListOff.
  const input = [r("PICT", 128, "a", "nm"), r("snd ", 1, "bb")];
  const canon = encodeResourceFork(input);
  const dv0 = new DataView(canon.buffer, canon.byteOffset, canon.byteLength);
  const mapOff = dv0.getUint32(4, false);
  assert.equal(dv0.getUint16(mapOff + 24, false), 28);
  const shifted = new Uint8Array(canon.length + 2);
  shifted.set(canon.subarray(0, mapOff + 28), 0);
  shifted[mapOff + 28] = 0xff; // garbage where the old code looked
  shifted[mapOff + 29] = 0xff;
  shifted.set(canon.subarray(mapOff + 28), mapOff + 30);
  const dv = new DataView(shifted.buffer);
  dv.setUint32(12, dv.getUint32(12, false) + 2, false);
  dv.setUint16(mapOff + 24, 30, false);
  dv.setUint16(mapOff + 26, dv.getUint16(mapOff + 26, false) + 2, false);
  const decoded = decodeResourceFork(shifted);
  assert.equal(decoded.length, 2);
  const pict = decoded.find((x) => x.type === "PICT");
  assert.equal(pict.id, 128);
  assert.equal(pict.name, "nm");
});

// ── Explicit precedence (onConflict) ─────────────────────────────────
// build.ts's spliceResourceFork calls mergeResourceForks([base, user],
// { onConflict: "last" }); editor.ts relies on the default "first".
// These pin both so nobody can flip precedence by accident.

const text = (u8) => new TextDecoder().decode(u8);
const pick = (decoded, type, id) =>
  decoded.find((x) => x.type === type && x.id === id);

test("merge: onConflict defaults to 'first'", () => {
  const a = encodeResourceFork([r("STR ", 1, "A")]);
  const b = encodeResourceFork([r("STR ", 1, "B")]);
  const dflt = mergeResourceForks([a, b]);
  const explicit = mergeResourceForks([a, b], { onConflict: "first" });
  assert.deepEqual([...dflt], [...explicit]);
  assert.equal(text(decodeResourceFork(dflt)[0].data), "A");
});

test("merge: onConflict 'last' lets the later fork win, across N forks", () => {
  const f1 = encodeResourceFork([r("STR ", 1, "A1"), r("STR ", 2, "A2")]);
  const f2 = encodeResourceFork([r("STR ", 1, "B1"), r("STR ", 3, "B3")]);
  const f3 = encodeResourceFork([r("STR ", 2, "C2"), r("STR ", 3, "C3"), r("STR ", 4, "C4")]);
  const decoded = decodeResourceFork(
    mergeResourceForks([f1, f2, f3], { onConflict: "last" }),
  );
  const byId = new Map(decoded.map((d) => [d.id, text(d.data)]));
  assert.equal(byId.get(1), "B1");
  assert.equal(byId.get(2), "C2");
  assert.equal(byId.get(3), "C3");
  assert.equal(byId.get(4), "C4");
  assert.equal(decoded.length, 4);
});

test("merge: winner carries its own name and attrs", () => {
  const base = encodeResourceFork([r("MENU", 128, "base", "BaseName", 0x20)]);
  const user = encodeResourceFork([r("MENU", 128, "user", "UserName", 0x04)]);
  const last = pick(
    decodeResourceFork(mergeResourceForks([base, user], { onConflict: "last" })),
    "MENU", 128,
  );
  assert.equal(text(last.data), "user");
  assert.equal(last.name, "UserName");
  assert.equal(last.attrs, 0x04);
  const first = pick(decodeResourceFork(mergeResourceForks([base, user])), "MENU", 128);
  assert.equal(first.name, "BaseName");
  assert.equal(first.attrs, 0x20);
});

test("merge: precedence applies to duplicates inside a single fork too", () => {
  // encodeResourceFork doesn't dedupe, so this builds a fork with two
  // STR 5 entries, the shape a hand-assembled or buggy fork can have.
  const dup = encodeResourceFork([r("STR ", 5, "one"), r("STR ", 5, "two")]);
  assert.equal(decodeResourceFork(dup).length, 2);
  const first = decodeResourceFork(mergeResourceForks([dup]));
  assert.equal(first.length, 1);
  assert.equal(text(first[0].data), "one");
  const last = decodeResourceFork(mergeResourceForks([dup], { onConflict: "last" }));
  assert.equal(last.length, 1);
  assert.equal(text(last[0].data), "two");
});

test("merge: rejects an unknown onConflict value", () => {
  assert.throws(
    () => mergeResourceForks([], { onConflict: "user" }),
    /onConflict must be "first" or "last"/,
  );
});

test("merge: type order follows array order, not precedence", () => {
  const base = encodeResourceFork([r("CODE", 0, "c0"), r("SIZE", -1, "s")]);
  const user = encodeResourceFork([r("MENU", 128, "m"), r("SIZE", -1, "user-s")]);
  const decoded = decodeResourceFork(
    mergeResourceForks([base, user], { onConflict: "last" }),
  );
  assert.deepEqual(
    [...new Set(decoded.map((d) => d.type))],
    ["CODE", "SIZE", "MENU"],
  );
  assert.equal(text(pick(decoded, "SIZE", -1).data), "user-s");
});

test("merge: map attributes come from forks[0]", () => {
  const withAttrs = encodeResourceFork([r("STR ", 1, "a")], { mapAttrs: 0x0080 });
  const plain = encodeResourceFork([r("STR ", 2, "b")]);
  assert.equal(decodeResourceForkMap(withAttrs).mapAttrs, 0x0080);
  assert.equal(
    decodeResourceForkMap(
      mergeResourceForks([withAttrs, plain], { onConflict: "last" }),
    ).mapAttrs,
    0x0080,
  );
  assert.equal(decodeResourceForkMap(mergeResourceForks([plain, withAttrs])).mapAttrs, 0);
});

test("merge: a zero-length fork counts as empty", () => {
  const base = encodeResourceFork([r("CODE", 1, "c1")]);
  const decoded = decodeResourceFork(
    mergeResourceForks([base, new Uint8Array(0)], { onConflict: "last" }),
  );
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].type, "CODE");
});

// ── Canonical encoder layout ─────────────────────────────────────────
// build.ts used to carry its own encoder; the shared one reproduces its
// bytes exactly. Pin the parts of that layout that aren't obvious.

test("encode: IDs sorted within a type; data section follows that order", () => {
  const fork = encodeResourceFork([
    r("STR ", 3, "three"),
    r("CODE", 1, "one"),
    r("STR ", -2, "minus-two"),
    r("STR ", 1, "one-str"),
  ]);
  const decoded = decodeResourceFork(fork);
  assert.deepEqual(
    decoded.map((d) => `${d.type}${d.id}`),
    ["STR -2", "STR 1", "STR 3", "CODE1"],
  );
  const dv = new DataView(fork.buffer);
  assert.equal(dv.getUint32(0), 256);
  assert.equal(dv.getUint32(256), "minus-two".length);
  assert.equal(text(fork.subarray(260, 260 + 9)), "minus-two");
});

test("encode: map header copies the fork header; typeListOff is 28", () => {
  const fork = encodeResourceFork([r("STR ", 1, "x", "n")], { mapAttrs: 0x1234 });
  const dv = new DataView(fork.buffer);
  const mapOff = dv.getUint32(4);
  assert.deepEqual([...fork.subarray(mapOff, mapOff + 16)], [...fork.subarray(0, 16)]);
  assert.deepEqual([...fork.subarray(mapOff + 16, mapOff + 22)], [0, 0, 0, 0, 0, 0]);
  assert.equal(dv.getUint16(mapOff + 22), 0x1234);
  assert.equal(dv.getUint16(mapOff + 24), 28);
  assert.equal(dv.getUint16(mapOff + 26), 28 + 2 + 8 + 12);
});

test("encode: empty resource list is a valid fork with a 30-byte map", () => {
  const fork = encodeResourceFork([]);
  const dv = new DataView(fork.buffer);
  assert.equal(fork.length, 256 + 30);
  assert.equal(dv.getUint32(12), 30);
  assert.equal(dv.getUint16(256 + 26), 30);
  assert.equal(dv.getUint16(256 + 28), 0xffff);
  assert.deepEqual([...mergeResourceForks([])], [...fork]);
});

test("encode: empty-string name is kept distinct from unnamed", () => {
  const decoded = decodeResourceFork(
    encodeResourceFork([r("STR ", 1, "a", ""), r("STR ", 2, "b", null)]),
  );
  assert.equal(pick(decoded, "STR ", 1).name, "");
  assert.equal(pick(decoded, "STR ", 2).name, null);
});

test("decode → encode is byte-identical for a canonical fork", () => {
  const fork = encodeResourceFork(
    [
      r("CODE", 1, "c1", null, 0x20),
      r("CODE", 0, "c0", "jt", 0x20),
      r("STR#", 128, "strs", "Strings"),
    ],
    { mapAttrs: 0x0080 },
  );
  const { mapAttrs, resources } = decodeResourceForkMap(fork);
  assert.deepEqual([...encodeResourceFork(resources, { mapAttrs })], [...fork]);
});
