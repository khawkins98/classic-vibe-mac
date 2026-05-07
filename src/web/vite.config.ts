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
    // BasiliskII WASM needs SharedArrayBuffer, which requires cross-origin
    // isolation. These headers also need to be set by GitHub Pages — see
    // the PRD risks section. For Pages we'll likely need a service worker
    // shim (e.g. coi-serviceworker) since Pages can't set response headers.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
