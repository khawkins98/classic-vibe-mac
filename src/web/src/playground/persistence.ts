/**
 * persistence.ts — IndexedDB-backed storage for the playground.
 *
 * Two object stores in one database:
 *   - `files`     keyed by `<project>/<filename>`, value = { content: string }
 *   - `ui-state`  keyed by string, value = arbitrary JSON
 *
 * One global record under `ui-state` named "bundleVersion" holds the
 * version of the bundled sample sources we last seeded from. On boot we
 * compare it against the build-time constant `BUNDLE_VERSION`; if it
 * differs we wipe the user's `files` store (silent, no migration UI —
 * Phase 1 explicitly defers a 3-way diff per the editor reviewer).
 *
 * Failure modes we care about:
 *   - Firefox PB historically threw on `indexedDB.open()`. Newer FF treats
 *     IDB as ephemeral. Either way we can't trust persistence — fall back
 *     to an in-memory map and surface a banner so the user knows.
 *   - Safari ITP wipes IDB after 7 days of no interaction. Nothing we can
 *     do about that — the user's edits silently vanish. Documented in
 *     LEARNINGS.md (top entry only if surprising; this isn't).
 *
 * The fallback in-memory map keeps the UI working even when IDB throws,
 * so the editor still feels responsive — edits just don't survive reloads.
 * `isPersistent()` lets the chrome render a banner saying so.
 */

import {
  fileKey,
  BUNDLE_VERSION,
  SAMPLE_PROJECTS,
  type SampleProject,
} from "./types";
import {
  runInTransaction,
  readWithRetry,
  seedActionFor,
  migrationActionFor,
  classifyBundledResponse,
  type ReadResult,
  type BundledFetchResult,
} from "./persistenceCore";

const DB_NAME = "cvm-playground";
const DB_VERSION = 1;
const STORE_FILES = "files";
const STORE_UI = "ui-state";
const KEY_BUNDLE_VERSION = "bundleVersion";
const SEED_HASH_PREFIX = "seedHash:";

/**
 * djb2-inspired 32-bit hash of a string — fast change detection.
 * Not cryptographically strong, but collision resistance is fine for
 * "did the user edit this file?" comparisons.
 */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

let dbPromise: Promise<IDBDatabase | null> | null = null;
let persistent = true;

/** In-memory fallback for when IDB is unavailable. Keyed identically. */
const memFiles = new Map<string, string>();
const memUi = new Map<string, unknown>();

/**
 * Open (and on first open, create) the database. Resolves to `null` if
 * IDB is broken — the caller falls back to the in-memory maps. We cache
 * the promise so concurrent callers share one open() call.
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      persistent = false;
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // FF private browsing (older versions) and some sandboxes throw here
      // synchronously instead of firing onerror. Treat the same as failure.
      persistent = false;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES);
      }
      if (!db.objectStoreNames.contains(STORE_UI)) {
        db.createObjectStore(STORE_UI);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      persistent = false;
      resolve(null);
    };
    req.onblocked = () => {
      // Another tab holds an older version. Treat as failure rather than
      // hanging — the user just gets the in-memory fallback this session.
      persistent = false;
      resolve(null);
    };
  });
  return dbPromise;
}

/** Whether the active session is using IDB or the in-memory fallback. */
export function isPersistent(): boolean {
  return persistent;
}

/**
 * Tiny request → promise helper. IDB's request objects fire `onsuccess` /
 * `onerror`; we rewrap as a Promise<T> that REJECTS on error. Callers
 * that want "failure = no value" semantics (UI-state reads) catch it
 * themselves; file reads need to tell "not found" apart from "couldn't
 * read" so they don't seed the bundled default over a stored copy.
 */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Run `fn` in a transaction on `storeName`. Resolves `undefined` when
 * IDB is unavailable (in-memory fallback); otherwise defers to
 * `runInTransaction`, which rejects on any failure — including `fn`
 * throwing synchronously (e.g. DataCloneError from `put`).
 */
async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T> | T,
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return runInTransaction(db, storeName, mode, fn);
}

