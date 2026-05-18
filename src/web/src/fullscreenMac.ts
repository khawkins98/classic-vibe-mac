/**
 * fullscreenMac.ts — Fullscreen-Mac mode + reserved-shortcut notice.
 *
 * Browsers reserve a small set of ⌘-shortcuts (⌘N new window, ⌘T new
 * tab, ⌘W close tab, ⌘Q quit, ⌘L address bar, ⌘⇧N private) and refuse
 * to hand them to web pages via preventDefault(). The only documented
 * escape hatch is the Keyboard Lock API (navigator.keyboard.lock) —
 * Chromium-only, requires fullscreen + secure context, and only
 * actually captures those keys while the document is fullscreen.
 *
 * What we do:
 *   - On supported browsers: surface a "Fullscreen Mac" button in the
 *     Macintosh pane caption. Click → requestFullscreen on the
 *     #emulator element, then navigator.keyboard.lock the reserved
 *     shortcuts. Exit (Esc) auto-releases via the fullscreenchange
 *     listener.
 *   - On unsupported browsers (Firefox, Safari): show a one-shot
 *     notice the first time the user clicks into the Mac pane,
 *     explaining what they can't do without the Chromium path.
 *
 * The reserved-keys list mirrors what BasiliskII users actually reach
 * for from inside Mac apps — File → New (⌘N), File → Open (⌘O is
 * already free), Quit (⌘Q). ⌘L (URL bar) and ⌘T (new tab) included so
 * cursoring around inside the emulated browser-equivalent doesn't pop
 * the host browser to the front.
 */

const FS_BTN_ID = "cvm-mac-fullscreen";
const NOTE_ID = "cvm-mac-reserved-keys-note";
const NOTE_DISMISSED_FLAG = "cvm-mac-reserved-keys-note-dismissed";

const RESERVED_KEYS = [
  "KeyN", // ⌘N — new window
  "KeyT", // ⌘T — new tab
  "KeyW", // ⌘W — close tab
  "KeyQ", // ⌘Q — quit (macOS) / not reserved on Win/Linux but harmless to lock
  "KeyL", // ⌘L — focus URL bar
  "KeyR", // ⌘R — reload (users may want it inside an emulated browser-likeness)
];

interface KeyboardLockExt {
  lock?: (keyCodes: string[]) => Promise<void>;
  unlock?: () => void;
}

function getKeyboardLock(): KeyboardLockExt | undefined {
  // Keyboard Lock API: experimental, Chromium-only. We probe defensively
  // because TypeScript's lib.dom.d.ts doesn't declare navigator.keyboard.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nav = navigator as any;
  return nav.keyboard as KeyboardLockExt | undefined;
}

function isSupported(): boolean {
  const kb = getKeyboardLock();
  return (
    typeof document.documentElement.requestFullscreen === "function" &&
    typeof kb?.lock === "function"
  );
}

async function enterFullscreenMac(): Promise<void> {
  const target =
    document.getElementById("emulator") ?? document.documentElement;
  try {
    await target.requestFullscreen();
  } catch (err) {
    console.warn("[fullscreen-mac] requestFullscreen rejected:", err);
    return;
  }
  const kb = getKeyboardLock();
  if (kb?.lock) {
    try {
      await kb.lock(RESERVED_KEYS);
    } catch (err) {
      // Lock can fail (insecure context, browser policy) — fullscreen
      // still works without it, the user just loses ⌘N capture.
      console.warn("[fullscreen-mac] keyboard.lock rejected:", err);
    }
  }
}

function releaseKeyboardLock(): void {
  const kb = getKeyboardLock();
  if (kb?.unlock) {
    try {
      kb.unlock();
    } catch {
      /* harmless — already released or never acquired */
    }
  }
}

function installFullscreenButton(): void {
  const btn = document.getElementById(FS_BTN_ID) as HTMLButtonElement | null;
  if (!btn) return;
  if (!isSupported()) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.addEventListener("click", () => {
    void enterFullscreenMac();
  });
  // Release the keyboard lock on fullscreen exit so the host browser
  // gets its shortcuts back. The browser auto-releases too, but being
  // explicit also covers the case where the user F11s out manually.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      releaseKeyboardLock();
    }
  });
}

function installReservedKeysNotice(): void {
  if (isSupported()) return; // Chromium gets the button instead — no notice
  const note = document.getElementById(
    NOTE_ID,
  ) as HTMLDivElement | null;
  if (!note) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(NOTE_DISMISSED_FLAG) === "1";
  } catch {
    /* private browsing — fall through, show the notice */
  }
  if (dismissed) return;

  // Reveal the notice on the first pointerdown that lands inside the
  // Mac pane — same signal activePane.ts uses, but we listen once-only.
  // Showing it eagerly on page load would compete with the welcome
  // modal; tying it to first-click means the user only sees it once
  // they've shown intent to interact with the Mac.
  const onFirstMacClick = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (!t?.closest(".cvm-pane-mac")) return;
    note.hidden = false;
    document.removeEventListener("pointerdown", onFirstMacClick, true);
  };
  document.addEventListener("pointerdown", onFirstMacClick, true);

  const closeBtn = note.querySelector<HTMLButtonElement>(
    ".cvm-mac-reserved-keys-note__close",
  );
  closeBtn?.addEventListener("click", () => {
    note.hidden = true;
    try {
      localStorage.setItem(NOTE_DISMISSED_FLAG, "1");
    } catch {
      /* ignore */
    }
  });
}

let installed = false;

/** Wire the Fullscreen Mac button and the reserved-keys notice. Idempotent. */
export function installFullscreenMac(): void {
  if (installed) return;
  installed = true;
  installFullscreenButton();
  installReservedKeysNotice();
}
