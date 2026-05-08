# Agent process

_Last updated: 2026-05-08._

The dev workflow that `classic-vibe-mac` has converged on. Useful both
as documentation for future maintainers of this repo and as a reusable
pattern for any single-engineer-with-AI project where the spec is
fuzzy and the cost of shipping a bad architecture is large.

Companion docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system
this process produces, [`PLAYGROUND.md`](./PLAYGROUND.md) for a
worked example of what comes out of one of these passes,
[`CONTRIBUTING.md`](../CONTRIBUTING.md) for commit conventions,
[`DEVELOPMENT.md`](./DEVELOPMENT.md) for day-to-day iteration loops,
and [`LEARNINGS.md`](../LEARNINGS.md) for the running gotcha log.

## The five-reviewer red-flag pass

Before committing to any major Epic — anything with a multi-week
estimate, anything that touches infrastructure, anything that
introduces a new architectural axis — dispatch five independent
agents in parallel, each with a different lens. They write
critiques with severity-ranked findings; the orchestrator
consolidates and decides go / no-go / scope-down.

The lenses we've used, picked per Epic from this menu:

| Lens | What it catches |
|------|-----------------|
| Domain expert | Wrong-by-an-OSI-layer architectural mistakes. The "this won't work for reasons specific to the field" finding. |
| Scope / PM | "This is bigger than you think." Honest re-estimates against scope. Flags when an Epic displaces higher-leverage work. |
| Security / abuse | DoS surfaces, spam-relay risks, OAuth scope creep, secret-handling mistakes, anything that would shut a free-tier account down. |
| Infrastructure feasibility | Compute budget, free-tier ceilings, ToS clauses, dependency licensing, runtime feasibility on the target. |
| Legal / IP | Redistribution of binaries, OSS license obligations, ToS clauses on third-party services. Used when third-party code or services touch the design. |
| Editor / UX | Honest sizing for editor work, accessibility, keyboard handling, mobile. Used when the design has a UI surface. |
| Compilation / runtime | Honest sizing for toolchain ports, WASM feasibility, ABI gotchas. Used when the design proposes new compilation paths. |
| Hot-load / dev loop | "Will this actually feel fast in practice?" Used when the pitch involves runtime hot-replacement. |

Always at least three lenses; five is the sweet spot — fewer and a
critical angle gets missed, more and the consolidation becomes its
own project. Each reviewer writes a severity-ranked finding list
(HIGH / MEDIUM / LOW). Orchestrator consolidates: HIGH findings
that converge across reviewers are show-stoppers; MEDIUM findings
that converge become scope-down requirements; LOW findings get
filed as follow-ups.

## Worked examples

Three Epics, three outcomes. All in May 2026.

### Epic #12 — closed after pass

