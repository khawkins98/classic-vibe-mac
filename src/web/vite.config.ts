import { defineConfig } from "vite";

// GitHub Pages serves the site under /<repo-name>/ when using a project page
// (e.g. https://<user>.github.io/classic-vibe-mac/). Override at build time
// with VITE_BASE=/your-repo-name/ npm run build.
//
// TODO: once the canonical repo name is decided, hard-code the default here
// (e.g. "/classic-vibe-mac/") so a fresh fork's CI build works without env
// configuration. For local `npm run dev` we always want "/".
const base = process.env.VITE_BASE ?? "/";

export default defineConfig({
  base,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // TODO (build pipeline): after `vite build`, the CI workflow should copy
    // the freshly-built `app.dsk` (produced by scripts/build-disk-image.sh)
    // into `src/web/dist/` so it sits next to index.html and gets served by
    // GitHub Pages at `/app.dsk`. The emulator config in `src/emulator.ts`
    // expects to fetch it from that path. We deliberately do NOT use Vite's
    // `publicDir` for app.dsk because the disk image is generated outside the
    // web tree — it's a CI artifact, not a source asset.
  },
  server: {
    port: 5173,
    // BasiliskII (Infinite Mac WASM build) uses SharedArrayBuffer for the
    // shared input/video buffer between main thread and emulator worker.
    // SharedArrayBuffer requires cross-origin isolation, which requires
    // both COOP and COEP headers on the document response.
    //
    // Dev: Vite sets these on its dev server below.
    //
    // Production / GitHub Pages: Pages cannot set response headers (it's a
    // pure static host with no _headers/wrangler-style config). The chosen
    // workaround is `coi-serviceworker` (https://github.com/gzuidhof/coi-serviceworker),
    // which registers a service worker that re-issues every navigation
    // request with COOP/COEP headers attached. The shim is ~3KB, MIT-licensed,
    // and the standard fix for SharedArrayBuffer-on-Pages. We do not yet
    // ship it; once the boot disk plumbing lands (see emulator-config.ts)
    // and the worker actually needs SAB, the shim ships as a vendored
    // copy under public/ and a single <script> tag in index.html.
    //
    // Fallback if the shim ever proves problematic: BasiliskII has a non-SAB
    // mode (jsfrequentreadinput=false in BasiliskIIPrefs) that uses
    // service-worker-mediated message passing. Slower input latency, but no
    // isolation requirement. Listed here so the next agent doesn't have to
    // re-derive it.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      // `credentialless` instead of `require-corp` so the worker can
      // make cross-origin fetches (e.g. api.open-meteo.com for
      // MacWeather) without the remote needing to opt in via a
      // Cross-Origin-Resource-Policy header. Same SAB guarantees;
      // browsers also strip cookies on the cross-origin fetch.
      // Production keeps `require-corp` via coi-serviceworker which
      // rewrites response headers, so cross-origin fetches there pass
      // through the shim.
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
});
