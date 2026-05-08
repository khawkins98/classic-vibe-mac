// Extension: cvm-epic-reviewer
// Runs the classic-vibe-mac five-reviewer red-flag pass for a proposed Epic.
// Dispatches five sub-agents in parallel, each with a different review lens,
// then consolidates HIGH/MEDIUM/LOW findings into a go/no-go/scope-down verdict.
// See docs/AGENT-PROCESS.md for the process rationale.

import { joinSession } from "@github/copilot-sdk/extension";

// The review lenses defined in AGENT-PROCESS.md
const ALL_LENSES = {
    "domain-expert": {
        label: "Domain Expert",
        focus: "Wrong-by-an-OSI-layer architectural mistakes. The 'this won't work for reasons specific to the field' finding.",
        prompt: (epic) =>
            `You are a Classic Mac / WebAssembly / browser-platform domain expert reviewing a proposed feature for a project that runs System 7.5.5 in the browser via BasiliskII WASM. The project constraint is: everything runs in the visitor's browser — no backend, no relay, no auth, no compile service. 

PROPOSED EPIC:
${epic}

Review this proposal for domain-specific correctness issues. Look for:
- Wrong-by-an-OSI-layer architectural mistakes (e.g., claiming TCP/IP inside the Mac emulator is feasible)  
- Misunderstandings of how BasiliskII WASM, Retro68, HFS, or System 7 actually work
- Claims about feasibility that are wrong given how these systems behave
- Missing domain knowledge that would change the implementation approach

Write a severity-ranked finding list with findings marked HIGH / MEDIUM / LOW. HIGH = show-stopper, MEDIUM = significant scope impact, LOW = worth noting. Be terse. Under 400 words.`,
    },

    "scope-pm": {
        label: "Scope / PM",
        focus: "'This is bigger than you think.' Honest re-estimates, flags when an Epic displaces higher-leverage work.",
        prompt: (epic) =>
            `You are an experienced PM / scope estimator reviewing a proposed feature for classic-vibe-mac. The project has a single maintainer (Kevin) working with AI agents. Key context: Phases 1+2+3 of the playground shipped in roughly one afternoon of focused agent work when the scope was right. 

Open issues by priority theme:
- UX quick wins: #45 (IDE two-pane), #46 (Build & Run UX modal), #25 (side-by-side layout)
- New demo apps: #17 (Pixel Pad), #9 (Markdown viewer) 
- Playground v1.2: #22 (file tree+tabs), #23 (Rez syntax), #24 (3-way diff)
- Technical debt: #48 (color), #47 (audio), #44 (boot disk diet)

PROPOSED EPIC:
${epic}

Review for scope creep and prioritization issues:
- Is the estimate honest? What's the realistic range?
- Does this Epic displace higher-leverage open issues?
- Are there hidden dependencies or prerequisite work not called out?
- What's the MVP that delivers 70% of the value at 5-10% of the effort?

Severity-ranked findings (HIGH / MEDIUM / LOW). Under 350 words.`,
    },

    "security-abuse": {
        label: "Security / Abuse",
        focus: "DoS surfaces, spam-relay risks, OAuth scope creep, secret-handling mistakes, anything that would shut a free-tier account down.",
        prompt: (epic) =>
            `You are a security and abuse reviewer for classic-vibe-mac, a fully static GitHub Pages site. Hard constraints: no backend, no auth, no compile service. Violations of these constraints in past Epics led to them being closed.

PROPOSED EPIC:
${epic}

Review for security and abuse risks:
- Does this introduce any server-side component (even "just a small relay")?
- Does it create DoS surfaces on GitHub Pages or the project's free-tier dependencies?
- Does it touch OAuth, tokens, or user credentials in any way?
- Does it open a spam-relay vector (e.g., proxying arbitrary URLs via the page)?
- Does it create any privacy concerns (user data leaving the browser unexpectedly)?
- Does it risk violating GitHub Pages ToS or any third-party service ToS?

Severity-ranked findings (HIGH / MEDIUM / LOW). Under 300 words.`,
    },

    "infra-feasibility": {
        label: "Infrastructure Feasibility",
        focus: "Compute budget, free-tier ceilings, ToS clauses, dependency licensing, runtime feasibility on target.",
        prompt: (epic) =>
            `You are an infrastructure feasibility reviewer for classic-vibe-mac. The project deploys to GitHub Pages (static files only, no serverless, no edge functions). The browser runtime is the only compute target. Dependencies: BasiliskII WASM from Infinite Mac CDN, Retro68 Docker image for CI cross-compilation, WASM-Rez (vendored in tools/wasm-rez/), Vite + TypeScript, CodeMirror 6, Playwright for tests.

PROPOSED EPIC:
${epic}

Review for infrastructure feasibility:
- Can this actually run entirely in the visitor's browser tab? What's the compute/memory cost?
- Does this require any new external service dependency? What are its ToS / reliability / free-tier limits?
- Are there WASM bundle size implications (current gzipped budget: ~103KB for Rez)?
- Does this require new CI capabilities beyond the current Docker + GitHub Actions setup?
- Are there cross-browser compatibility landmines (SharedArrayBuffer, OPFS, WASM threads, etc.)?
- Does any new dependency have a license incompatible with MIT (our license)?

Severity-ranked findings (HIGH / MEDIUM / LOW). Under 350 words.`,
    },

    "ux-editor": {
        label: "Editor / UX",
        focus: "Honest sizing for editor work, accessibility, keyboard handling, mobile, and first-timer comprehension.",
        prompt: (epic) =>
            `You are a UX and editor specialist reviewing a proposed feature for classic-vibe-mac. The current editor is CodeMirror 6 with C syntax highlighting, single-file editing, IndexedDB persistence, and Build & Run. Mobile shows 'open on desktop'. The page has a styled System 7 chrome with specific CSS conventions.

PROPOSED EPIC:
${epic}

Review for UX/editor quality and sizing:
- Is the UX scope honestly sized? (Prior epic over-estimated by 5x on Rez syntax highlighting — it's 400-800 lines of Lezer grammar, not 50)
- What keyboard/accessibility work is implicit in this design?
- What does the first-timer experience look like? Is it confusing without a tutorial?
- Are there mobile implications?
- Does this break the existing CodeMirror 6 editor setup in non-obvious ways?
- Is the proposed UI coherent with the System 7 styling of the existing page?

Severity-ranked findings (HIGH / MEDIUM / LOW). Under 350 words.`,
    },
};