/**
 * Keys whose stored copy we failed to read this session. We showed the
 * bundled default for them without persisting it; writes to these keys
 * stay in memory so an edit on top of that fallback can't overwrite the
 * user's real (unreadable-right-now) copy in IDB. Cleared by Reset,
 * which is an explicit "overwrite with bundled" request. A reload
 * retries the read from scratch.
 */
const unreadableKeys = new Set<string>();

type ReadErrorListener = (
  project: string,
  filename: string,
  error: unknown,
) => void;
const readErrorListeners = new Set<ReadErrorListener>();

/** Subscribe to "couldn't read a stored file" notifications (the editor
 *  surfaces them in its status line). Returns an unsubscribe function. */
export function onStorageReadError(listener: ReadErrorListener): () => void {
  readErrorListeners.add(listener);
  return () => readErrorListeners.delete(listener);
}

/** True if `project/filename` is one whose stored copy we couldn't read
 *  this session (see `unreadableKeys`): the editor shows, and saves go
 *  to, an in-memory copy only. */
export function isUnreadable(project: string, filename: string): boolean {
  return unreadableKeys.has(fileKey(project, filename));
}

/**
 * Read one file, distinguishing a genuine not-found (`absent`) from a
 * failed read (`error`). The in-memory fallback never errors.
 *
 * For a key in `unreadableKeys` this returns the in-memory copy (the
 * bundled default plus any in-session edits) — exactly what the editor
 * shows — so builds, duplication, etc. see the same content the user
 * sees, rather than a stored copy that may appear readable later.
 */
export async function readFileResult(
  project: string,
  filename: string,
): Promise<ReadResult> {
  const k = fileKey(project, filename);
  const fromMem = (): ReadResult => {
    const v = memFiles.get(k);
    return v === undefined
      ? { status: "absent" }
      : { status: "found", content: v };
  };
  if (!persistent) return fromMem();
  if (unreadableKeys.has(k) && memFiles.has(k)) return fromMem();
  let fromIdb: { content: string } | undefined;
  try {
    fromIdb = await withStore(STORE_FILES, "readonly", (s) =>
      reqToPromise<{ content: string } | undefined>(s.get(k)),
    );
  } catch (error) {
    return { status: "error", error };
  }
  if (!persistent) return fromMem(); // racy fallback flip during open
  return typeof fromIdb?.content === "string"
    ? { status: "found", content: fromIdb.content }
    : { status: "absent" };
}

/** Read one file's stored content, or `undefined` if absent OR the read
 *  failed. Callers that would write a default on `undefined` must use
 *  `readFileResult` (or `readOrSeedFile`) instead. */
export async function readFile(
  project: string,
  filename: string,
): Promise<string | undefined> {
  const r = await readFileResult(project, filename);
  return r.status === "found" ? r.content : undefined;
}

/** Write one file's content. Idempotent. IDB failures are logged, not
 *  thrown (pre-existing contract: callers treat persistence as best-
 *  effort and the in-memory copy keeps the session working).
 *
 *  Resolves `true` when the write landed in this session's backing
 *  store (IDB, or the in-memory map when IDB is unavailable for the
 *  whole session — the "not persistent" banner covers that), `false`
 *  when it was kept in memory only: the key is unreadable (see
 *  `unreadableKeys`) or the IDB put failed. */
export async function writeFile(
  project: string,
  filename: string,
  content: string,
): Promise<boolean> {
  const k = fileKey(project, filename);
  memFiles.set(k, content);
  if (!persistent) return true;
  if (unreadableKeys.has(k)) return false; // see unreadableKeys
  try {
    await withStore(STORE_FILES, "readwrite", (s) => {
      s.put({ content }, k);
      return undefined;
    });
    return true;
  } catch (err) {
    console.warn(`[cvm] persistence: failed to save ${k}`, err);
    return false;
  }
}

