// Extension: cvm-planner
// PM / sprint-planner specialist for classic-vibe-mac.
// Creates implementation plans for issues, designs time-boxed spikes,
// and prioritises the open backlog given project constraints.

import { joinSession } from "@github/copilot-sdk/extension";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execP = promisify(exec);
const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

const PLANNER_SYSTEM = `You are the project planner and PM for classic-vibe-mac. You work with a single maintainer (Kevin) who uses AI sub-agents to implement tasks autonomously.

## Project constraints (load-bearing for every plan)
- **Everything runs in the visitor's browser**: no backend, no relay, no auth, no compile service.
- Epics #12 (TCP/IP relay) and #19 (full Retro68 WASM) were CLOSED for violating this constraint.
- Any plan that requires a server, OAuth token exchange, or persistent relay is a non-starter.

## Team model
- Solo maintainer + AI sub-agents.
- When scope is right, phases can ship in a single focused session ("one afternoon of agent work").
- Phases 1+2+3 of the playground (Epic #21) shipped this way.
- Scope creep is the #1 risk. The five-reviewer pass exists to catch it before implementation.

## Open issue themes (as of 2026-05-08)
- **UX layout:** #45 (IDE two-pane), #46 (Build & Run modal — gated on #45), #25 (side-by-side)
- **Playground v1.2:** #22 (file tree + tabs), #23 (Rez syntax highlight), #24 (3-way diff)
- **New apps:** #17 (Pixel Pad — Mac→JS data flow), #9 (Markdown viewer+editor)
- **Technical debt:** #48 (color), #47 (audio), #44 (boot disk diet)
- **Networking:** #15 (AppleTalk), #14 (Reader URL bar)
- **Docs:** #52 (first-commit recipe), #53 (troubleshooting surface), #54 (canonical status)
- **Meta / research:** #49 (arch review), #57 (in-browser C compile feasibility — TinyCC NO-GO per research)

## Estimation calibration
- "One afternoon of agent work" = 2-4 hours for a correctly-scoped change
- A Rez syntax highlighting grammar was estimated at "50 lines" in Epic #21 but is realistically 400-800 lines — estimate 5-10×
- Playground layout rework (#45) is 1-2 days of focused work
- New demo app (#17 Pixel Pad) is 3-5 days end-to-end

## Spike design rules (from AGENT-PROCESS.md)
- Spike branches: \`spike/<name>\`. PRs are do-not-merge, just a vehicle for the writeup.
- Every spike needs: explicit kill criteria, explicit success criteria, staged proof.
- Spike budget: 1 week max unless pre-approved.
- End of spike: go/no-go recommendation with evidence. No "it kind of works" ships.

## Five-reviewer pass
Required for any Epic before implementation. Lenses: domain-expert, scope/PM, security/abuse, infra-feasibility, UX/editor. Tool: \`cvm_run_epic_review\` from the cvm-epic-reviewer extension.

Answer as a PM who has been burned by scope creep before. Be honest about estimates. Flag dependencies between issues. Never recommend work that violates the pure-browser constraint.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_plan",
            description:
                "Create a concrete implementation plan for a GitHub issue or feature. " +
                "Returns a phase breakdown with: files to change, acceptance criteria, " +
                "test strategy, and risk flags. Includes a rough effort estimate.",
            parameters: {
                type: "object",
                properties: {
                    issue_or_feature: {
                        type: "string",
                        description: "Issue number (e.g. '#23') or free-form feature description.",
                    },
                    context: {
                        type: "string",
                        description: "Optional: additional context — current code state, constraints, prior attempts.",
                    },
                    depth: {
                        type: "string",
                        enum: ["sketch", "detailed"],
                        description: "Sketch = high-level phase plan (fast). Detailed = file-by-file breakdown with code suggestions.",
                    },
                },
                required: ["issue_or_feature"],
            },
            handler: async (args) => {
                const depth = args.depth ?? "detailed";
                const prompt = `${PLANNER_SYSTEM}

---

