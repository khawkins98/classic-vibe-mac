/**
 * console-watcher.ts — poll the Mac-side cvm_log() output and surface
 * new lines in the Output panel's "Console" tab.
 *
 * Architecture (mirrors drawing-watcher.ts):
 *   - Runs on the **main thread**. Every 1 second, posts `poll_console`
 *     with the running byte offset; worker reads /Shared/__cvm_console.log
 *     from that offset and replies with `console_data` carrying only
 *     the new tail bytes + the current file size.
 *   - Decodes the new bytes as MacRoman → UTF-8 (Pascal strings from
 *     the Mac side are MacRoman). Splits on \n and appends each line
 *     to the Console pane's <pre> with a monotonic timestamp.
 *   - Survives file truncation: if `totalSize < lastOffset`, the user
 *     called cvm_log_reset(); the watcher resets its UI and offset.
 *
 * The Console pane DOM lives in idePanes.ts (`#cvm-output-console`).
 * If the element isn't present (older HTML, headless test) the
 * watcher is a silent no-op.
 *
 * Worker message protocol:
 *   main → worker: { type: "poll_console"; fromOffset }
 *   worker → main: { type: "console_data"; bytes: Uint8Array | null; totalSize }
 *   (types declared in emulator-worker-types.ts)
 */

// MacRoman → Unicode for high-byte chars users are most likely to hit
// in log lines (typographic dashes, smart quotes, ellipsis, ™/®/©).
// Coverage isn't exhaustive; missing bytes fall back to U+FFFD via the
// Latin-1 baseline decode. ASCII (0x20-0x7E) is identical between
// MacRoman and Latin-1, which is the dominant log-line case.
const MAC_ROMAN_HIGH: Record<number, string> = {
  0xa9: "™", 0xaa: "®", 0xa8: "©", 0xc6: "∆", 0xc7: "«", 0xc8: "»",
  0xc9: "…", 0xd0: "–", 0xd1: "—", 0xd2: "“", 0xd3: "”",
  0xd4: "‘", 0xd5: "’", 0xa5: "•", 0xb6: "∂", 0xb9: "π",
  0xc2: "¬", 0xc3: "√", 0xa0: "†",
};
function macRomanToString(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b < 0x80) out += String.fromCharCode(b);
    else if (MAC_ROMAN_HIGH[b]) out += MAC_ROMAN_HIGH[b];
    else out += String.fromCharCode(b); // Latin-1 fallback (lossy for some glyphs)
  }
  return out;
}

export interface ConsoleWatcherConfig {
  /** The BasiliskII worker (already running). */
  worker: Worker;
  /** Poll interval in ms. Default: 1000. */
  intervalMs?: number;
}

let lastOffset = 0;
let partialLine = ""; // chunk that didn't end on \n — carry into next poll
let started = false;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}

function getPre(): HTMLPreElement | null {
  return document.getElementById("cvm-output-console") as HTMLPreElement | null;
}

function appendLine(line: string): void {
  const pre = getPre();
  if (!pre) return;
  const atBottom =
    pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.append(document.createTextNode(`${timestamp()} ${line}\n`));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

function ingest(bytes: Uint8Array, totalSize: number): void {
  // Detect truncation / reset.
  if (totalSize < lastOffset) {
    lastOffset = 0;
    partialLine = "";
    const pre = getPre();
    if (pre) pre.textContent = "";
    appendLine("— cvm console reset —");
  }
  if (!bytes.length) return;

  const text = partialLine + macRomanToString(bytes);
  const lines = text.split(/\r\n|\n|\r/);
  // Last fragment may be incomplete — carry forward.
  partialLine = lines.pop() ?? "";
  for (const line of lines) {
    appendLine(line);
  }
  lastOffset = totalSize;
}

/** Start polling. Called once from emulator-loader after the worker boots. */
export function startConsoleWatcher(cfg: ConsoleWatcherConfig): void {
  if (started) return;
  started = true;
  const interval = cfg.intervalMs ?? 1000;

  // Announce in the pane that the watcher is live — replaces the
  // "Coming soon" placeholder text on first paint. idePanes.ts
  // primes the pane with an empty <pre>; we add a header line.
  const pre = getPre();
  if (pre && !pre.textContent) {
    appendLine("Listening for cvm_log() output on :Unix:__cvm_console.log…");
  }

  cfg.worker.addEventListener("message", (ev: MessageEvent) => {
    const m = ev.data;
    if (!m || m.type !== "console_data") return;
    const bytes: Uint8Array | null = m.bytes;
    const totalSize: number = m.totalSize ?? 0;
    if (bytes) ingest(bytes, totalSize);
    else if (totalSize < lastOffset) {
      // Empty bytes + smaller size = truncation only (no new bytes yet).
      ingest(new Uint8Array(), totalSize);
    }
  });

  // Drive the polling loop.
  setInterval(() => {
    cfg.worker.postMessage({ type: "poll_console", fromOffset: lastOffset });
  }, interval);
}