/** Read a UI-state value. */
export async function readUiState<T = unknown>(
  key: string,
): Promise<T | undefined> {
  if (!persistent) return memUi.get(key) as T | undefined;
  try {
    return await withStore(STORE_UI, "readonly", (s) =>
      reqToPromise<T | undefined>(s.get(key)),
    );
  } catch {
    // UI state is cosmetic (last project, cursor, …): a failed read
    // just means "use the default".
    return undefined;
  }
}

/** Read a UI-state value, distinguishing a genuine not-found
 *  (`absent`) from a failed read (`error`). Only string values count as
 *  `found`; anything else stored under the key reads as `absent`. */
async function readUiStringResult(key: string): Promise<ReadResult> {
  if (!persistent) {
    const v = memUi.get(key);
    return typeof v === "string"
      ? { status: "found", content: v }
      : { status: "absent" };
  }
  try {
    const v = await withStore(STORE_UI, "readonly", (s) =>
      reqToPromise<unknown>(s.get(key)),
    );
    return typeof v === "string"
      ? { status: "found", content: v }
      : { status: "absent" };
  } catch (error) {
    return { status: "error", error };
  }
}

/** Write a UI-state value. */
export async function writeUiState(key: string, value: unknown): Promise<void> {
  memUi.set(key, value);
  if (!persistent) return;
  try {
    await withStore(STORE_UI, "readwrite", (s) => {
      s.put(value, key);
      return undefined;
    });
  } catch (err) {
    console.warn(`[cvm] persistence: failed to save UI state ${key}`, err);
  }
}

// ── User-added files per project ───────────────────────────────────
//
// Each SAMPLE_PROJECTS entry ships a fixed `files: string[]` list —
// the "seed" files we copy into IDB on first paint. Anything the
// user creates after that (File → New file…) lives in a separate
// per-project list stored under `cvm:user-files:<projectId>`. The
// editor merges seed + user filenames on project switch to render
// the tab bar and gather sources for the build pipeline.
//
// File contents themselves still go through writeFile/readFile under
// `<projectId>/<filename>` — same plumbing as the seeded files. The
// only thing the user-files list tracks is which filenames exist.

const USER_FILES_PREFIX = "cvm:user-files:";

export async function getUserFilenames(projectId: string): Promise<string[]> {
  const list = await readUiState<string[]>(USER_FILES_PREFIX + projectId);
  return Array.isArray(list) ? [...list] : [];
}

export async function addUserFilename(
  projectId: string,
  filename: string,
): Promise<void> {
  const list = await getUserFilenames(projectId);
  if (list.includes(filename)) return;
  list.push(filename);
  await writeUiState(USER_FILES_PREFIX + projectId, list);
}

export async function removeUserFilename(
  projectId: string,
  filename: string,
): Promise<void> {
  const list = await getUserFilenames(projectId);
  const idx = list.indexOf(filename);
  if (idx < 0) return;
  list.splice(idx, 1);
  await writeUiState(USER_FILES_PREFIX + projectId, list);
}

// ── User-created projects ──────────────────────────────────────────
//
// The user can duplicate any SAMPLE_PROJECTS entry as a new project
// (File → "Duplicate as new project…"). The new project lives in IDB
// only — its metadata under `cvm:user-projects`, its file *contents*
// under the normal `<projectId>/<filename>` keys via writeFile.
//
// The runtime cache + lookup helpers live in `types.ts`; this module
// owns persistence only.

const USER_PROJECTS_KEY = "cvm:user-projects";

export async function getUserProjects(): Promise<SampleProject[]> {
  const list = await readUiState<SampleProject[]>(USER_PROJECTS_KEY);
  return Array.isArray(list) ? list : [];
}

export async function saveUserProjects(
  projects: readonly SampleProject[],
): Promise<void> {
  await writeUiState(USER_PROJECTS_KEY, [...projects]);
}

/**
 * Record the hash of a file's bundled content at seeding time.
 * Used later to detect whether the user has edited the file.
 */
async function recordSeedHash(
  project: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeUiState(SEED_HASH_PREFIX + fileKey(project, filename), hashString(content));
}

