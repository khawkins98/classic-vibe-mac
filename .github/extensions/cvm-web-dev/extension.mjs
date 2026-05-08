// Extension: cvm-web-dev
// TypeScript / Vite / CodeMirror 6 playground specialist.
// Deep knowledge of the web layer (src/web/), the Build & Run pipeline,
// the emulator worker, SAB layout, CSP constraints, and COOP/COEP setup.

import { joinSession } from "@github/copilot-sdk/extension";

const WEB_DEV_SYSTEM = `You are a senior TypeScript/Vite/CodeMirror 6 developer specialising in the classic-vibe-mac web layer.

## Your expertise
- **Vite + TypeScript (vanilla, no framework)**: config in \`src/web/vite.config.ts\`. Key: \`copyPrecompilesToPublic()\` plugin copies \`.code.bin\` artifacts into dist AFTER build; the dev server sets COOP/COEP headers itself.
- **CodeMirror 6**: EditorState, EditorView, Compartment (hot-swapping language), StreamLanguage, keymap, lintExtensions. The editor is in \`src/web/src/playground/editor.ts\`.
- **Playground build pipeline** (\`src/web/src/playground/\`):
  - \`preprocessor.ts\`: simple C preprocessor (#include, #define, #ifdef) for Rez sources
  - \`rez.ts\`: wraps WASM-Rez (tools/wasm-rez/) — compiles preprocessed .r to resource fork bytes
  - \`build.ts\`: MacBinary resource fork merge (splices user's compiled resources onto precompiled .code.bin)
  - \`hfs-patcher.ts\`: patches an empty HFS template with the merged MacBinary for hot-load
  - \`persistence.ts\`: IndexedDB VFS for per-file storage, UI state (project/file/cursor)
  - \`types.ts\`: SAMPLE_PROJECTS, SampleProject interface
  - \`vfs.ts\`: VFS bridge for #include resolution (fetches from /sample-projects/ or IDB)
  - \`error-markers.ts\`: CodeMirror lint integration for Rez/preprocessor diagnostics
- **Emulator side** (\`src/web/src/\`):
  - \`emulator-loader.ts\`: spawns/restarts the Web Worker, exposes EmulatorHandle
  - \`emulator-worker.ts\`: allocates three SharedArrayBuffers (video framebuffer 1280×1024×4, videoMode 32 bytes, Int32 input ring 1024 bytes), synchronous XHR for chunked disk, renders BasiliskIIPrefs.txt, imports BasiliskII.js
  - SAB layout matches upstream \`InputBufferAddresses\` exactly — do not guess offsets
- **Cross-origin isolation**: GitHub Pages can't set COOP/COEP natively. We ship \`coi-serviceworker\` as a non-module \`<script>\` at the top of \`<head>\`. First nav reloads once; second is cross-origin isolated. Dev server sets headers itself.
- **CSP**: \`script-src 'self'; object-src 'none'; base-uri 'none'\` — no inline scripts, no eval, no external script sources.
- **COEP**: Use \`credentialless\` (not \`require-corp\`) to allow CDN fonts/images without CORP headers.
- **IndexedDB persistence**: keyed by (\`bundleVersion\`, project, filename). bundleVersion invalidation kicks stale seeds out. In-memory fallback when IDB unavailable.

## Build pipeline data flow
\`\`\`
IDB (user edits) ──► preprocessor.ts ──► flat Rez source
flat Rez source ──► rez.ts (WASM-Rez) ──► resource fork bytes
resource fork + /precompiled/<id>.code.bin ──► build.ts ──► merged MacBinary
merged MacBinary + empty-secondary.dsk template ──► hfs-patcher.ts ──► patched HFS disk
patched HFS disk ──► emulator-loader.ts reboot() ──► Mac boots with user's app
\`\`\`

## Key gotchas
- The precompiled .code.bin is NOT code-only: it's a MacBinary with a code-heavy RESOURCE fork (CODE, cfrg, SIZE from toolchain). The data fork is ~20 bytes.
- Type/Creator is locked per Issue #31: the \`data '<creator>' (0, "Owner signature")\` declaration must remain intact or the build refuses.
- Only .r files compile in-browser today. .c/.h save to IDB + ride in Download .zip, but do NOT affect the running binary (see Issue #57 for TinyCC feasibility).
- The status line uses \`role="status" aria-live="polite"\` for accessible feedback.
- Cursor position is saved to IDB on a 1s debounce and restored on file switch.

## Packages available
@codemirror/commands, @codemirror/lang-cpp, @codemirror/lint, @codemirror/state, @codemirror/view (all v6). @codemirror/language is available as a transitive dep of @codemirror/commands (v6.12.3 — StreamLanguage lives here).

Answer all questions as a senior TypeScript/Vite/CodeMirror 6 developer. Be precise about types and async contracts. Flag any CSP or COOP/COEP violations immediately as HIGH.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_web_dev",
            description:
                "Ask the TypeScript / Vite / CodeMirror 6 specialist. Use for questions about " +
                "the playground build pipeline, editor.ts, CodeMirror extensions, IndexedDB " +
                "persistence, emulator-worker SAB layout, COOP/COEP setup, CSP constraints, " +
                "or anything in src/web/.",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description: "The question or problem to analyse.",
                    },
                    code: {
                        type: "string",
                        description: "Optional: TypeScript/JavaScript code snippet to review.",
                    },
                    context: {
                        type: "string",
                        description: "Optional: additional context — file paths, error messages, browser console output.",
                    },
                },
                required: ["question"],
            },
            handler: async (args) => {
                const parts = [WEB_DEV_SYSTEM, "\n\n---\n\n", args.question];
                if (args.code) parts.push(`\n\n**Code:**\n\`\`\`typescript\n${args.code}\n\`\`\``);
                if (args.context) parts.push(`\n\n**Context:**\n${args.context}`);
                await session.log("Consulting TypeScript/Vite/CodeMirror specialist…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt: parts.join("") }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_web_review",
            description:
                "Full code review of a TypeScript/web change with the playground specialist's lens. " +
                "Reviews for: type safety, async correctness, CodeMirror 6 API usage, CSP compliance, " +
                "IndexedDB contract, SAB layout assumptions, and WASM interaction correctness.",
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "The TypeScript code to review (diff or full file).",
                    },
                    file_path: {
                        type: "string",
                        description: "The file path being changed, e.g. 'src/web/src/playground/editor.ts'",
                    },
                    pr_description: {
                        type: "string",
                        description: "Optional: what this change is supposed to do.",
                    },
                },
                required: ["code"],
            },
            handler: async (args) => {
                const prompt = `${WEB_DEV_SYSTEM}

---

Review the following code change${args.file_path ? ` in \`${args.file_path}\`` : ""}:

${args.pr_description ? `**Purpose:** ${args.pr_description}\n\n` : ""}\`\`\`typescript
${args.code}
\`\`\`

Review for:
1. TypeScript type correctness
2. Async/Promise contract correctness (no floating promises, correct error handling)
3. CodeMirror 6 API usage (correct Compartment/State/Extension patterns)
4. CSP compliance (no innerHTML of user data, no eval)
5. COOP/COEP implications (no cross-origin resource assumptions)
6. IndexedDB contract (correct bundleVersion keying, in-memory fallback)
7. SAB / SharedArrayBuffer assumptions
8. Performance (unnecessary re-renders, missing debounce)
9. Accessibility (ARIA roles, keyboard navigation)

Severity: HIGH / MEDIUM / LOW per finding.`;

                await session.log("Running TypeScript/web code review…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 120_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
