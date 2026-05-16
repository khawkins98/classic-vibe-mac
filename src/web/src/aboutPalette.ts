/**
 * About palette — "About classic-vibe-mac…" from the Apple menu.
 *
 * Mac OS 8-style About box: project tagline, brief credits, version,
 * links to the README and the sibling repos. Singleton — re-opening
 * just brings the existing window to the front.
 */

// Side-effect import the WinBox bundle (broken main field) and reach
// for the global at runtime. See projectPicker.ts for the trail.
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "./winboxChrome";
import { BUNDLE_VERSION, BUILT_AT, TOOLCHAIN_VERSION } from "./playground/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

let active: { focus: () => void; close: () => void } | null = null;

export function openAbout(): void {
  if (active) {
    active.focus();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "About classic-vibe-mac",
    width: "460px",
    height: "480px",
    x: "center",
    y: "center",
    html: aboutHtml(),
    background: "#cccccc",
    class: ["no-min", "no-max", "no-full", "cvm-about-winbox", "cvm-mac-winbox"],
    onclose: () => {
      active = null;
      return false;
    },
  });
  enableShade(wb);
  active = { focus: () => wb.focus(), close: () => wb.close() };
}

function fmtBuiltAt(iso: string): string {
  // Vite stamps an ISO timestamp; trim to the minute and keep the human-
  // readable shape (2026-05-15 22:43 UTC) rather than the raw ISO blob.
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return iso;
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

function aboutHtml(): string {
  const bundle = BUNDLE_VERSION.slice(0, 12);
  const toolchain = (TOOLCHAIN_VERSION || "(unset)").slice(0, 12);
  const built = fmtBuiltAt(BUILT_AT);
  return ABOUT_HTML_TMPL
    .replace("{{BUNDLE}}", bundle)
    .replace("{{TOOLCHAIN}}", toolchain)
    .replace("{{BUILT}}", built);
}

const ABOUT_HTML_TMPL = /* html */ `
  <div class="cvm-about">
    <h2 class="cvm-about__title">classic-vibe-mac</h2>
    <p class="cvm-about__tagline">
      A 1990s Macintosh that lives at a URL — and lets you build apps
      for it in the same tab.
    </p>

    <p class="cvm-about__lede">
      Edit C and Rez source in your browser. The page compiles it
      through Retro68's toolchain (wasm-built via
      <a href="https://github.com/khawkins98/wasm-retro-cc" target="_blank">wasm-retro-cc</a>),
      splices the resource fork, and reboots a System 7.5.5 emulator
      with your new binary. No server in the loop.
    </p>

    <h3>Build</h3>
    <dl class="cvm-about__build">
      <dt>Bundle</dt><dd><code>{{BUNDLE}}</code></dd>
      <dt>Toolchain</dt><dd><code>{{TOOLCHAIN}}</code></dd>
      <dt>Built</dt><dd>{{BUILT}}</dd>
    </dl>

    <h3>Links</h3>
    <ul class="cvm-about__links">
      <li><a href="https://github.com/khawkins98/classic-vibe-mac" target="_blank">classic-vibe-mac on GitHub</a></li>
      <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/README.md" target="_blank">README</a></li>
      <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/docs/HOW-IT-WORKS.md" target="_blank">HOW-IT-WORKS.md</a></li>
      <li><a href="https://github.com/khawkins98/wasm-retro-cc" target="_blank">wasm-retro-cc</a> (the wasm toolchain)</li>
    </ul>

    <h3>Built on</h3>
    <p class="cvm-about__credit">
      Retro68 (Wolfgang Thaller), Infinite Mac (Mihai Parparita),
      BasiliskII (Christian Bauer + community), Apple System 7.5.5,
      WinBox (Thomas Wilkerling). See NOTICE for full attribution.
    </p>
  </div>
`;