/**
 * Retrieve a previously recorded seed hash: `absent` if none was stored
 * (e.g., files seeded before this feature was deployed), `error` if the
 * read failed (after one retry) — callers must not treat that as absent.
 */
async function readSeedHash(
  project: string,
  filename: string,
): Promise<ReadResult> {
  return readWithRetry(() =>
    readUiStringResult(SEED_HASH_PREFIX + fileKey(project, filename)),
  );
}

/**
 * Smart bundle migration: instead of wiping all stored files when the
 * bundle version changes, only update files the user hasn't edited.
 * Files where `hash(user content) !== seedHash` are preserved untouched.
 *
 * Returns the count of files that were preserved (user has edits).
 */
async function smartMigrateFiles(baseUrl: string): Promise<number> {
  let preservedCount = 0;
  for (const project of SAMPLE_PROJECTS) {
    for (const filename of project.files) {
      const stored = await readWithRetry(() =>
        readFileResult(project.id, filename),
      );
      // Not seeded yet → nothing to migrate. Couldn't read → leave it
      // alone; readOrSeedFile will handle it when the file is opened.
      if (stored.status !== "found") continue;

      const seedHash = await readSeedHash(project.id, filename);
      if (migrationActionFor(hashString(stored.content), seedHash) === "preserve") {
        // User has edited this file, or we couldn't read its seed hash
        // and so can't tell — preserve it.
        preservedCount++;
        continue;
      }

      // No edits detected (or first migration with no seed hash history):
      // silently refresh to the new bundled version.
      const newBundled = await fetchBundledFileResult(baseUrl, project.id, filename);
      if (newBundled.status === "ok") {
        if (await writeFile(project.id, filename, newBundled.content)) {
          await recordSeedHash(project.id, filename, newBundled.content);
        }
      }
      // If fetch failed (or the file is no longer bundled), keep the
      // existing content — better than an empty editor.
    }
  }
  return preservedCount;
}

/**
 * Initialize storage. Opens the DB, performs the bundle-version check.
 * On version change, runs a smart migration that preserves user edits
 * instead of blindly wiping all stored files.
 *
 * Returns `{ persistent, preservedCount }`:
 *   - `persistent`: true iff IDB is backing storage (false = in-memory fallback)
 *   - `preservedCount`: number of files with user edits that were kept as-is
 */
export async function initPersistence(
  baseUrl: string,
): Promise<{ persistent: boolean; preservedCount: number }> {
  await openDb();
  if (!persistent) return { persistent: false, preservedCount: 0 };
  const stored = await readUiState<string>(KEY_BUNDLE_VERSION);
  let preservedCount = 0;
  if (stored !== BUNDLE_VERSION) {
    preservedCount = await smartMigrateFiles(baseUrl);
    await writeUiState(KEY_BUNDLE_VERSION, BUNDLE_VERSION);
  }
  return { persistent, preservedCount };
}

/**
 * Fetch the bundled (canonical) source for one file from the public
 * sample-projects directory. We always go through `fetch` so the same
 * code path works in dev and prod, and so the browser caches it.
 *
 * Distinguishes success (content may be empty — a legitimately empty
 * file), `missing` (404/410) and `error` (network / other status).
 */
export async function fetchBundledFileResult(
  baseUrl: string,
  project: string,
  filename: string,
): Promise<BundledFetchResult> {
  // Use a relative, base-aware URL. Vite injects `import.meta.env.BASE_URL`
  // (which respects the configured `base`), so this works under
  // /classic-vibe-mac/ on GitHub Pages too.
  const url = `${baseUrl}sample-projects/${project}/${filename}`;
  try {
    const res = await fetch(url);
    const kind = classifyBundledResponse(res);
    if (kind === "missing") return { status: "missing" };
    if (kind === "error") {
      return { status: "error", error: new Error(`HTTP ${res.status}`) };
    }
    return { status: "ok", content: await res.text() };
  } catch (error) {
    return { status: "error", error };
  }
}

/**
 * Like `fetchBundledFileResult` but returns the empty string on any
 * failure — the editor will show an empty buffer and the next save will
 * populate IDB. For callers that just need something to display.
 */
