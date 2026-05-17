/**
 * pollingWatcher.ts — shared scaffolding for "host main thread polls
 * the BasiliskII worker on an interval, decodes the reply, applies it
 * to some UI" watchers.
 *
 * Both drawing-watcher (PixelPad's live preview) and console-watcher
 * (the Debug Console pane) follow the same shape:
 *
 *   1. setInterval that posts a `poll_X` message to the emulator worker
 *   2. addEventListener("message") that filters for the matching
 *      `X_data` reply and hands the decoded payload to caller-supplied
 *      logic
 *   3. (optionally) fire one poll immediately so we don't wait the
 *      full interval to surface state that was already on disk
 *   4. stop() teardown
 *
 * Without this helper each watcher reimplemented those four steps from
 * scratch with subtle drift (interval semantics, fire-immediately
 * default, listener leak on stop). Extract once; the two existing
 * callers + any future file-based back-channels (cf. LEARNINGS
 * 2026-05-16 "file-based debug channels" entry) all route here.
 *
 * What this helper does NOT own: the DOM, the message decoding, any
 * per-watcher state (running offsets, lazy-built preview sections).
 * Those stay in the watcher modules — only the timer + listener wiring
 * is shared.
 */

export interface PollingWatcherConfig<TReply = unknown> {
  /** The BasiliskII worker the watcher polls. */
  worker: Worker;
  /**
   * Called every tick to construct the message to post. Allowed to
   * vary across ticks (e.g. console-watcher includes a running
   * `fromOffset` so the worker can ship only new bytes).
   */
  buildPollMessage: () => unknown;
  /**
   * The `type` field on the worker reply this watcher cares about
   * (e.g. `"drawing_data"`, `"console_data"`). Other messages on the
   * shared worker channel pass through untouched.
   */
  replyType: string;
  /**
   * Called with the decoded reply (the whole `event.data` object).
   * Caller is responsible for validating shape and updating UI; this
   * helper only handles message-filtering and timing.
   */
  onReply: (data: TReply) => void;
  /** Poll interval in ms. Default: 2000. */
  intervalMs?: number;
  /**
   * If true (the default), fire one poll synchronously when the watcher
   * starts so we pick up state that was on disk before the watcher
   * spun up. Pass `false` for watchers whose poll payload depends on
   * state that's only initialised on first reply (e.g. console-watcher
   * carries a `lastOffset` that starts at 0; firing immediately is
   * harmless there too, but leaving the option visible for future
   * watchers that genuinely need to skip).
   */
  fireImmediately?: boolean;
}

/**
 * Start a polling watcher. Returns a `stop()` that clears the interval
 * AND removes the message listener (the latter is important — a stop()
 * that left the listener attached would leak across reboots).
 */
export function createPollingWatcher<TReply = unknown>(
  cfg: PollingWatcherConfig<TReply>,
): () => void {
  const intervalMs = cfg.intervalMs ?? 2000;
  const fireImmediately = cfg.fireImmediately ?? true;

  function onMessage(evt: MessageEvent): void {
    const data = evt.data;
    if (!data || data.type !== cfg.replyType) return;
    cfg.onReply(data as TReply);
  }
  cfg.worker.addEventListener("message", onMessage);

  const handle = window.setInterval(() => {
    cfg.worker.postMessage(cfg.buildPollMessage());
  }, intervalMs);

  if (fireImmediately) {
    cfg.worker.postMessage(cfg.buildPollMessage());
  }

  return () => {
    window.clearInterval(handle);
    cfg.worker.removeEventListener("message", onMessage);
  };
}
