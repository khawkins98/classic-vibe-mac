/**
 * settings.ts — tiny user-preference store for classic-vibe-mac.
 *
 * Persists to localStorage under namespaced keys (`cvm.*`). Each setting
 * exposes a `getter`, a `setter`, and a `subscribe` so the UI checkbox and
 * the emulator-loader can both observe changes without coupling to each
 * other. We don't need a framework for this — there's exactly one user,
 * one tab, and (for now) one setting.
 *
 * Why localStorage and not a fancier store: localStorage is synchronous,
 * survives reloads (including the coi-serviceworker first-load reload),
 * and a one-line read on page boot is plenty fast. We DO listen for the
 * cross-tab `storage` event so toggling the setting in one tab is felt
 * by another tab on the same origin — useful while testing.
 *
 * The "pauseWhenHidden" setting controls whether the BasiliskII worker
 * pauses (Atomics.wait on a SAB pause flag — see emulator-worker.ts) when
 * the page is hidden. Default: ON. The actual visibilitychange listener
 * lives in emulator-loader.ts.
 */

/** localStorage key for the "sleep when hidden" toggle. */
const KEY_PAUSE_WHEN_HIDDEN = "cvm.pauseWhenHidden";
/** localStorage key for the "Show editor" (playground) toggle. */
const KEY_SHOW_EDITOR = "cvm.showEditor";

type Listener = () => void;
const listeners = new Set<Listener>();
const editorListeners = new Set<Listener>();

/**
 * Read the current value. Defaults to `true` (sleep when hidden) — the
 * polite default that saves CPU/battery. We treat *any* non-"false"
 * stored value as truthy so a corrupted entry from a future schema
 * doesn't quietly disable the feature.
 */
export function isPauseWhenHiddenEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY_PAUSE_WHEN_HIDDEN);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    // localStorage can throw in private browsing or with a hostile sandbox.
    // Default ON in that case — same behavior as a fresh visit.
    return true;
  }
}

/**
 * Persist the new value and notify subscribers. The cross-tab `storage`
 * event takes care of OTHER tabs; we explicitly fire listeners in this
 * tab because the storage event does not fire in the writing tab.
 */
export function setPauseWhenHidden(value: boolean): void {
  try {
    localStorage.setItem(KEY_PAUSE_WHEN_HIDDEN, value ? "true" : "false");
  } catch {
    // Same reason as above — silent fallback. The setting will revert on
    // next page load but the in-memory listeners still get notified, so
    // the current session behaves correctly.
  }
  for (const fn of listeners) fn();
}

/**
 * Subscribe to changes. Returns an unsubscribe function. Fires on:
 *   - same-tab `setPauseWhenHidden()` calls
 *   - cross-tab `storage` events for the same key
 */
export function onPauseWhenHiddenChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * "Show editor" (playground visibility) — persisted, default ON.
 *
 * The same listener pattern as the pause toggle. The editor lives in its
 * own `<section>` under the Macintosh window; flipping this toggle just
 * shows/hides that section without unmounting CodeMirror, so re-enabling
 * is instant and edit state isn't lost.
 */
export function isShowEditorEnabled(): boolean {
  try {
    const raw = localStorage.getItem(KEY_SHOW_EDITOR);
    if (raw === null) return true;
    return raw !== "false";
  } catch {
    return true;
  }
}

export function setShowEditor(value: boolean): void {
  try {
    localStorage.setItem(KEY_SHOW_EDITOR, value ? "true" : "false");
  } catch {
    // Same fallback story as pauseWhenHidden — we still notify in-tab
    // listeners so the UI flips even when persistence fails.
  }
  for (const fn of editorListeners) fn();
}

export function onShowEditorChange(fn: Listener): () => void {
  editorListeners.add(fn);
  return () => {
    editorListeners.delete(fn);
  };
}

// Wire cross-tab observability once. `addEventListener` is no-op safe to
// call multiple times only if we use a stable handler — we do.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (ev) => {
    if (ev.key === KEY_PAUSE_WHEN_HIDDEN) {
      for (const fn of listeners) fn();
    } else if (ev.key === KEY_SHOW_EDITOR) {
      for (const fn of editorListeners) fn();
    }
  });
}