export async function fetchBundledFile(
  baseUrl: string,
  project: string,
  filename: string,
): Promise<string> {
  const r = await fetchBundledFileResult(baseUrl, project, filename);
  return r.status === "ok" ? r.content : "";
}

/**
 * Read a file, falling back to the bundled copy if IDB has nothing yet.
 * On first load this is what populates the editor for every file the
 * user opens for the first time.
 *
 * Only a genuine not-found seeds IDB. A failed read is retried once;
 * if it still fails we return the bundled content for display WITHOUT
 * writing it (and mark the key so later autosaves stay in memory), then
 * notify `onStorageReadError` listeners. That keeps whatever the user
 * has stored intact — a transient IDB hiccup must never turn into
 * "your edits were replaced by the sample". Reloading retries.
 */
export async function readOrSeedFile(
  baseUrl: string,
  project: string,
  filename: string,
): Promise<string> {
  const k = fileKey(project, filename);
  // Already fell back this session: keep serving the in-memory copy
  // (bundled default plus any in-session edits) rather than flipping
  // between it and a now-readable stored copy mid-session.
  if (unreadableKeys.has(k) && memFiles.has(k)) return memFiles.get(k)!;
  const result = await readWithRetry(() => readFileResult(project, filename));
  if (result.status === "found") return result.content;
  const bundled = await fetchBundledFile(baseUrl, project, filename);
  if (seedActionFor(result) === "bundled-unsaved") {
    const error = result.status === "error" ? result.error : undefined;
    console.warn(
      `[cvm] persistence: couldn't read ${k}; showing bundled copy, not saving`,
      error,
    );
    unreadableKeys.add(k);
    memFiles.set(k, bundled);
    for (const l of readErrorListeners) {
      try {
        l(project, filename, error);
      } catch {
        // A broken listener mustn't break loading the file.
      }
    }
    return bundled;
  }
  // Genuine not-found: seed IDB so subsequent reads are local. Record
  // the seed hash so we can later detect whether the user has edited it.
  if (bundled && (await writeFile(project, filename, bundled))) {
    await recordSeedHash(project, filename, bundled);
  }
  return bundled;
}

/**
 * Reset: overwrite `projectId`'s starter files (`files`) with the
 * bundled defaults of shipped sample `sourceId` — the project itself for
 * a shipped sample, or the sample it was duplicated from for a user
 * project. Every file is fetched BEFORE anything is written, so a
 * network failure (or any non-404 error) throws and leaves the user's
 * copies untouched instead of half-resetting. User-added files (#319)
 * aren't in `files` and are kept.
 *
 * A file the bundle no longer has (404 — e.g. a duplicated project's
 * file list, copied at duplication time, names a starter file that has
 * since been renamed or removed) is skipped: the user's copy stays and
 * the filename is reported in `missing`. An empty bundled file is valid.
 *
 * Returns the restored contents keyed by filename, the skipped
 * (missing) filenames, and any filenames whose write didn't persist.
 */
export async function resetProjectToBundled(
  baseUrl: string,
  projectId: string,
  sourceId: string,
  files: readonly string[],
): Promise<{
  restored: Map<string, string>;
  missing: string[];
  unsaved: string[];
}> {
  const restored = new Map<string, string>();
  const missing: string[] = [];
  const unsaved: string[] = [];
  for (const filename of files) {
    const r = await fetchBundledFileResult(baseUrl, sourceId, filename);
    if (r.status === "error") {
      throw new Error(`couldn't fetch the bundled copy of ${filename}`);
    }
    if (r.status === "missing") {
      missing.push(filename);
      continue;
    }
    restored.set(filename, r.content);
  }
  for (const [filename, content] of restored) {
    // Explicit overwrite: lift the unreadable-key guard for this file.
    unreadableKeys.delete(fileKey(projectId, filename));
    if (await writeFile(projectId, filename, content)) {
      await recordSeedHash(projectId, filename, content);
    } else {
      unsaved.push(filename);
    }
  }
  return { restored, missing, unsaved };
}
