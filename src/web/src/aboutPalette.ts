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
    width: "440px",
    height: "440px",
    x: "center",
    y: "center",
    html: ABOUT_HTML,
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

const ABOUT_HTML = /* html */ `
  <div class="cvm-about">
    <h2 class="cvm-about__title">classic-vibe-mac</h2>
    <p class="cvm-about__tagline">
      A 1993 Macintosh that lives at a URL — and lets you build apps
      for it in the same tab.
    </p>

    <p class="cvm-about__lede">
      Edit C and Rez source in your browser. The page compiles it
      through Retro68's toolchain (wasm-built via
      <a href="https://github.com/khawkins98/wasm-retro-cc" target="_blank">wasm-retro-cc</a>),
      splices the resource fork, and reboots a System 7.5.5 emulator
      with your new binary. No server in the loop.
    </p>

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
