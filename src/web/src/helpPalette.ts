/**
 * Help palette (cv-mac #104 Phase 6).
 *
 * A floating WinBox window with quick-start guidance, links to the
 * deeper docs, and a keyboard-shortcuts cheat sheet. Trigger: the
 * menubar's "Help" item.
 *
 * Singleton — calling openHelp() while one is already open just brings
 * the existing window to the front and re-focuses it instead of
 * stacking another copy.
 */

// Side-effect import the WinBox bundle — its main field is broken (see
// projectPicker.ts for the trail) so we reach for the global at runtime.
import "winbox/dist/winbox.bundle.min.js";
import { enableShade } from "./winboxChrome";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WinBox: any = (globalThis as any).WinBox;

let active: { focus: () => void; close: () => void } | null = null;

export function openHelp(): void {
  if (active) {
    active.focus();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wb: any = new WinBox({
    title: "Help — classic-vibe-mac",
    width: "560px",
    height: "560px",
    x: "right",
    y: 80,
    html: HELP_HTML,
    background: "#cccccc",
    class: ["no-full", "cvm-help-winbox", "cvm-mac-winbox"],
    onclose: () => {
      active = null;
      return false; // allow close
    },
  });
  enableShade(wb);
  active = { focus: () => wb.focus(), close: () => wb.close() };
}

const HELP_HTML = /* html */ `
<div class="cvm-help">
  <h2 class="cvm-help__title">classic-vibe-mac</h2>
  <p class="cvm-help__tagline">
    A 1993 Macintosh that lives at a URL — and lets you build apps for
    it in the same tab.
  </p>

  <h3>Quick start</h3>
  <ol>
    <li>Pick a project in the <strong>Project</strong> pane on the
        left, or open <em>File → Open Project…</em> for a richer
        picker. Eleven samples ship — a Toolbox-surface ladder from
        <strong>Wasm Hello</strong> (DrawString) up through
        <strong>Wasm Notepad</strong> (TextEdit + menu bar),
        <strong>Wasm Scribble</strong> (mouse-tracking), and
        <strong>Wasm Bounce</strong> (offscreen-buffer animation).</li>
    <li>Edit the source in the center editor. Edits save automatically
        to your browser (IndexedDB).</li>
    <li>Click <em>Build &amp; Run</em>. The page compiles your changes
        in-browser and the Mac in the top-right reboots with your
        edits in ~1 second.</li>
    <li>Compiler stage timings + identity stamps appear in the
        <em>Output</em> panel (bottom right). <em>Special → Reboot
        Mac</em> re-launches the last build without recompiling.</li>
  </ol>

  <h3>How it compiles</h3>
  <p>
    Everything compiles in your browser. Your <code>.c</code> source
    runs through <code>cc1</code> + <code>as</code> + <code>ld</code> +
    <code>Elf2Mac</code> (Retro68's toolchain, wasm-built via
    <a href="https://github.com/khawkins98/wasm-retro-cc" target="_blank">wasm-retro-cc</a>);
    any <code>.r</code> resource files alongside them go through
    in-browser WASM-Rez and the two forks are spliced into a single
    classic-Mac binary. The running app is always whatever you just
    typed — no CI step in the loop.
  </p>

  <h3>Layout (Mac OS 8 style)</h3>
  <ul>
    <li><strong>Left:</strong> Project pane — dropdown to switch
        projects + the file list for the active one. <em>Open project…</em>
        opens a richer picker with descriptions + import from .zip.</li>
    <li><strong>Center:</strong> Editor with build buttons, optimisation
        level, and Show Assembly toggle.</li>
    <li><strong>Top-right:</strong> The Mac. Live preview of whatever
        your edits build.</li>
    <li><strong>Bottom-right:</strong> Output panel — Build log
        (cc1 / as / ld / Elf2Mac timings) and Console (DebugStr
        capture, coming soon).</li>
  </ul>

  <h3>Save / share your work</h3>
  <p>
    <em>Download .zip</em> on the Playground toolbar packages your
    current project's files for offline editing or sharing. <em>Open
    project… → Open .zip…</em> accepts a zip back — overwrites the
    matching project's files in your browser. The two round-trip
    cleanly.
  </p>
  <p>
    <em>Reset</em> on the Playground toolbar discards your in-browser
    edits to the current project and re-fetches every file from the
    bundled defaults. Useful when the sample sources have been updated
    server-side and you want the new defaults. Other projects' edits
    are kept.
  </p>

  <h3>Build feedback</h3>
  <p>
    The Output panel shows per-build timings as <code>[build-c]</code>
    lines plus a <code>[cvm-stats]</code> session summary so you can
    see the in-memory build cache paying off over a long debug session.
    Compile errors land in the same panel as clickable
    <em>file:line:col</em> entries — clicking one jumps the editor's
    cursor to that source location.
  </p>
  <p>
    The right edge of the menubar shows the running build hash
    (<code>cv-mac &lt;hash&gt;</code>). Click it to open the About box.
  </p>

  <h3>Keyboard shortcuts</h3>
  <table class="cvm-help__kbd">
    <tbody>
      <tr><th colspan="2">Menubar</th></tr>
      <tr><td><kbd>F10</kbd> · <kbd>Alt</kbd></td>
          <td>Enter menubar from anywhere (toggles)</td></tr>
      <tr><td><kbd>←</kbd> <kbd>→</kbd></td>
          <td>Walk between menus</td></tr>
      <tr><td><kbd>↓</kbd></td>
          <td>Open the focused menu</td></tr>
      <tr><td><kbd>↑</kbd> <kbd>↓</kbd></td>
          <td>Walk items inside a menu</td></tr>
      <tr><td><kbd>Home</kbd> · <kbd>End</kbd></td>
          <td>First / last item</td></tr>
      <tr><td>letter</td>
          <td>Jump to next item starting with that letter (type-ahead)</td></tr>
      <tr><td><kbd>Enter</kbd> · <kbd>Space</kbd></td>
          <td>Fire focused item</td></tr>
      <tr><td><kbd>Esc</kbd></td>
          <td>Close menu, restore focus</td></tr>
      <tr><th colspan="2">Commands</th></tr>
      <tr><td><kbd>⌘O</kbd></td><td>File → Open Project…</td></tr>
      <tr><td><kbd>⌘S</kbd></td><td>File → Download .zip</td></tr>
      <tr><td><kbd>⌘,</kbd></td><td>Edit → Preferences…</td></tr>
      <tr><td><kbd>⌘?</kbd></td><td>Help → classic-vibe-mac Help</td></tr>
      <tr><th colspan="2">Editor (when typing in the source pane)</th></tr>
      <tr><td><kbd>⌘F</kbd></td><td>Find</td></tr>
      <tr><td><kbd>⌘G</kbd> · <kbd>⇧⌘G</kbd></td><td>Next / previous match</td></tr>
      <tr><td><kbd>⌘⌥F</kbd></td><td>Find &amp; replace</td></tr>
      <tr><td><kbd>Esc</kbd></td><td>Close the search panel</td></tr>
      <tr><td>hover a Toolbox call</td>
          <td>Inside-Macintosh-style signature + blurb in a tooltip</td></tr>
      <tr><td><kbd>⌘-click</kbd> a Toolbox call</td>
          <td>Open the pinned <em>Toolbox Reference</em> window
              (also at <em>Help → Toolbox Reference…</em>)</td></tr>
      <tr><th colspan="2">Windows</th></tr>
      <tr><td>double-click titlebar</td>
          <td>Shade (collapse to titlebar) / unshade</td></tr>
      <tr><td>drag titlebar / edge / corner</td>
          <td>Move / resize</td></tr>
      <tr><td>click body</td>
          <td>Raise to front</td></tr>
      <tr><td>View → Reset window layout</td>
          <td>Tile back to default positions</td></tr>
    </tbody>
  </table>
  <p class="cvm-help__kbd-note">
    On Windows / Linux the modifier is <kbd>Ctrl</kbd> instead of
    <kbd>⌘</kbd>. The menubar's dropdowns show the platform-appropriate
    label live.
  </p>

  <h3>Deeper reading</h3>
  <ul>
    <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/README.md" target="_blank">README</a> — three reader paths (what / how / build on)</li>
    <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/docs/HOW-IT-WORKS.md" target="_blank">HOW-IT-WORKS.md</a> — guided tour from URL to running Mac</li>
    <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/docs/ARCHITECTURE.md" target="_blank">ARCHITECTURE.md</a> — boot pipeline, SharedArrayBuffer layout, chunked disks</li>
    <li><a href="https://github.com/khawkins98/wasm-retro-cc" target="_blank">wasm-retro-cc</a> — the wasm toolchain itself (sibling repo)</li>
    <li><a href="https://github.com/khawkins98/classic-vibe-mac/blob/main/LEARNINGS.md" target="_blank">LEARNINGS.md</a> — 7 Key Stories + dated gotcha log</li>
  </ul>

  <h3>Roadmap</h3>
  <p>
    Forward-looking work: multi-file C support + mixed C + .r in a
    single project (<a href="https://github.com/khawkins98/classic-vibe-mac/issues/100" target="_blank">#100</a>),
    PowerPC / Mac OS 8-9 investigation
    (<a href="https://github.com/khawkins98/classic-vibe-mac/issues/98" target="_blank">#98</a>),
    Musashi 68k harness expansion
    (<a href="https://github.com/khawkins98/classic-vibe-mac/issues/89" target="_blank">#89</a>),
    full IDE retool (this one —
    <a href="https://github.com/khawkins98/classic-vibe-mac/issues/104" target="_blank">#104</a>).
  </p>

  <p class="cvm-help__credit">
    Built on Retro68 (Wolfgang Thaller), Infinite Mac (Mihai Parparita),
    BasiliskII (Christian Bauer + community), Apple System 7.5.5,
    WinBox (Thomas Wilkerling). See NOTICE for full attribution.
  </p>
</div>
`;
