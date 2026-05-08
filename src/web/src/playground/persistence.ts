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

import { fileKey, BUNDLE_VERSION, SAMPLE_PROJECTS } from "./types";

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
 * `onerror`; we rewrap as a Promise<T>. We resolve with `undefined` on
 * error rather than rejecting because every caller treats "no value" the
 * same as "value not present" — there's nothing useful to do with a
 * failed read except fall through to defaults.
 */
function reqToPromise<T>(req: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(undefined);
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T>,
): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise<T | undefined>((resolve) => {
    let result: T | undefined;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, mode);
    } catch {
      resolve(undefined);
      return;
    }
    const store = tx.objectStore(storeName);
    fn(store).then((r) => {
      result = r;
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
}

/** Read one file's stored content, or `undefined` if absent. */
export async function readFile(
  project: string,
  filename: string,
): Promise<string | undefined> {
  const k = fileKey(project, filename);
  if (!persistent) return memFiles.get(k);
  const fromIdb = await withStore(STORE_FILES, "readonly", (s) =>
    reqToPromise<{ content: string } | undefined>(s.get(k)),
  );
  if (!persistent) return memFiles.get(k); // racy fallback flip during open
  return fromIdb?.content;
}

/** Write one file's content. Idempotent. */
export async function writeFile(
  project: string,
  filename: string,
  content: string,
): Promise<void> {
  const k = fileKey(project, filename);
  memFiles.set(k, content);
  if (!persistent) return;
  await withStore(STORE_FILES, "readwrite", async (s) => {
    s.put({ content }, k);
    return undefined;
  });
}

/** Wipe ALL stored files. Called on bundleVersion change. */
async function clearAllFiles(): Promise<void> {
  memFiles.clear();
  if (!persistent) return;
  await withStore(STORE_FILES, "readwrite", async (s) => {
    s.clear();
    return undefined;
  });
}

/** Read a UI-state value. */
export async function readUiState<T = unknown>(
  key: string,
): Promise<T | undefined> {
  if (!persistent) return memUi.get(key) as T | undefined;
  const v = await withStore(STORE_UI, "readonly", (s) =>
    reqToPromise<T>(s.get(key)),
  );
  return v;
}

/** Write a UI-state value. */
export async function writeUiState(key: string, value: unknown): Promise<void> {
  memUi.set(key, value);
  if (!persistent) return;
  await withStore(STORE_UI, "readwrite", async (s) => {
    s.put(value, key);
    return undefined;
  });
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
 * Retrieve a previously recorded seed hash. Returns `undefined` if none
 * was stored (e.g., files seeded before this feature was deployed).
 */
async function readSeedHash(
  project: string,
  filename: string,
): Promise<string | undefined> {
  return readUiState<string>(SEED_HASH_PREFIX + fileKey(project, filename));
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
      const stored = await readFile(project.id, filename);
      if (stored === undefined) continue; // not seeded yet — skip

      const seedHash = await readSeedHash(project.id, filename);
      if (seedHash !== undefined && hashString(stored) !== seedHash) {
        // User has edited this file — preserve it.
        preservedCount++;
        continue;
      }

      // No edits detected (or first migration with no seed hash history):
      // silently refresh to the new bundled version.
      const newBundled = await fetchBundledFile(baseUrl, project.id, filename);
      if (newBundled) {
        await writeFile(project.id, filename, newBundled);
        await recordSeedHash(project.id, filename, newBundled);
      }
      // If fetch failed, keep the existing content — better than an empty editor.
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
 * Returns the empty string on failure — the editor will show an empty
 * buffer and the next save will populate IDB. Easier than throwing.
 */
export async function fetchBundledFile(
  baseUrl: string,
  project: string,
  filename: string,
): Promise<string> {
  // Use a relative, base-aware URL. Vite injects `import.meta.env.BASE_URL`
  // (which respects the configured `base`), so this works under
  // /classic-vibe-mac/ on GitHub Pages too.
  const url = `${baseUrl}sample-projects/${project}/${filename}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Read a file, falling back to the bundled copy if IDB has nothing yet.
 * On first load this is what populates the editor for every file the
 * user opens for the first time.
 */
export async function readOrSeedFile(
  baseUrl: string,
  project: string,
  filename: string,
): Promise<string> {
  const stored = await readFile(project, filename);
  if (stored !== undefined) return stored;
  const bundled = await fetchBundledFile(baseUrl, project, filename);
  // Seed IDB so subsequent reads are local. Record the seed hash so we
  // can later detect whether the user has edited this file.
  if (bundled) {
    await writeFile(project, filename, bundled);
    await recordSeedHash(project, filename, bundled);
  }
  return bundled;
}
