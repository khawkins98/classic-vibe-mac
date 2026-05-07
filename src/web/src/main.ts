import { emulatorConfig } from "./emulator-config";

const root = document.getElementById("app");
if (!root) {
  throw new Error("missing #app root element");
}

root.innerHTML = `
  <main style="font-family: ui-monospace, monospace; padding: 2rem; max-width: 60ch;">
    <h1>classic-mac-builder</h1>
    <p>TODO: BasiliskII goes here.</p>
    <p>
      This is a placeholder. The next step is to wire a BasiliskII WASM core
      (pulled from the Infinite Mac repo, Apache-2.0) into a Web Worker, mount
      the System 7.5.5 boot disk, and attach our custom <code>app.dsk</code>
      as a secondary drive so its Startup Items auto-launch.
    </p>
    <h2>Planned config</h2>
    <pre id="config"></pre>
  </main>
`;

const configEl = document.getElementById("config");
if (configEl) {
  configEl.textContent = JSON.stringify(emulatorConfig, null, 2);
}
