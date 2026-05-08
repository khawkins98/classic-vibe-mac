// Extension: cvm-tech-writer
// Technical writing specialist for classic-vibe-mac.
// Maintains LEARNINGS.md, ARCHITECTURE.md, PLAYGROUND.md, PRD.md, DEVELOPMENT.md.
// Knows the project's doc conventions and can draft, review, or update any doc.

import { joinSession } from "@github/copilot-sdk/extension";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

const WRITER_SYSTEM = `You are the technical writer for classic-vibe-mac. You maintain its documentation with accuracy, conciseness, and period-appropriate personality.

## Documentation landscape
- **LEARNINGS.md** — running gotcha log. Entries follow this format:
  \`\`\`
  ### YYYY-MM-DD — Short title (≤60 chars)
  **Context:** what we were trying to do
  **Finding:** what we learned
  **Action:** what we did about it (or chose not to)
  \`\`\`
  Keep entries ≤200 words. Link to commits, PRs, or issues for depth. Record negative results.
  
- **ARCHITECTURE.md** — definitive byte-by-byte system description. Audience: contributors who need to modify the emulator, disk pipeline, or playground. Long-form, highly detailed.
  
- **PLAYGROUND.md** — design rationale and rolling status of the playground (Epic #21). Covers the five-reviewer review history, option 2F choice, what shipped, closed epics, and spike process.
  
- **PRD.md** — product intent, open epics, closed-epic graveyard. Source of truth for what to build next.
  
- **DEVELOPMENT.md** — local dev setup, prerequisites, how to run tests, how to add an app, contribution guide.
  
- **AGENT-PROCESS.md** — five-reviewer process, sub-agent dispatch rules, commit hygiene.

- **src/app/README.md** — per-app architecture, Toolbox shell + engine split, add-your-own-app guide.

## Writing conventions
- Plain markdown, no frontmatter.
- Headings: \`##\` for sections, \`###\` for subsections — no \`####\` or deeper except in long docs.
- Code blocks: always fenced with language tag (\`\`\`c, \`\`\`typescript, \`\`\`bash, etc.).
- Em-dashes: \` — \` (space both sides).
- First person plural: "we", "our" — not "the project".
- No buzzwords. No "leverage", "ecosystem", "delightful" unless in quoted user research.
- Issue references: \`#NN\` inline, full URL only in LEARNINGS.md or changelogs.
- Dates: \`YYYY-MM-DD\` format only.

## Tone
- Terse and precise for ARCHITECTURE.md/AGENT-PROCESS.md.
- Slightly warmer for LEARNINGS.md (it's a shared journal).
- Enthusiastic but honest for PRD.md (the vision matters, but so do tradeoffs).`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_log_learning",
            description:
                "Draft (and optionally write) a new LEARNINGS.md entry. Use this whenever you " +
                "discover a gotcha, dead end, surprising behaviour, or decision worth remembering. " +
                "Pass write=true to append the entry to LEARNINGS.md immediately.",
            parameters: {
                type: "object",
                properties: {
                    finding: {
                        type: "string",
                        description: "What was discovered — the core fact.",
                    },
                    context: {
                        type: "string",
                        description: "What we were trying to do when this was discovered.",
                    },
                    action: {
                        type: "string",
                        description: "What was done about it (or why nothing was done).",
                    },
                    title: {
                        type: "string",
                        description: "Optional: short title (≤60 chars). Auto-generated if omitted.",
                    },
                    write: {
                        type: "boolean",
                        description: "If true, append the drafted entry to LEARNINGS.md. Default: false (draft only).",
                    },
                },
                required: ["finding", "context"],
            },
            handler: async (args) => {
                const today = new Date().toISOString().slice(0, 10);
                const draftPrompt = `${WRITER_SYSTEM}

---

Draft a LEARNINGS.md entry following the project format exactly.

**Date:** ${today}
**Context:** ${args.context}
**Finding:** ${args.finding}
**Action:** ${args.action ?? "(not yet determined)"}
${args.title ? `**Suggested title:** ${args.title}` : ""}

Output ONLY the markdown for the entry — starting with \`### ${today} — \`. Under 200 words. No preamble, no explanation.`;

                await session.log("Drafting LEARNINGS.md entry…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt: draftPrompt }, 60_000);
                const draft = resp?.data?.content ?? "(draft failed)";

                if (args.write) {
                    const filePath = resolve(REPO_ROOT, "LEARNINGS.md");
                    let existing = "";
                    try { existing = await readFile(filePath, "utf8"); } catch { /* new file */ }
                    // Insert after the "## Entries" heading (or at end)
                    const insertPoint = existing.indexOf("\n## Entries\n");
                    let updated;
                    if (insertPoint >= 0) {
                        const after = insertPoint + "\n## Entries\n".length;
                        updated = existing.slice(0, after) + "\n" + draft + "\n" + existing.slice(after);
                    } else {
                        updated = existing + "\n\n" + draft + "\n";
                    }
                    await writeFile(filePath, updated, "utf8");
                    return `Entry written to LEARNINGS.md:\n\n${draft}`;
                }

                return `Drafted entry (not yet written — pass write=true to persist):\n\n${draft}`;
            },
        },

        {
            name: "cvm_docs_review",
            description:
                "Review a block of documentation or a full doc file for accuracy, completeness, " +
                "adherence to project conventions, and reader clarity. Returns severity-ranked findings.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The documentation text to review (can be a diff, a full section, or a full file).",
                    },
                    doc_type: {
                        type: "string",
                        enum: ["LEARNINGS.md", "ARCHITECTURE.md", "PLAYGROUND.md", "PRD.md", "DEVELOPMENT.md", "AGENT-PROCESS.md", "README", "other"],
                        description: "Which document this belongs to — sets expectations for tone and depth.",
                    },
                    questions: {
                        type: "string",
                        description: "Optional: specific questions to answer about this doc (e.g. 'is the HFS description accurate?')",
                    },
                },
                required: ["text"],
            },
            handler: async (args) => {
                const prompt = `${WRITER_SYSTEM}

---

Review the following ${args.doc_type ? `\`${args.doc_type}\`` : "documentation"} text:

\`\`\`markdown
${args.text}
\`\`\`

${args.questions ? `Specific questions: ${args.questions}\n\n` : ""}Review for:
1. Factual accuracy (flag any technical claims that are likely wrong)
2. Completeness (what important detail is missing?)
3. Adherence to project writing conventions (format, tone, style)
4. Reader clarity (would a contributor who hasn't seen this before understand it?)
5. Outdated references (issue numbers, file paths, API names that may have changed)

Severity: HIGH (wrong or misleading) / MEDIUM (incomplete or inconsistent) / LOW (style). Under 400 words.`;

                await session.log("Running documentation review…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
