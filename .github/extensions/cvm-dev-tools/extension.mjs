// Extension: cvm-dev-tools
// Developer toolbelt for classic-vibe-mac: run tests, search LEARNINGS.md,
// look up issues, and inspect the playground build pipeline.

import { joinSession } from "@github/copilot-sdk/extension";
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const execP = promisify(exec);
const execFileP = promisify(execFile);

// Resolve the repo root relative to this file's location
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

async function runCommand(cmd, cwd = REPO_ROOT) {
    try {
        const { stdout, stderr } = await execP(cmd, { cwd, timeout: 120_000 });
        return (stdout + (stderr ? `\nSTDERR:\n${stderr}` : "")).trim();
    } catch (err) {
        return `ERROR (exit ${err.code ?? "?"})\n${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim();
    }
}

const session = await joinSession({
    tools: [
        {
            name: "cvm_run_unit_tests",
            description:
                "Run the classic-vibe-mac unit tests (C engine tests + JS playground tests). " +
                "This is the fast sub-second dev loop — no browser or emulator needed. " +
                "Use this after editing pure-C engine code or playground JS logic.",
            parameters: {
                type: "object",
                properties: {
                    suite: {
                        type: "string",
                        enum: ["all", "c", "js"],
                        description: "Which suite to run: 'all' (default), 'c' (C engine only), or 'js' (JS preprocessor + HFS patcher only).",
                    },
                },
            },
            handler: async (args) => {
                const suite = args.suite ?? "all";
                const script =
                    suite === "c" ? "npm run test:unit:c" :
                    suite === "js" ? "npm run test:unit:js" :
                    "npm run test:unit";
                await session.log(`Running: ${script}`, { ephemeral: true });
                const result = await runCommand(script);
                return result;
            },
        },

        {
            name: "cvm_build_web",
            description:
                "Run the Vite production build for the classic-vibe-mac web layer (src/web). " +
                "Use this to check for TypeScript errors and ensure the playground bundles correctly. " +
                "Typical build time: 10–30 seconds.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                await session.log("Running: npm run build", { ephemeral: true });
                const result = await runCommand("npm run build");
                return result;
            },
        },

        {
            name: "cvm_search_learnings",
            description:
                "Search LEARNINGS.md for entries matching a keyword or topic. " +
                "LEARNINGS.md is the project's running gotcha log — hit this before " +
                "debugging any non-obvious issue (Retro68 quirks, WASM init, HFS tools, " +
                "CORS/SAB/COOP issues, System 7 API gotchas).",
            parameters: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Keyword or topic to search for, e.g. 'audio', 'COEP', 'Controls.h', 'hfsutils'.",
                    },
                },
                required: ["query"],
            },
            skipPermission: true,
            handler: async (args) => {
                const filePath = resolve(REPO_ROOT, "LEARNINGS.md");
                let content;
                try {
                    content = await readFile(filePath, "utf8");
                } catch {
                    return "Could not read LEARNINGS.md";
                }

                const query = args.query.toLowerCase();
                const sections = content.split(/^### /m);
                const matches = sections.filter((s) => s.toLowerCase().includes(query));

                if (matches.length === 0) {
                    return `No entries in LEARNINGS.md matching "${args.query}".`;
                }

                return `Found ${matches.length} matching section(s) in LEARNINGS.md:\n\n` +
                    matches.map((s) => "### " + s.trim()).join("\n\n---\n\n");
            },
        },

        {
            name: "cvm_list_issues",
            description:
                "List all open GitHub issues for classic-vibe-mac, grouped by theme. " +
                "Use this to get a quick overview of what's open before planning work.",
            parameters: { type: "object", properties: {} },
            skipPermission: true,
            handler: async () => {
                const result = await runCommand(
                    "gh issue list --repo khawkins98/classic-vibe-mac --state open --json number,title,labels --limit 50"
                );
                try {
                    const issues = JSON.parse(result);
                    const lines = issues.map((i) => {
                        const labels = (i.labels ?? []).map((l) => l.name).join(", ");
                        return `#${i.number}: ${i.title}${labels ? ` [${labels}]` : ""}`;
                    });
                    return `Open issues (${lines.length}):\n\n` + lines.join("\n");
                } catch {
                    return result;
                }
            },
        },

        {
            name: "cvm_get_issue",
            description:
                "Fetch the full body and comments of a specific GitHub issue. " +
                "Use this before starting work on an issue to understand scope, " +
                "acceptance criteria, and prior discussion.",
            parameters: {
                type: "object",
                properties: {
                    number: {
                        type: "integer",
                        description: "The issue number, e.g. 45",
                    },
                },
                required: ["number"],
            },
            skipPermission: true,
            handler: async (args) => {
                const result = await runCommand(
                    `gh issue view ${args.number} --repo khawkins98/classic-vibe-mac --comments`
                );
                return result;
            },
        },

        {
            name: "cvm_check_ci_status",
            description:
                "Check the status of recent CI workflow runs (Build + Test) on main. " +
                "Use this to confirm a push succeeded or to diagnose a failing deploy.",
            parameters: { type: "object", properties: {} },
            handler: async () => {
                const result = await runCommand(
                    "gh run list --repo khawkins98/classic-vibe-mac --branch main --limit 5 --json status,conclusion,displayTitle,createdAt,workflowName"
                );
                try {
                    const runs = JSON.parse(result);
                    return runs.map((r) =>
                        `[${r.workflowName}] ${r.displayTitle} — ${r.status}/${r.conclusion ?? "in progress"} (${r.createdAt})`
                    ).join("\n");
                } catch {
                    return result;
                }
            },
        },
    ],
});

