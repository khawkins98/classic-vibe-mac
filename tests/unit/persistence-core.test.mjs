/**
 * persistence-core.test.mjs — unit tests for
 * src/web/src/playground/persistenceCore.ts (the pure helpers behind
 * persistence.ts).
 *
 * Covers:
 *   - runInTransaction settles (rejects, never hangs) when the callback
 *     throws synchronously, the request fails, or the tx errors/aborts;
 *   - the not-found vs read-error decision (retry once, never seed over
 *     an error);
 *   - resolveResetSource for samples, recorded duplicates and legacy
 *     duplicates.
 *
 * Run as: node --test tests/unit/persistence-core.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transpileWeb } from "./_transpile.mjs";

const url = transpileWeb(["playground/persistenceCore.ts"]);
const { runInTransaction, readWithRetry, seedActionFor, resolveResetSource } =
  await import(url("playground/persistenceCore.ts"));

// ── Fake IDB transaction ─────────────────────────────────────────────
// Just enough surface for runInTransaction: objectStore(), abort(), and
// the oncomplete / onerror / onabort hooks, fired on a microtask.
function fakeDb({ throwOnTransaction = false } = {}) {
  const txs = [];
  return {
    txs,
    transaction() {
      if (throwOnTransaction) throw new Error("InvalidStateError");
      const tx = {
        error: null,
        aborted: false,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore: () => ({ fake: true }),
        abort() {
          this.aborted = true;
          queueMicrotask(() => this.onabort?.());
        },
        complete() {
          queueMicrotask(() => this.oncomplete?.());
        },
        fail(err) {
          this.error = err;
          queueMicrotask(() => this.onerror?.());
        },
      };
      txs.push(tx);
      return tx;
    },
  };
}

test("runInTransaction resolves with fn's result on complete", async () => {
  const db = fakeDb();
  const p = runInTransaction(db, "files", "readonly", async () => "hello");
  await Promise.resolve();
  db.txs[0].complete();
  assert.equal(await p, "hello");
});

test("runInTransaction rejects (not throws/hangs) when fn throws synchronously", async () => {
  const db = fakeDb();
  let p;
  assert.doesNotThrow(() => {
    p = runInTransaction(db, "files", "readwrite", () => {
      const e = new Error("could not be cloned");
      e.name = "DataCloneError";
      throw e;
    });
  });
  await assert.rejects(p, { name: "DataCloneError" });
  assert.equal(db.txs[0].aborted, true, "transaction aborted");
});

test("runInTransaction rejects when fn's promise rejects", async () => {
  const db = fakeDb();
  const p = runInTransaction(db, "files", "readonly", () =>
    Promise.reject(new Error("request failed")),
  );
  await assert.rejects(p, /request failed/);
});

test("runInTransaction rejects on tx error", async () => {
  const db = fakeDb();
  const p = runInTransaction(db, "files", "readonly", async () => "x");
  db.txs[0].fail(new Error("QuotaExceededError"));
  await assert.rejects(p, /QuotaExceededError/);
});

test("runInTransaction rejects when db.transaction throws", async () => {
  const db = fakeDb({ throwOnTransaction: true });
  await assert.rejects(
    runInTransaction(db, "files", "readonly", async () => "x"),
    /InvalidStateError/,
  );
});

// ── not-found vs error ───────────────────────────────────────────────

test("seedActionFor: only a genuine not-found seeds", () => {
  assert.equal(seedActionFor({ status: "found", content: "x" }), "use-stored");
  assert.equal(seedActionFor({ status: "found", content: "" }), "use-stored");
  assert.equal(seedActionFor({ status: "absent" }), "seed");
  assert.equal(
    seedActionFor({ status: "error", error: new Error("boom") }),
    "bundled-unsaved",
  );
});

test("readWithRetry retries an error once and returns the recovered read", async () => {
  let calls = 0;
  const r = await readWithRetry(async () => {
    calls++;
    return calls === 1
      ? { status: "error", error: new Error("transient") }
      : { status: "found", content: "user edits" };
  });
  assert.equal(calls, 2);
  assert.deepEqual(r, { status: "found", content: "user edits" });
});

test("readWithRetry gives up after one retry and reports error (never absent)", async () => {
  let calls = 0;
  const r = await readWithRetry(async () => {
    calls++;
    throw new Error("still broken");
  });
  assert.equal(calls, 2);
  assert.equal(r.status, "error");
  assert.equal(seedActionFor(r), "bundled-unsaved");
});

test("readWithRetry does not retry absent / found", async () => {
  let calls = 0;
  const r = await readWithRetry(async () => {
    calls++;
    return { status: "absent" };
  });
  assert.equal(calls, 1);
  assert.equal(r.status, "absent");
});

// ── resolveResetSource ───────────────────────────────────────────────

const SAMPLES = [
  { id: "snake", files: ["snake.c", "snake.r"], rezFile: "snake.r", outputName: "Snake.bin" },
  { id: "hello", files: ["hello.c"], rezFile: null, outputName: "Hello.bin" },
  { id: "hello2", files: ["hello.c"], rezFile: null, outputName: "Hello.bin" },
];

test("resolveResetSource: a shipped sample resets from itself", () => {
  assert.equal(resolveResetSource(SAMPLES[0], SAMPLES), "snake");
});

test("resolveResetSource: recorded sourceProjectId wins", () => {
  const dup = { ...SAMPLES[0], id: "user-mine-abc", sourceProjectId: "snake" };
  assert.equal(resolveResetSource(dup, SAMPLES), "snake");
});

test("resolveResetSource: recorded source that no longer ships → undefined", () => {
  const dup = { ...SAMPLES[0], id: "user-mine-abc", sourceProjectId: "retired" };
  assert.equal(resolveResetSource(dup, SAMPLES), undefined);
});

test("resolveResetSource: legacy duplicate with a unique metadata match", () => {
  const legacy = { ...SAMPLES[0], id: "user-old-xyz" };
  assert.equal(resolveResetSource(legacy, SAMPLES), "snake");
});

test("resolveResetSource: legacy duplicate that's ambiguous or unmatched → undefined", () => {
  const ambiguous = { ...SAMPLES[1], id: "user-old-1" };
  assert.equal(resolveResetSource(ambiguous, SAMPLES), undefined);
  const unmatched = { ...SAMPLES[0], id: "user-old-2", files: ["snake.c"] };
  assert.equal(resolveResetSource(unmatched, SAMPLES), undefined);
});