// Pick 5 lenses — use all 5 from above by default
const DEFAULT_LENSES = ["domain-expert", "scope-pm", "security-abuse", "infra-feasibility", "ux-editor"];

const session = await joinSession({
    tools: [
        {
            name: "cvm_run_epic_review",
            description:
                "Run the classic-vibe-mac five-reviewer red-flag pass on a proposed Epic. " +
                "Dispatches five parallel sub-agent reviewers (domain expert, scope/PM, " +
                "security/abuse, infra feasibility, UX/editor), each writing a " +
                "severity-ranked finding list. Returns a consolidated report with a " +
                "go / no-go / scope-down recommendation. " +
                "See docs/AGENT-PROCESS.md for the process rationale.",
            parameters: {
                type: "object",
                properties: {
                    epic_description: {
                        type: "string",
                        description:
                            "Full description of the proposed Epic: what it does, why it's valuable, " +
                            "rough implementation approach, and any known tradeoffs. The more detail, " +
                            "the more useful the review.",
                    },
                    lenses: {
                        type: "array",
                        items: {
                            type: "string",
                            enum: Object.keys(ALL_LENSES),
                        },
                        description:
                            "Which reviewer lenses to use. Defaults to all five: " +
                            Object.keys(ALL_LENSES).join(", ") + ". " +
                            "Omit to use all five (recommended).",
                    },
                },
                required: ["epic_description"],
            },
            handler: async (args) => {
                const epic = args.epic_description;
                const lensKeys = args.lenses ?? DEFAULT_LENSES;

                await session.log(
                    `Running five-reviewer epic pass with lenses: ${lensKeys.join(", ")}`,
                    { ephemeral: true }
                );

                // Dispatch all reviewer agents in parallel
                const reviewPromises = lensKeys.map(async (lensKey) => {
                    const lens = ALL_LENSES[lensKey];
                    if (!lens) return `[${lensKey}] Unknown lens — skipped.`;

                    try {
                        const response = await session.sendAndWait(
                            { prompt: lens.prompt(epic) },
                            90_000
                        );
                        const content = response?.data?.content ?? "(no response)";
                        return `## ${lens.label} Review\n\n${content}`;
                    } catch (err) {
                        return `## ${lens.label} Review\n\nERROR: ${err.message}`;
                    }
                });

                const reviews = await Promise.all(reviewPromises);

                // Build consolidated report
                const separator = "\n\n---\n\n";
                const reviewsText = reviews.join(separator);

                const consolidationPrompt = `You are the orchestrator for the classic-vibe-mac five-reviewer epic process. 
You have received ${lensKeys.length} independent reviewer reports below. 

Your job:
1. Identify HIGH findings that appear across multiple reviewers — these are show-stoppers.
2. Identify MEDIUM findings that converge — these become scope-down requirements.
3. Identify any single-reviewer HIGH findings that are uniquely compelling.
4. Produce a verdict: GO (ship as-is) / SCOPE-DOWN (ship with listed changes) / NO-GO (kill it, with reasons).
5. If SCOPE-DOWN, list the minimum required changes before proceeding.

Be blunt. Be brief. Under 500 words for the consolidation.

---

${reviewsText}`;

                await session.log("Consolidating reviewer findings…", { ephemeral: true });

                let consolidation;
                try {
                    const resp = await session.sendAndWait({ prompt: consolidationPrompt }, 90_000);
                    consolidation = resp?.data?.content ?? "(consolidation failed)";
                } catch (err) {
                    consolidation = `Consolidation failed: ${err.message}`;
                }

                return (
                    `# Epic Review Report\n\n` +
                    `**Epic:** ${epic.slice(0, 120)}${epic.length > 120 ? "…" : ""}\n\n` +
                    `**Lenses used:** ${lensKeys.map((k) => ALL_LENSES[k]?.label ?? k).join(", ")}\n\n` +
                    `---\n\n` +
                    reviewsText +
                    `\n\n---\n\n` +
                    `# Consolidated Verdict\n\n` +
                    consolidation
                );
            },
        },
    ],
});