Create a ${depth} implementation plan for: **${args.issue_or_feature}**
${args.context ? `Context: ${args.context}\n` : ""}
The plan should include:
1. **Phases** (each independently shippable if possible)
2. **Files to change** with a sentence on what changes in each
3. **Acceptance criteria** — how do we know this is done?
4. **Test strategy** — what tests to add/run?
5. **Risk flags** — what could go wrong? What's the kill criterion?
6. **Effort estimate** — honest range (hours / days)
7. **Dependencies** — what must ship first?

${depth === "sketch" ? "Keep it concise — 200 words max." : "Be thorough. Include code stubs for critical pieces."}`;

                await session.log(`Planning: ${args.issue_or_feature}…`, { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 120_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_spike",
            description:
                "Design a time-boxed research spike following the project's spike process. " +
                "Returns a week plan with staged proof, kill criteria, and a ship/no-ship trigger. " +
                "Use this before committing to any high-risk technical investment.",
            parameters: {
                type: "object",
                properties: {
                    goal: {
                        type: "string",
                        description: "What the spike is trying to prove or disprove.",
                    },
                    duration_days: {
                        type: "integer",
                        description: "Time box in days (default: 5 = 1 week).",
                    },
                    known_risks: {
                        type: "string",
                        description: "Optional: known risks or concerns that motivated the spike.",
                    },
                },
                required: ["goal"],
            },
            handler: async (args) => {
                const days = args.duration_days ?? 5;
                const prompt = `${PLANNER_SYSTEM}

---

Design a ${days}-day time-boxed spike following the classic-vibe-mac spike process.

**Spike goal:** ${args.goal}
${args.known_risks ? `**Known risks:** ${args.known_risks}\n` : ""}
Model on the wasm-rez spike (branch \`spike/wasm-rez\`, PR #34 do-not-merge) — that spike:
- Validated the riskiest assumption first (Boost.Wave WASM compatibility)
- Had a clear pivot point at day 3 if Boost.Wave failed
- Ended with SHA-256-identical output to native Rez as the ship trigger

Format as:
- Day-by-day plan
- Kill criteria at each stage (stop if X)
- Minimum viable proof for ship
- Suggested branch name and PR writeup structure`;

                await session.log(`Designing ${days}-day spike…`, { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_prioritize",
            description:
                "Analyse the open backlog and recommend a priority order for the next sprint " +
                "given the project's constraint (pure browser), current state, and effort estimates.",
            parameters: {
                type: "object",
                properties: {
                    focus: {
                        type: "string",
                        description: "Optional: area to emphasise (e.g. 'UX wins', 'new demo app', 'technical debt', 'docs').",
                    },
                    exclude: {
                        type: "string",
                        description: "Optional: themes or issues to exclude from this sprint.",
                    },
                },
            },
            handler: async (args) => {
                // Fetch live issue list
                let issueList = "";
                try {
                    const { stdout } = await execP(
                        "gh issue list --repo khawkins98/classic-vibe-mac --state open --json number,title,labels --limit 50",
                        { cwd: REPO_ROOT, timeout: 15_000 }
                    );
                    const issues = JSON.parse(stdout);
                    issueList = issues.map((i) => {
                        const labels = (i.labels ?? []).map((l) => l.name).join(", ");
                        return `#${i.number}: ${i.title}${labels ? ` [${labels}]` : ""}`;
                    }).join("\n");
                } catch {
                    issueList = "(could not fetch live issues — using built-in context)";
                }

                const prompt = `${PLANNER_SYSTEM}

---

Recommend priority order for the next sprint.
${args.focus ? `Focus area: ${args.focus}\n` : ""}${args.exclude ? `Exclude: ${args.exclude}\n` : ""}

Current open issues:
${issueList}

Rank the top 5-7 issues to tackle. For each:
- Why it's ranked where it is
- Prerequisite dependencies
- Rough effort (hours / days)
- Risk

End with a "start here" recommendation — the single best first task and why.`;

                await session.log("Prioritising open backlog…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
