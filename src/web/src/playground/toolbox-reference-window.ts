/**
 * toolbox-reference-window.ts — pinned WinBox reference window for
 * Mac Toolbox calls (cv-mac #196 Phase 3 follow-up to #204).
 *
 * The hover tooltip from #204 is great for "what does this do?" while
 * you're scanning code, but it's ephemeral — move the mouse and it's
 * gone. ⌘-clicking a known Toolbox identifier in the editor opens THIS
 * window: same Inside-Macintosh-style card, but pinned, draggable,
 * and with clickable "See also" entries you can navigate without
 * dismissing the window.
 *
 * Singleton — re-clicking just updates the visible entry. Closing it
 * fully clears state.
 */

// Side-effect import the WinBox bundle (broken main field) — same
// trick the other palettes use.
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "../winboxChrome";
import refData from "./toolbox-reference.json";

interface ToolboxEntry {
  header: string;
  signature: string;
  blurb: string;
  seeAlso?: string[];
}

// Strip the _meta key so it doesn't show up in lookups or the picker.
const reference: Record<string, ToolboxEntry> = Object.fromEntries(
  Object.entries(refData as Record<string, unknown>).filter(
    ([k]) => !k.startsWith("_"),
  ),
) as Record<string, ToolboxEntry>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

/** Singleton handle so re-clicks re-use the existing window. */
interface ActiveRef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wb: any;
  body: HTMLDivElement;
  show: (name: string) => void;
}
let active: ActiveRef | null = null;

/**
 * Open the reference window pinned to a specific symbol. Re-callable
 * to navigate inside the same window (re-renders the body, doesn't
 * spawn a new WinBox).
 */
export function openToolboxReference(name: string): void {
  if (!reference[name]) return;
  if (active) {
    active.show(name);
    active.wb.focus();
    return;
  }

  const body = document.createElement("div");
  body.className = "cvm-toolbox-ref";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Toolbox Reference",
    width: "440px",
    height: "360px",
    x: "right",
    y: "center",
    mount: body,
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-toolbox-winbox", "cvm-mac-winbox"],
    onclose: () => {
      active = null;
      return false;
    },
  });
  enableShade(wb);

  // Click handler for "See also" — delegate from the body element so
  // we only attach once and it survives the re-renders below.
  body.addEventListener("click", (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>(
      "a[data-cvm-toolbox-ref]",
    );
    if (!a) return;
    e.preventDefault();
    const target = a.dataset.cvmToolboxRef!;
    if (reference[target]) {
      render(body, target);
      wb.setTitle(`Toolbox Reference — ${target}`);
    }
  });

  function show(n: string) {
    render(body, n);
    wb.setTitle(`Toolbox Reference — ${n}`);
  }

  active = { wb, body, show };
  show(name);
}

/** Replace the body content with a rendered card for `name`. */
function render(body: HTMLDivElement, name: string): void {
  const entry = reference[name]!;
  body.innerHTML = "";

  const head = document.createElement("div");
  head.className = "cvm-toolbox-ref__head";
  const title = document.createElement("h3");
  title.className = "cvm-toolbox-ref__name";
  title.textContent = name;
  const headerLink = document.createElement("code");
  headerLink.className = "cvm-toolbox-ref__include";
  headerLink.textContent = `<${entry.header}>`;
  head.append(title, headerLink);

  const sig = document.createElement("pre");
  sig.className = "cvm-toolbox-ref__sig";
  sig.textContent = entry.signature;

  const blurb = document.createElement("p");
  blurb.className = "cvm-toolbox-ref__blurb";
  blurb.textContent = entry.blurb;

  body.append(head, sig, blurb);

  if (entry.seeAlso && entry.seeAlso.length) {
    const seeAlsoHeading = document.createElement("h4");
    seeAlsoHeading.className = "cvm-toolbox-ref__see-also-heading";
    seeAlsoHeading.textContent = "See also";
    const seeAlso = document.createElement("ul");
    seeAlso.className = "cvm-toolbox-ref__see-also";
    for (const ref of entry.seeAlso) {
      const li = document.createElement("li");
      if (reference[ref]) {
        // Clickable navigation link — the delegated handler above
        // catches the click and re-renders.
        const a = document.createElement("a");
        a.href = "#";
        a.dataset.cvmToolboxRef = ref;
        a.textContent = ref;
        li.append(a);
      } else {
        // Listed but no reference data yet — show as plain text so
        // the user knows what to learn about, without leading them
        // to a dead link.
        li.textContent = ref;
        li.classList.add("cvm-toolbox-ref__see-also-stub");
        li.title = "Not yet in the reference. PRs welcome.";
      }
      seeAlso.append(li);
    }
    body.append(seeAlsoHeading, seeAlso);
  }

  // Footer pointer back to Inside Macintosh sources.
  const footer = document.createElement("p");
  footer.className = "cvm-toolbox-ref__footer";
  footer.innerHTML =
    'Source: Inside Macintosh series (Apple, 1992–1994). One-paragraph summaries paraphrased for brevity.';
  body.append(footer);
}

/** Returns true if `name` is a known Toolbox identifier the reference
 *  has an entry for. Used by editor.ts to decide whether a ⌘-click
 *  should open the window. */
export function isToolboxIdentifier(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(reference, name);
}
