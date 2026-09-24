/**
 * persistenceCore.ts — pure, DOM-free helpers behind persistence.ts.
 *
 * Split out so tests/unit can import them under plain Node (the emitted
 * ESM from persistence.ts pulls in ./types without an extension, which
 * Node's loader can't resolve). Nothing here touches `indexedDB`,
 * `fetch` or module-level state — the IDB transaction helper takes the
 * database handle as a parameter so a tiny fake can drive it.
 */

import type { SampleProject } from "./types";

// ── Transactions ───────────────────────────────────────────────────

/** Minimal slice of IDBDatabase that `runInTransaction` needs. */
export interface TxDatabase {
  transaction(storeName: string, mode: IDBTransactionMode): IDBTransaction;
}

/**
 * Run `fn` against one object store inside a fresh transaction and
 * settle when the transaction does.
 *
 * Rejects (never hangs, never throws synchronously) when:
 *   - `db.transaction()` throws (closed DB, missing store, …);
 *   - `fn` throws synchronously — e.g. `store.put()` raising
 *     DataCloneError for a non-cloneable value. We abort the
 *     transaction so nothing half-applied commits;
 *   - the promise `fn` returns rejects (a failed request);
 *   - the transaction fires `error` or `abort`.
 *
 * Resolves with `fn`'s result on `complete`.
 */
export function runInTransaction<T>(
  db: TxDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err ?? "IndexedDB transaction failed")));
    };
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch (err) {
      fail(err);
      return;
    }
    const abortQuietly = (): void => {
      try {
        tx.abort();
      } catch {
        // Already finished/aborted — nothing to undo.
      }
    };
    let result: T | undefined;
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result as T);
    };
    tx.onerror = () => fail(tx.error ?? new Error("IndexedDB transaction error"));
    tx.onabort = () => fail(tx.error ?? new Error("IndexedDB transaction aborted"));
    let pending: Promise<T> | T;
    try {
      pending = fn(tx.objectStore(storeName));
    } catch (err) {
      fail(err);
      abortQuietly();
      return;
    }
    Promise.resolve(pending).then(
      (r) => {
        result = r;
      },
      (err) => {
        fail(err);
        abortQuietly();
      },
    );
  });
}

// ── Reads: not-found vs error ──────────────────────────────────────

/**
 * Outcome of a single stored-file read. `absent` means IDB answered and
 * the key genuinely isn't there; `error` means we couldn't find out.
 * The two MUST be handled differently: seeding over an `error` would
 * clobber the user's stored copy with the bundled default.
 */
export type ReadResult =
  | { status: "found"; content: string }
  | { status: "absent" }
  | { status: "error"; error: unknown };

/**
 * Run `read`, retrying up to `retries` more times while it reports
 * `error`. `found` / `absent` return immediately. A read function that
 * throws is treated as an `error` result.
 */
export async function readWithRetry(
  read: () => Promise<ReadResult>,
  retries = 1,
): Promise<ReadResult> {
  let last: ReadResult = { status: "error", error: new Error("not attempted") };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      last = await read();
    } catch (error) {
      last = { status: "error", error };
    }
    if (last.status !== "error") return last;
  }
  return last;
}

/**
 * What `readOrSeedFile` should do with a (post-retry) read result:
 *   - `use-stored`: return the stored copy as-is.
 *   - `seed`: fetch the bundled default AND persist it (first open).
 *   - `bundled-unsaved`: fetch the bundled default for display only —
 *     never write it, because the user's stored copy may still exist.
 */
export type SeedAction = "use-stored" | "seed" | "bundled-unsaved";

export function seedActionFor(result: ReadResult): SeedAction {
  switch (result.status) {
    case "found":
      return "use-stored";
    case "absent":
      return "seed";
    case "error":
      return "bundled-unsaved";
  }
}

// ── Reset source for user projects ─────────────────────────────────

/**
 * Which shipped sample's bundled files should Reset restore `project`
 * from? Returns `undefined` when there's no way to know.
 *
 *   1. A shipped sample resets from itself.
 *   2. A user project duplicated after #320's follow-up records
 *      `sourceProjectId` (the root shipped sample, even when duplicated
 *      from another user project).
 *   3. Legacy duplicates (created before `sourceProjectId` existed)
 *      carry the source's metadata verbatim via `{...src}`; if exactly
 *      one sample matches on outputName + rezFile + files list, use it.
 *      Ambiguous or no match → undefined (Reset gets disabled).
 */
export function resolveResetSource(
  project: Pick<SampleProject, "id" | "files" | "rezFile" | "outputName" | "sourceProjectId">,
  samples: readonly Pick<SampleProject, "id" | "files" | "rezFile" | "outputName">[],
): string | undefined {
  if (samples.some((s) => s.id === project.id)) return project.id;
  if (project.sourceProjectId !== undefined) {
    return samples.some((s) => s.id === project.sourceProjectId)
      ? project.sourceProjectId
      : undefined;
  }
  const sameFiles = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((f, i) => f === b[i]);
  const matches = samples.filter(
    (s) =>
      s.outputName === project.outputName &&
      s.rezFile === project.rezFile &&
      sameFiles(s.files, project.files),
  );
  return matches.length === 1 ? matches[0]!.id : undefined;
}
