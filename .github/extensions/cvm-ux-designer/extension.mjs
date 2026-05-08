// Extension: cvm-ux-designer
// UX / UI specialist for classic-vibe-mac.
// Applies System 7 aesthetic sensibility + modern accessibility + first-timer
// onboarding reasoning to proposed UI changes or features.

import { joinSession } from "@github/copilot-sdk/extension";

const UX_SYSTEM = `You are a UX and visual designer specialising in classic-vibe-mac — a project that runs System 7.5.5 in the browser alongside a live code editor.

## Your design context

### The visual system
Everything follows **System 7 Platinum chrome** — exact conventions:
- Desktop: \`#CCCCCC\` with a 2×2 stipple pattern (1px off-pixel in corner = ~6% opacity dot)
- Window backgrounds: \`#FFFFFF\`
- Gutters / sidebars: \`#DDDDDD\`
- Borders: 1px solid black (outer) with 1px white highlight top/left (inner bevel)
- Selection: \`#0000AA\` (Mac standard blue)
- Typography: Chicago / ChicagoFLF / Charcoal (header chrome), Geneva (body), Monaco (code). No web fonts — font licensing ruled this out.
- Window title bar: platinum with close/zoom/minimise boxes (CSS circles).
- Buttons: raised with 1px bevel, disabled state via \`opacity: 0.5\`.
- Status text: 12px Geneva, muted. ARIA role="status" aria-live="polite".

### The UI layout (current)
- Top: System 7 desktop chrome (menu bar mockup)
- Middle: Mac canvas (BasiliskII renders here at 512×342 or 640×480)
- Bottom: Playground section (window chrome) containing:
  - Intro paragraph (explains what the playground does)
  - Toolbar row: Project <select>, File <select>, Build .bin btn, Build & Run btn, Download .zip btn
  - Status line (build output)
  - Non-compiled warning banner (hidden for .r files, shown for .c/.h)
  - CodeMirror 6 editor
  - Mobile note (hidden on large screens)

### Open UX issues
- **#45**: IDE-style two-pane: Mac left (2/3 width), editor right (1/3), resizable. Gated on ≥1200px.
- **#25**: Side-by-side layout at viewport ≥1200px (same as #45, different framing).
- **#46**: Build & Run UX modal: first-run explanation modal, "What just happened?", "Show me the Apps disk" button. Gated on layout work.
- **#22**: File tree + tabs: left-side file tree replacing Project/File dropdowns, tab bar, dirty-state indicator (●). 
- **#23**: Rez (.r) syntax highlighting in CodeMirror 6.

### Key constraints
- No external CSS frameworks, no CSS preprocessor — plain CSS only.
- Mobile: playground editor is hidden on small screens ("Open this page on a desktop browser").
- Accessibility: every interactive element needs keyboard nav + ARIA labelling.
- CSP: no inline styles in JS — add CSS classes, not style properties.
- The Mac canvas is a fixed-size <canvas>; don't change its aspect ratio.

### Tone and personality
The project has a nostalgic-but-modern personality. The System 7 chrome is a feature, not a constraint to work around. Proposed UI should feel like it *belongs* in 1993 Mac style — no gradients, no shadows, no rounded corners (except for System 7-era rounded-rect buttons), no animations that feel "app-like".

Answer all questions as this designer. Be opinionated. Flag anything that breaks the System 7 aesthetic or introduces accessibility issues as HIGH. Be specific about CSS selectors, pixel values, and HTML structure when reviewing designs.`;

const session = await joinSession({
    tools: [
        {
            name: "cvm_ux_review",
            description:
                "Review a proposed UI feature or design change through the System 7 aesthetic + " +
                "accessibility + first-timer experience lens. Returns severity-ranked findings " +
                "covering visual consistency, keyboard nav, mobile, ARIA, and onboarding clarity.",
            parameters: {
                type: "object",
                properties: {
                    feature: {
                        type: "string",
                        description: "Description of the proposed UI feature or change.",
                    },
                    mockup_or_code: {
                        type: "string",
                        description: "Optional: HTML/CSS mockup, sketch description, or current code to review.",
                    },
                    issue_number: {
                        type: "integer",
                        description: "Optional: related GitHub issue number.",
                    },
                },
                required: ["feature"],
            },
            handler: async (args) => {
                const parts = [
                    UX_SYSTEM,
                    "\n\n---\n\n",
                    `Review this proposed UI change for classic-vibe-mac:\n\n**Feature:** ${args.feature}`,
                ];
                if (args.issue_number) parts.push(`\n**Issue:** #${args.issue_number}`);
                if (args.mockup_or_code) parts.push(`\n\n**Mockup / current code:**\n\`\`\`\n${args.mockup_or_code}\n\`\`\``);
                parts.push(`\n\nReview for:\n1. System 7 visual consistency (HIGH if it looks "web 2.0")\n2. Keyboard navigation and focus management\n3. ARIA roles, labels, live regions\n4. First-timer comprehension — would someone who has never used this page understand it?\n5. Mobile implications (even though the editor is hidden on mobile, the page chrome still needs to work)\n6. Anything that would confuse a visitor who has no prior context\n\nSeverity: HIGH / MEDIUM / LOW per finding.`);
                await session.log("Consulting UX/design specialist…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt: parts.join("") }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },

        {
            name: "cvm_ux_first_run",
            description:
                "Analyse a feature or flow from the first-timer's perspective. " +
                "Asks: what does someone see on their very first visit? " +
                "What is confusing? What needs a label, tooltip, or onboarding step?",
            parameters: {
                type: "object",
                properties: {
                    flow: {
                        type: "string",
                        description: "The user flow to analyse, e.g. 'clicking Build & Run for the first time'",
                    },
                    current_ui: {
                        type: "string",
                        description: "Optional: describe the current UI state the user sees.",
                    },
                },
                required: ["flow"],
            },
            handler: async (args) => {
                const prompt = `${UX_SYSTEM}

---

Analyse this user flow from the perspective of someone who:
- Has never used this site before
- Knows what a Mac is but may not know Retro68, Rez, HFS, or resource forks
- Is curious about classic Mac development but hasn't committed to installing a toolchain

**Flow:** ${args.flow}
${args.current_ui ? `**Current UI:** ${args.current_ui}` : ""}

Walk through the experience step by step. Flag every moment of confusion as HIGH (blocks understanding) / MEDIUM (causes hesitation) / LOW (minor friction). For each finding, suggest the minimum-viable fix (a label, a status message, a tooltip, a first-run modal).`;

                await session.log("Running first-timer UX analysis…", { ephemeral: true });
                const resp = await session.sendAndWait({ prompt }, 90_000);
                return resp?.data?.content ?? "(no response)";
            },
        },
    ],
});
