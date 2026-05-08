// Extension: cvm-context
// Injects classic-vibe-mac project context at session start so every
// Copilot session is immediately oriented — no re-explaining needed.

import { joinSession } from "@github/copilot-sdk/extension";

const PROJECT_CONTEXT = `
## classic-vibe-mac — project context (auto-injected)

**What it is:** A static GitHub Pages site that boots System 7.5.5 in the
browser (BasiliskII WASM), plus an in-browser playground where visitors edit
C/Rez source, compile via WASM-Rez, and hot-load their app back into the Mac
in ~820ms. No backend. No relay. No auth. Everything runs in the visitor's tab.

### Repository layout
- \`src/app/\`          — Classic Mac C apps (reader, macweather, hello-mac)
- \`src/web/src/\`      — Vite/TS host page + playground UI
  - \`emulator-loader.ts\` — spawns/restarts the emulator worker
  - \`emulator-worker.ts\` — BasiliskII WASM init, SAB allocation, disk API
  - \`playground/\`        — Build & Run pipeline (preprocessor→Rez→patcher)
- \`tools/wasm-rez/\`   — WASM-compiled Rez binary (vendored)
- \`scripts/\`          — boot-disk builder, CI helpers
- \`tests/\`            — unit (C + JS) + e2e (Playwright) + visual
- \`docs/\`             — ARCHITECTURE.md, PLAYGROUND.md, AGENT-PROCESS.md, DEVELOPMENT.md

### Mac app architecture (the split)
Every app follows the **Toolbox-shell + pure-C-engine** pattern:
- **Toolbox shell** (\`<app>.c\`) — System 7 event loop, QuickDraw rendering,
  Toolbox calls. Not unit-testable on host.
- **Pure-C engine** (\`<app>-engine.c/h\`) — parsing, data logic, no Toolbox.
  Fully unit-testable with \`npm run test:unit:c\`.

### Build loops (fastest first)
1. \`npm run test:unit\`          — sub-second; no browser/emulator needed
2. Docker Retro68 cross-compile + \`scripts/build-boot-disk.sh\` — 1–3 min
3. Push to main → CI build → GitHub Pages deploy — 5–10 min

### Dev commands
\`\`\`
npm run dev            # Vite dev server (localhost:5173, SAB headers set)
npm run build          # Production web build
npm run test:unit      # C unit tests + JS unit tests
npm run test:e2e       # Playwright end-to-end
npm run test:visual    # Playwright visual regression
npm run fetch:emulator # Download BasiliskII.wasm + ROM
\`\`\`

### Key constraints (load-bearing for every design decision)
- Everything runs as JavaScript in the visitor's browser
- No backend, no relay, no auth, no compile service
- Epics #12 and #19 were closed specifically for violating these constraints

### Open issues (as of 2026-05-08)
**UX/layout:** #45 (IDE two-pane layout), #46 (Build & Run UX modal), #25 (side-by-side at ≥1200px)
**Playground v1.2:** #22 (file tree+tabs), #23 (Rez syntax highlight), #24 (3-way diff)
**New demo apps:** #17 (Pixel Pad — Mac→JS data flow), #9 (Markdown viewer+editor)
**Technical:** #48 (color rendering), #47 (audio stub), #44 (boot disk diet)
**Networking:** #15 (AppleTalk via Infinite Mac relay), #14 (Reader URL bar)
**Docs:** #52 (first-commit recipe), #53 (surface troubleshooting), #54 (canonical shipped-status)
**Meta:** #49 (architecture review ~6 weeks in), #21 (Epic v2 parent)

### Key gotchas (from LEARNINGS.md)
- CI step ordering: post-build artefact copies go INTO dist/, not before build
- BasiliskII WASM init contract: audio deliberately stubbed (audioBufferSize=0)
- COOP/COEP: use \`credentialless\` not \`require-corp\` for COEP (CDN fonts/images)
- Pre-commit hooks: never \`--no-verify\`; fix the underlying issue

### Review process (five-reviewer red-flag pass)
For any Epic: dispatch 5 independent reviewer agents with different lenses
(domain expert, scope/PM, security/abuse, infra feasibility, legal/IP,
editor/UX, compilation/runtime, hot-load/dev-loop). Consolidate HIGH findings
as show-stoppers. See docs/AGENT-PROCESS.md.
`;

const session = await joinSession({
    hooks: {
        onSessionStart: async () => {
            return {
                additionalContext: PROJECT_CONTEXT,
            };
        },
    },
    tools: [],
});

