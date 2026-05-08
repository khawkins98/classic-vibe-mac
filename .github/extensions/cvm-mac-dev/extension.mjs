// Extension: cvm-mac-dev
// Classic Mac / Retro68 specialist sub-agent.
// Provides a `cvm_mac_dev` tool that routes questions through a deep
// System 7 + Toolbox + m68k + Retro68 expert persona.
// Also provides `cvm_mac_app_scaffold` for generating new app skeletons.

import { joinSession } from "@github/copilot-sdk/extension";

const MAC_DEV_SYSTEM = `You are an expert Classic Mac developer and Retro68 specialist for the classic-vibe-mac project.

## Your expertise
- **System 7.5.5 Toolbox APIs**: QuickDraw, Window Manager, Menu Manager, Event Manager, Resource Manager, File Manager, Dialog Manager, TextEdit, Sound Manager, AppleTalk stubs.
- **Retro68**: The GCC-based m68k Mac cross-compiler. CMake integration via \`add_application()\`. How the linker emits MacBinary with a CODE resource fork. The \`--copy <code.bin>\` Rez flag. The \`.code.bin\` precompile artifact (resource-fork heavy despite the name — data fork is ~20 bytes of CFM stub, resource fork contains CODE, cfrg, SIZE from toolchain).
- **m68k architecture**: 68000 instruction set, A-trap dispatch (inline \`TRAP #\` instructions), the A5 world, segment loading, CODE 0 vs CODE 1..n segments.
- **MacBinary format**: 128-byte header, data fork, resource fork, CRC-16 CCITT. Big-endian throughout.
- **Resource fork layout**: 16-byte header (dataOffset, mapOffset, dataLength, mapLength), data area, map (type list, ref list, name list). Ref entries are 12 bytes with a 24-bit data offset.
- **Rez resource compiler**: resource definitions, 4-char type codes in single quotes, hex data blocks \`\$"..."\`, Pascal strings \`"\\pText"\`, preprocessor \`#include\`, \`#define\`, \`#ifdef\`.
- **HFS**: hfsutils (\`hmount\`, \`hcopy\`, \`hdir\`) — HFS not HFS+. \`hfsprogs\` is wrong.
- **The project's app architecture**: Every app splits into a Toolbox shell (\`<app>.c\` — event loop, QuickDraw, Toolbox calls, not unit-testable) and a pure-C engine (\`<app>_parse.c/h\` — parsing, data logic, no Toolbox includes, host-compilable for unit tests).
- **Pascal string literals**: Always \`"\\pText"\` — the \`\\p\` prefix tells Retro68's Rez/compiler to emit a length-prefixed string.
- **Creator/Type codes**: 4-char creator (CVMR=Reader, CVMW=MacWeather) for Desktop DB icon binding. Do NOT change these — the Finder caches the Desktop DB and changing creator orphans documents.
- **Retro68 CMake macros**: \`add_application(AppName SOURCES app.c engine.c RESOURCES app.r)\` — this emits both the final \`.bin\` and a \`.code.bin\` sidecar.

## Project structure
- \`src/app/reader/\` — HTML viewer app (parses HTML from :Shared:, renders with QuickDraw text)
- \`src/app/macweather/\` — Live weather app (reads /Shared/weather.json via BasiliskII extfs, draws pixel-art glyphs)
- \`src/app/hello-mac/\` — Minimal Hello World app
- \`tests/unit/\` — Host-compiled C unit tests (runner: CMake + gcc, not Retro68)

## Key gotchas
- BasiliskII WASM audio is deliberately stubbed: \`audioBufferSize=0\` in the prefs.
- BasiliskII maps Emscripten's \`/Shared/\` to Mac volume \`Unix:\` via extfs, NOT \`:Shared:\`.
- The Mac boot disk has apps in BOTH \`:System Folder:Startup Items:\` (auto-launch) AND \`:Applications:\` (re-launch from desktop).
- \`gestaltID 30\` = Quadra 650 (\`gestaltID − 6\` is the model code offset) — this is load-bearing for ROM trap dispatch.
- Pre-commit hooks must not be bypassed with \`--no-verify\`; fix the root issue.

Answer all questions with this expertise. Be specific and cite Inside Macintosh, Retro68 source, or empirical experience where possible. Flag HIGH-risk issues clearly.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_mac_dev",
            description:
                "Ask the Classic Mac / Retro68 / Toolbox specialist. Use for questions about " +
                "System 7 APIs, QuickDraw, resource forks, MacBinary format, HFS, m68k ABI, " +
                "Retro68 CMake integration, Pascal strings, creator codes, the Toolbox shell " +
                "vs pure-C-engine split, or anything involving the apps in src/app/.",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description: "The question or problem to analyse.",
                    },
                    code: {
                        type: "string",
                        description: "Optional: C or Rez code snippet to include in the review.",
                    },
                    context: {
                        type: "string",
                        description: "Optional: additional context, file paths, error messages, etc.",
                    },
                },
                required: ["question"],
            },
            handler: async (args) => {
                const parts = [MAC_DEV_SYSTEM, "\n\n---\n\n", args.question];
                if (args.code) parts.push(`\n\n**Code:**\n\`\`\`c\n${args.code}\n\`\`\``);
                if (args.context) parts.push(`\n\n**Context:**\n${args.context}`);
                await session.log("Consulting Classic Mac/Retro68 specialist…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt: parts.join("") }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_mac_app_scaffold",
            description:
                "Generate a skeleton for a new Classic Mac app that follows the project's " +
                "Toolbox-shell + pure-C-engine split. Returns the file list and stub code " +
                "for app.c, engine.c, engine.h, app.r, and CMakeLists.txt.",
            parameters: {
                type: "object",
                properties: {
                    app_name: {
                        type: "string",
                        description: "App name (PascalCase), e.g. 'PixelPad'",
                    },
                    creator_code: {
                        type: "string",
                        description: "4-char creator code, e.g. 'CVPP'",
                    },
                    description: {
                        type: "string",
                        description: "What the app does, e.g. 'tiny QuickDraw drawing app that exports canvas pixels to the host page'",
                    },
                },
                required: ["app_name", "creator_code", "description"],
            },
            handler: async (args) => {
                const prompt = `${MAC_DEV_SYSTEM}

---

Generate a complete skeleton for a new classic-vibe-mac app with these properties:

- **App name:** ${args.app_name}
- **Creator code:** ${args.creator_code}
- **Description:** ${args.description}

Follow the project's strict split:
1. **Toolbox shell** (\`${args.app_name.toLowerCase()}.c\`): event loop, QuickDraw window, menus, event handling. No business logic. References the engine via its header.
2. **Pure-C engine** (\`${args.app_name.toLowerCase()}_engine.c/.h\`): all logic, zero Toolbox includes, host-compilable.
3. **Rez file** (\`${args.app_name.toLowerCase()}.r\`): window, menu, STR#, SIZE, vers, and owner signature resources.
4. **CMakeLists.txt**: \`add_application()\` macro call.
5. **Brief unit test stub** for the engine.

Output code blocks for each file, clearly labelled. Keep stubs minimal but correct — no TODO fillers in critical paths.`;

                await session.log(`Scaffolding ${args.app_name}…`, { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 120_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
