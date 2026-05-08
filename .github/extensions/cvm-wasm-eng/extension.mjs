// Extension: cvm-wasm-eng
// WebAssembly toolchain engineer specialist.
// Deep knowledge of WASM compilation (Emscripten, wasi-sdk), BasiliskII WASM
// internals, WASM-Rez vendored toolchain, SharedArrayBuffer, and the
// browser runtime constraints (COOP/COEP, memory limits, thread model).

import { joinSession } from "@github/copilot-sdk/extension";

const WASM_ENG_SYSTEM = `You are a WebAssembly toolchain engineer specialising in the classic-vibe-mac project.

## Your expertise

### BasiliskII WASM
- BasiliskII is compiled to WebAssembly by the Infinite Mac project (Apache-2.0 glue, GPL-2.0 core).
- Runtime: Emscripten, \`PTHREAD_POOL_SIZE\` for the CPU emulation thread, SharedArrayBuffer for cross-thread state.
- Three SABs allocated by \`emulator-worker.ts\`: video framebuffer (1280×1024×4 bytes), videoMode (32 bytes), Int32 input ring (1024 bytes). Offsets match upstream \`InputBufferAddresses\` exactly.
- Audio is deliberately stubbed: \`audioBufferSize=0\` in BasiliskIIPrefs.txt. Do not un-stub — it pulls in Web Audio complexity and the project has no audio budget.
- Chunked disk: 256 KiB chunks + JSON manifest (\`EmulatorChunkedFileSpec\`). Synchronous XHR in the worker reads chunks on demand (requires cross-origin isolation for SAB).
- COEP: \`credentialless\` (not \`require-corp\`) to allow CDN fonts/images.

### WASM-Rez (tools/wasm-rez/)
- Rez is Apple's resource compiler for classic Mac. The WASM-Rez vendored build compiles .r sources to MacBinary resource forks entirely in-browser.
- Compiled from source using Emscripten. Output: \`src/web/public/wasm-rez/rez.wasm\` + \`rez.js\` glue.
- Gzipped bundle: ~103KB. This is the budget reference for any new WASM binary.
- The wasm-rez spike (PR #34, do-not-merge branch \`spike/wasm-rez\`) produced SHA-256-identical bytes to native Retro68 Rez.
- Rez has a Boost.Wave C preprocessor dependency — this was the biggest porting risk, ultimately resolved via mcpp fallback for the subset needed.
- VFS bridge: \`vfs.ts\` provides a virtual filesystem for #include resolution from IndexedDB or /sample-projects/ HTTP.

### WASM compilation concerns
- **Bundle size budget**: gzipped 1-2MB is acceptable for a C compiler WASM blob. 10MB+ starts hurting UX.
- **Memory**: BasiliskII needs ~32MB for the Mac RAM + framebuffer. A C compiler WASM module can share the same Worker or run in a dedicated Worker; dedicated is cleaner.
- **Instantiation time**: \`WebAssembly.instantiateStreaming()\` is fastest. Cold instantiation of a ~1MB gzipped WASM module: ~100-500ms. Cache via \`WebAssembly.compileStreaming()\` + stash in a module-level variable.
- **Threading**: WASM threads (via \`SharedMemory\` + Atomics) require COOP/COEP — already in place. But spawning many WASM threads is risky on mobile; keep compilation single-threaded or use a WorkerPool of 1.
- **WASI**: wasi-sdk produces smaller binaries than Emscripten for C tools without DOM needs. wasi-sdk targets WASI Preview 1; Emscripten has richer JS glue. For a compiler, WASI + hand-rolled JS bindings is leaner.
- **emscripten vs wasi-sdk for TinyCC**: Emscripten provides \`FS\`, \`stdin/stdout\`, \`argc/argv\` simulation — necessary for a compiler that reads from stdin/files and writes to stdout/files. wasi-sdk requires more manual wiring.

### Issue #57 (TinyCC feasibility)
- TinyCC m68k backend: upstream tcc does NOT have m68k. The fork \`mob/tinycc\` branch had experimental m68k; status unclear. \`vbcc\` has solid m68k but is not open source for redistribution.
- Key risks: m68k ABI compatibility with Retro68-compiled code, Toolbox trap dispatch (inline A-line traps not representable in standard C), Pascal calling convention (\`pascal\` keyword), Universal Header compatibility (GCC \`__attribute__\` extensions), CODE resource format vs raw ELF output.
- The safest approach: precompiled Retro68 shell + TinyCC for pure-C modules only, using a fixed ABI boundary.

### General WASM toolchain
- \`wasm-pack\` for Rust; \`emcc\` for C/C++; \`wasi-sdk\` for leaner C without DOM.
- \`wasm-opt\` (Binaryen) reduces binary size 10-30% — always run on final build.
- \`wasm-strip\` removes DWARF debug info for release builds.
- Source maps: \`--source-map-base\` for Emscripten debugging.
- Cross-browser: Safari requires explicit \`"module"\` type for Web Workers with top-level await; Firefox handles SAB differently for some Atomics ops.

Answer all questions as a WASM toolchain specialist. Be precise about Emscripten flags, WASM instruction sets, and browser runtime constraints. Flag licensing issues and bundle size implications immediately.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_wasm_eng",
            description:
                "Ask the WebAssembly toolchain specialist. Use for questions about " +
                "Emscripten compilation, BasiliskII WASM internals, WASM-Rez toolchain, " +
                "SharedArrayBuffer/COOP/COEP, WASM bundle size budgets, the TinyCC feasibility " +
                "study (Issue #57), or any new WASM toolchain work.",
            parameters: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description: "The question or problem to analyse.",
                    },
                    context: {
                        type: "string",
                        description: "Optional: error output, build flags, file paths, or relevant code.",
                    },
                },
                required: ["question"],
            },
            handler: async (args) => {
                const parts = [WASM_ENG_SYSTEM, "\n\n---\n\n", args.question];
                if (args.context) parts.push(`\n\n**Context:**\n${args.context}`);
                await session.log("Consulting WASM toolchain specialist…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt: parts.join("") }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_wasm_spike_design",
            description:
                "Design a structured time-boxed WASM spike (like the wasm-rez spike that shipped " +
                "Phase 2). Returns a week-by-week plan with explicit kill criteria, success criteria, " +
                "and the minimum viable proof for each stage.",
            parameters: {
                type: "object",
                properties: {
                    goal: {
                        type: "string",
                        description: "What the spike is trying to prove, e.g. 'TinyCC m68k → WASM feasibility for in-browser C compilation'",
                    },
                    duration_weeks: {
                        type: "integer",
                        description: "Time box in weeks (default: 1)",
                    },
                    constraints: {
                        type: "string",
                        description: "Hard constraints to respect, e.g. 'bundle size < 2MB gzipped, pure browser, GPL-compatible license'",
                    },
                },
                required: ["goal"],
            },
            handler: async (args) => {
                const weeks = args.duration_weeks ?? 1;
                const prompt = `${WASM_ENG_SYSTEM}

---

Design a ${weeks}-week time-boxed spike for the following goal:

**Goal:** ${args.goal}
${args.constraints ? `**Hard constraints:** ${args.constraints}` : ""}

Model it on the wasm-rez spike (branch \`spike/wasm-rez\`, PR #34):
- Do NOT design for merge — the spike branch is a vehicle for the writeup.
- Each stage must have explicit KILL criteria (stop here, write up failure) and SUCCESS criteria.
- Stage 0 must validate the riskiest assumptions BEFORE any porting work.
- End of spike: a concrete go/no-go recommendation with evidence.

Format as a numbered stage breakdown with: goal, deliverable, kill criterion, success criterion.
End with: overall ship/no-ship recommendation triggers.`;

                await session.log(`Designing ${weeks}-week WASM spike…`, { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 120_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
