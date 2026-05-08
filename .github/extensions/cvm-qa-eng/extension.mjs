// Extension: cvm-qa-eng
// QA and testing specialist for classic-vibe-mac.
// Generates test cases, reviews coverage gaps, and knows the three-layer test stack:
// unit (C + JS), E2E Playwright, and visual AI assertions.

import { joinSession } from "@github/copilot-sdk/extension";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

const QA_SYSTEM = `You are the QA engineer for classic-vibe-mac, specialising in its three-layer test architecture.

## Test stack

### Layer 1: Unit tests (fast, sub-second)
**Location:** \`tests/unit/\`
**Runner:** CMake + gcc for C; Node.js directly for JS. Invoked via \`npm run test:unit\`.

**C unit tests** (\`tests/unit/test_html_parse.c\`, \`tests/unit/test_weather_parse.c\`):
- Test the pure-C engines only — no Toolbox, no emulator.
- Each test is a \`check_*\` function calling \`assert()\` or custom assert helpers.
- Must compile with the host \`gcc\` (not Retro68) — no Toolbox includes allowed in the engine.
- New test functions just need to be added to \`tests/unit/\` — CMakeLists picks them up.

**JS unit tests** (\`tests/unit/preprocessor.test.mjs\`, \`tests/unit/hfs-patcher.test.mjs\`):
- Pure Node.js ESM test scripts. No test framework — use \`assert\` from \`node:assert/strict\`.
- Output: TAP-like lines (\`ok N description\`, \`not ok N description\`). 
- hfs-patcher tests use \`hcopy\` / \`hmount\` CLI tools (require hfsutils to be installed).
- New test files: add to package.json's \`test:unit:js\` script.

### Layer 2: E2E tests (Playwright)
**Location:** \`tests/e2e/\`
**Runner:** \`npm run test:e2e\` — starts Vite dev server, runs Playwright.
**Scope:** Full browser flow — Mac boots, editor loads, Build & Run cycle, disk hot-load.
**Key hook:** \`window.__cvm_playground\` exposes \`getDoc()\`, \`getCurrent()\`, \`insertAtStart(text)\` for test control without DOM brittle-ness.

### Layer 3: Visual tests (AI vision)
**Location:** \`tests/visual/\`
**Runner:** \`npm run test:visual\` — Playwright screenshots + Claude API vision assertions.
**Gate:** Requires \`ANTHROPIC_API_KEY\`. Runs only in CI with the key set.
**Scope:** Semantic checks on the Mac canvas ("does the window show weather data?") — replaces pixel-diff brittleness.

## The Toolbox-shell split means:
- Toolbox shell (\`<app>.c\`) is NOT unit-testable on the host — only E2E/visual can cover it.
- Pure-C engine (\`<app>_engine.c/h\`) IS unit-testable — test all branches here first.
- JS playground modules (preprocessor, hfs-patcher, build, rez) are unit-testable in Node.js.

## Coverage gaps to watch
- Edge cases in the resource fork merge (overlapping type+ID, zero-resource forks, corrupt input)
- Preprocessor edge cases (#elif chains, nested #ifdef, circular includes)
- HFS patcher with edge-case MacBinary sizes (0-byte data fork, oversized resource fork)
- Error path in rez.ts (invalid Rez syntax, WASM OOM)
- IDB fallback path (when IndexedDB is unavailable)

Answer as a QA engineer. Flag missing test coverage as HIGH if it covers a path that runs in production. Be specific about test structure, file names, and Node.js assert patterns.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_qa_cases",
            description:
                "Generate concrete test cases for a feature or module. Returns ready-to-paste " +
                "test code following the project's test conventions (C assert-style or Node.js " +
                "ESM with node:assert/strict). Specify the layer: unit-c, unit-js, e2e, or visual.",
            parameters: {
                type: "object",
                properties: {
                    feature: {
                        type: "string",
                        description: "The feature or module to generate tests for.",
                    },
                    layer: {
                        type: "string",
                        enum: ["unit-c", "unit-js", "e2e", "visual", "all"],
                        description: "Which test layer to target. 'all' generates for the appropriate layers.",
                    },
                    code: {
                        type: "string",
                        description: "Optional: the implementation code to generate tests against.",
                    },
                    focus: {
                        type: "string",
                        description: "Optional: specific edge cases or scenarios to emphasise.",
                    },
                },
                required: ["feature"],
            },
            handler: async (args) => {
                const prompt = `${QA_SYSTEM}

---

Generate test cases for: **${args.feature}**
Test layer: **${args.layer ?? "appropriate"}**
${args.focus ? `Focus: ${args.focus}\n` : ""}
${args.code ? `Implementation to test:\n\`\`\`\n${args.code}\n\`\`\`\n` : ""}
Generate complete, runnable test code following the project conventions. Include:
- Happy path
- Edge cases (especially empty inputs, boundary values, corrupted data)
- Error paths (exceptions, out-of-range, missing resources)
- Any case that could silently produce wrong output

For unit-js: use \`import assert from 'node:assert/strict'\`. Output TAP-style \`console.log('ok N ...')\`.
For unit-c: use the existing assert pattern from the test files.
For e2e: use \`window.__cvm_playground\` hooks where possible.`;

                await session.log("Generating test cases…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_qa_review",
            description:
                "Review a code change or feature for test coverage gaps. Returns a list of " +
                "untested paths, missing edge cases, and suggested test additions.",
            parameters: {
                type: "object",
                properties: {
                    code: {
                        type: "string",
                        description: "The code (implementation and/or existing tests) to review.",
                    },
                    feature_description: {
                        type: "string",
                        description: "What the code is supposed to do.",
                    },
                },
                required: ["code"],
            },
            handler: async (args) => {
                const prompt = `${QA_SYSTEM}

---

Review this code change for test coverage gaps:
${args.feature_description ? `**Feature:** ${args.feature_description}\n` : ""}
\`\`\`
${args.code}
\`\`\`

List:
1. Every code path that is NOT covered by existing tests
2. Edge cases that are missing (empty inputs, corrupt data, boundary values, concurrent calls)
3. Error paths that aren't exercised
4. The minimum set of new tests that would reach reasonable coverage

Severity: HIGH (production path, no tests) / MEDIUM (edge case, no tests) / LOW (redundant but useful).`;

                await session.log("Reviewing test coverage…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_run_tests",
            description: "Run the project unit tests (C + JS) and return results. Fast — sub-second.",
            parameters: {
                type: "object",
                properties: {
                    suite: {
                        type: "string",
                        enum: ["all", "c", "js"],
                        description: "Which suite: all (default), c (C engine only), js (JS unit tests only).",
                    },
                },
            },
            handler: async (args) => {
                const script = args.suite === "c" ? "npm run test:unit:c"
                    : args.suite === "js" ? "npm run test:unit:js"
                    : "npm run test:unit";
                await session.log(`Running: ${script}`, { ephemeral: true });
                try {
                    const { stdout, stderr } = await execP(script, { cwd: REPO_ROOT, timeout: 120_000 });
                    return (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
                } catch (err) {
                    return `ERROR (exit ${err.code ?? "?"})\n${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
                }
            },
        },
    ],
});