[#12 — Real Mac TCP/IP via WebSocket relay](https://github.com/khawkins98/classic-vibe-mac/issues/12).
Killed by HIGH findings from three independent reviewers
converging on different show-stoppers (architecture wrong by an
OSI layer; Cloudflare ToS §2.2.1(j) forbids VPN-like services;
iCab 2.x is actively-licensed shareware). Estimate was 5-10x
optimistic. Replaced with three smaller, achievable issues. See
[`PLAYGROUND.md` § Closed-Epic graveyard](./PLAYGROUND.md#epic-12--real-mac-tcpip-via-websocket-relay-closed)
for full reasoning.

### Epic #19 — closed after pass

[#19 — In-browser IDE with C compilation](https://github.com/khawkins98/classic-vibe-mac/issues/19).
Killed by HIGH findings: Phase 2C needed OAuth `repo` scope plus
a token-exchange relay (i.e. a backend, contradicting the project
constraint); Phase 3 silently assumed an in-browser HFS writer
that doesn't exist; option 2A (full Retro68 → WASM) was honestly
4-9 engineer-months. Replaced with a refined Epic (#21) that
commits to option 2F (Rez-in-WASM + resource patcher) — covers
~70% of the emotional promise with ~5% of the effort.

### Epic #21 — refined and approved after pass

[#21 — In-browser playground for resource-fork edits](https://github.com/khawkins98/classic-vibe-mac/issues/21).
Same five-reviewer pattern, different outcome: ship, with the
implementation choices the reviews surfaced. Phase 1 scoped down
4-6 days; Phase 2 estimate corrected from 2-3 weeks to 4-6 weeks
with a 1-week spike pre-committed to a fork point at week 2;
Phase 3 committed to template-splice over real HFS encoding.
10 child issues filed (#22-#31) for deferred scope. See
[`PLAYGROUND.md`](./PLAYGROUND.md) for the full design rationale
this pass produced.

The pattern: review _refines_ rather than _gates_ when the user has
already declared the Epic strategically core. Reviewers know this
in their prompt, so their job becomes "find the right
implementation," not "find a reason to kill it."

## Sub-agent dispatch hygiene

Hard-won rules for parallel agents in the same session.

- **File ownership boundaries.** Two agents must never write to
  the same file in the same session. Partition by directory or by
  file glob. The Phase 1 editor agent owns `src/web/src/playground/`
  and `src/web/public/sample-projects/`; the spike agent owns
  `spike/wasm-rez/`; this doc agent owns `docs/`. No overlap.
- **Feature branches, not main.** Each parallel agent works on
  its own branch (`feat/playground-phase1`, `spike/wasm-rez`,
  `docs/playground-design`). Never directly on `main`. The
  orchestrator merges, with a squash-merge that captures the
  full story.
- **Prompt = role + deliverable + don't-touch list.** Every
  dispatch carries: the role (CodeMirror editor specialist,
  WASM porting specialist, security reviewer, etc.), the
  specific deliverable (file paths to produce, accepted
  format), and an explicit list of files / directories the
  agent must NOT touch. The don't-touch list is more
  load-bearing than it sounds — a helpful agent will refactor
  the world if given the chance.
- **Time-box research spikes.** A spike isn't an Epic. Open it as
  a `do-not-merge` PR with a fixed clock (e.g. 1 week). Pre-commit
  to a fork point: at the halfway mark, hard decision — proceed,
  fall back to plan B, or kill. Don't let a spike turn into a
  silent multi-week commitment.
- **Ask for under-N-word reports.** Every agent dispatch ends
  with "report back, under N words: what you did, what you
  found, what's left." Forces useful summaries. Specifics get
  filed as commit messages or issue comments, not as repeated
  prose in the chat.

## Commit hygiene

- **Conventional Commits.** `feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`. Scope optional but useful (`feat(playground):`,
  `fix(emulator):`). See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
- **Squash-merge for PRs.** Default. The squash commit's body
  captures the full story of the PR — it's the merge record.
  Reviewers and future contributors read this, not the
  individual WIP commits.
- **`LEARNINGS.md` updates ride along.** Any PR that hit a
  non-obvious gotcha appends an entry to `LEARNINGS.md` in the
  same PR. Newest entries on top, dated. The format header at
  the top of the file documents itself. The file already
  carries dozens of entries — read those first when something
  behaves oddly.
- **No `--amend` after a hook failure.** When a pre-commit
  hook fails, the commit didn't happen. Re-stage and create a
  new commit. Amending modifies the previous commit, which
  may destroy work or lose previous changes.

## Documentation as you go

- **Every PR can update `LEARNINGS.md` and the relevant
  `docs/*.md`.** The cost is small (a paragraph) and the
  compounding return is large.
- **PRD reflects current scope.** When the scope of an Epic
  changes — closed, refined, deferred — `PRD.md` gets the
  edit in the same session. Not later.
- **README screenshots stay current.** When the deployed
  page changes meaningfully, regenerate
  `public/screenshot-deployed.png`. The screenshot is the
  README's headline; stale screenshots make the project look
  abandoned.
- **Per-area READMEs over a single CLAUDE.md.**
  [`src/app/README.md`](../src/app/README.md),
  [`src/web/README.md`](../src/web/README.md),
  [`tests/README.md`](../tests/README.md), and
  [`scripts/`](../scripts/) self-document in their own files. The
  top-level `README.md` orients; the area README is the source
  of truth for that area.
- **Three docs in `docs/` cover the cross-cutting concerns.**
  [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system as it is,
  [`PLAYGROUND.md`](./PLAYGROUND.md) for the design rationale of
  the active Epic, [`AGENT-PROCESS.md`](./AGENT-PROCESS.md) for
  this workflow. Cross-link between them and back to PRD /
  README / LEARNINGS so a contributor entering from any door can
  navigate.

## What the project doesn't do

Stating these by negation since they're easy to drift into.

- **No single-engineer coordination.** When multiple things are
  in flight, the orchestrator dispatches sub-agents in parallel
  with non-overlapping file ownership. The orchestrator does not
  itself implement those parallel pieces.
- **No code review without an independent reviewer agent.**
  Self-review is a known weak loop. Land changes through a
  reviewer pass — either the five-reviewer Epic pass for big
  designs, or a single independent reviewer for normal PRs. The
  reviewer reads the diff fresh; the implementer doesn't argue
  with the review during the same turn.
- **No scope-creep within a single PR.** A PR titled
  "feat(playground): IndexedDB persistence" doesn't also touch
  the emulator worker, the build script, and the README. If the
  diff would do that, it gets split. Squash-merging encourages
  this — each squash commit reads as one atomic story.
- **No skipping hooks.** `--no-verify` is banned. If a hook
  fails, fix the underlying issue. The hooks are there because
  past failures cost time.
