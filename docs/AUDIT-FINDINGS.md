# Documentation audit — findings

_Written 2026-05-08 against branch `docs/audit-and-refresh`._

End-to-end pass over every markdown doc in scope. Surgical staleness
fixes were committed inline in this branch (~8 files, net change ~-9
lines). The bigger structural concerns and the gaps that need human
judgment are flagged below.

The audit deliberately did **not** touch:

- `src/app/README.md` — an in-flight agent on `feat/hello-mac-app`
  is updating it to mention Hello Mac. Findings below cover what the
  audit observed elsewhere about the third demo app.
- Source code, CMake, Vite config, CI workflow YAML — out of scope
  for a docs pass.

---

## Doc-by-doc inline fixes applied

### `README.md`
- Headline paragraph rewritten to past tense: the
  edit / compile / hot-load loop is live in production, not "the
  next milestone."
- "What it does" → "Playground" bullet flipped from future to
  shipped, with the `~820ms warm` round-trip number.
- "Try it" → "What works today" paragraph collapsed Build and
  Build & Run as both shipped.
- `Status` → Phase 2 and Phase 3 entries flipped from
  "in build-out" / "ahead of us" to "✅ shipped on `main`," with
  pointers to `tools/wasm-rez/` (post-merge location of WASM-Rez
  source) and `src/web/public/wasm-rez/` (deployed runtime).
- `Coming soon` section dropped the "Phase 2 build-out" and
  "Phase 3 hot-load" entries (both shipped); intro line reframed
  as polish + new demo apps.

### `PRD.md`
- "Problem Statement" #2 — Rez compiler reframed from "currently
  in build-out" to shipped (with the ~820ms warm round-trip
  number).
- "Proposed Approach" — playground bullet flipped from
  "(In build-out)" to shipped.
- ASCII architecture diagram — `(build-out, Phase 2/3)` →
  `(Phase 2/3, shipped)`.
- Components → Playground (§5) — rewritten to reflect all three
  phases shipped, with the source/runtime path split
  (`tools/wasm-rez/` vs `src/web/public/wasm-rez/`).
- "Live milestones" header flipped from "in flight" to "✅ shipped";
  Phase 2 and Phase 3 bullets updated.
- Risks table — "Boost.Wave port" entry rewritten to reflect that
  the dependency was sidestepped via the TypeScript-side
  preprocessor (`src/web/src/playground/preprocessor.ts`), not
  ported.
- "Open work" → "Playground build-out" section deleted (both
  phases shipped); replaced with a one-line "build-out shipped on
  main" framing for the polish list that follows.

### `CONTRIBUTING.md`
- "Branching" section — dropped the "in early scaffolding"
  paragraph (the project is well past scaffolding); replaced with
  the actual conventional branch prefixes used today
  (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `spike/`).
  Added a pointer to `docs/AGENT-PROCESS.md` for the multi-agent
  dispatch hygiene the project has converged on.

### `docs/PLAYGROUND.md`
- Phase 3 status box — flipped from "not started" to "✅ shipped
  on main," with the `~820ms warm` round-trip number. Followups
  (#29, #31) called out as still open.
- "Total realistic estimate" section — now records actual outcome
  (all three phases shipped via the TypeScript preprocessor
  shortcut) alongside the original ~7-12 weeks estimate.

### `docs/AGENT-PROCESS.md`
- Sub-agent dispatch example — `spike/wasm-rez/` annotated with
  the post-merge path (`tools/wasm-rez/`).

### `docs/DEVELOPMENT.md`
- Broken anchor fixed: `../README.md#how-to-use-it` → `#try-it`
  (the README's heading is "Try it," not "How to use it").
- Path A artifact-pull example — directory pattern updated from
  the single-app `Reader-*` to `classic-vibe-mac-*`; output
  inventory updated to show `build/<app>/` per-app subdirs;
  `build-boot-disk.sh` invocation updated to comma-separated form
  for both Reader and MacWeather.
- Path B local-Docker outputs table — same per-app split.
- "Change app behavior" recipe — boot-disk rebuild updated to
  pass both apps.

### `src/web/README.md`
- "Status" paragraph — Build & Run flipped from "Phase 3 (in
  flight)" to shipped, with the `~820ms warm` round-trip number.

### `.github/pull_request_template.md`
- No changes. Reads correctly today.

### `LEARNINGS.md`
- No changes. The file is append-only by convention; existing
  entries are date-stamped and stay accurate as historical record.

### `tests/README.md`
- No changes. Description is current.

### `docs/HOW-IT-WORKS.md`, `docs/ARCHITECTURE.md`
- No changes. Both already reflected current shipped state.
  Lock state names in `ARCHITECTURE.md` (line 96-99) are correct
  today: `READY_FOR_UI_THREAD` / `UI_THREAD_LOCK` /
  `READY_FOR_EMUL_THREAD` / `EMUL_THREAD_LOCK`.

---

## Bigger structural concerns

These need human judgment to land. Flagged but not fixed.

### 1. PRD vs README vs PLAYGROUND — three overlapping copies of "what shipped" and "what's next"

The same status information lives in `README.md § Status`,
`PRD.md § Goals + § Open work`, and `docs/PLAYGROUND.md § Phase
1/2/3 sketches`. After this audit pass each of those three is
internally consistent, but they will drift again the next time
something ships. **Recommendation:** declare one of them canonical
for status (PLAYGROUND.md is the natural fit — it already has the
phase structure) and have README and PRD link to it instead of
restating. Out of scope for a surgical audit; flagged for a
follow-up rewrite.

### 2. PRD's Risks table contradicts the closed-Epic graveyard's framing

The Risks table in `PRD.md` lists "Playground Phase 2 Boost.Wave
port" and "Playground Phase 2 cold-start latency" as risks. After
this audit the first one is rewritten to reflect the resolution
(TypeScript preprocessor sidestep), but the second still reads as
forward-looking ("UX copy must say…"). The table mixes
historical-risks-now-mitigated with active-risks; the pattern
already used in the table for resolved entries is "(resolved
2026-05-08)" — this should be applied consistently. **Recommendation:**
a separate small PR that audits the Risks table top to bottom,
splitting "historical risks for context" from "active risks under
mitigation."

### 3. `docs/DEVELOPMENT.md` is largely Reader-shaped

`Loop 1`, the worked example for `<code>`, the bisection-by-deletion
debug recipe, and the "change app behavior" recipe all walk
through Reader specifically. With three demo apps now (Reader,
MacWeather, and Hello Mac on `feat/hello-mac-app`), a contributor
arriving via DEVELOPMENT.md is left guessing how the workflow
generalizes. **Recommendation:** a structural pass to genericise
the worked examples, or to add a separate "by example" subsection
that walks the contributor through a tiny change in each of the
three apps. The current doc is correct for Reader specifically;
the gap is that it reads as if Reader is the only app.

### 4. `docs/AGENT-PROCESS.md` documents the dispatch pattern but doesn't surface it for human contributors

The five-reviewer Epic pass and the sub-agent dispatch hygiene
are powerful. But they're documented as a workflow the
maintainer (and the maintainer's agents) follow, not as a
contributor-facing protocol. A human reading
`CONTRIBUTING.md` won't naturally land in AGENT-PROCESS.md —
this audit added a pointer, but the doc itself still reads as
internal. **Recommendation:** decide whether AGENT-PROCESS.md is
"how the project is run" (keep internal-shaped) or "how
contributors should work too" (rewrite the framing for an
incoming person).

### 5. README's "Coming soon" still leans heavily on issue numbers

After this audit the section is correct, but it's a wall of
GitHub issue links with no narrative. A first-time reader trying
to understand "where is this project going" gets a bullet-pointed
backlog. **Recommendation:** rewrite as 1-2 narrative paragraphs
("polish + new demo apps; networking is deliberately deferred")
with the issue numbers as inline references. Out of scope for a
surgical pass.

### 6. `src/web/README.md` `Files` section is granular and hard to keep current

The `Files` block lists every `.ts` file under `src/web/src/` with
a one-line description. Every time a new file lands (or one is
renamed), the README either drifts or has to be updated by hand.
**Recommendation:** either auto-generate this from the source tree
at build time, or trim the list to the load-bearing files
(`emulator-loader`, `emulator-worker`, `playground/build`,
`playground/rez`) and let the rest self-document via filename.

---

## Missing pieces for new contributors

The bigger / softer question: "if I just landed at this repo,
would I know what to do next?" Six gaps observed.

### 1. There is no concrete "first commit" recipe

`CONTRIBUTING.md` describes branch / commit / PR conventions but
never walks through the path from `git clone` to "I made a
visible change and saw it work." The README has a "Try it"
section that boots the deployed page locally; DEVELOPMENT.md has
the iteration loops. Neither stitches them together as
"step-by-step, here is what your first contribution looks like."
A 10-line recipe in CONTRIBUTING.md (`fork → clone → npm install
→ npm run dev → open localhost:5173 → edit reader.c, reload, see
the change → commit → PR`) would close this. Why it matters: the
project's pitch is "no install, no toolchain, hop in" — a
contributor expects to try a commit in fifteen minutes and the
docs don't quite get them there.

### 2. There is no troubleshooting front door

DEVELOPMENT.md has a `Common failure modes mapped to fixes`
section that's actually quite good — `modelid`, COOP/COEP,
`hls -l` columns, etc. But it lives at the bottom of a 460-line
doc, under a heading a stuck contributor wouldn't scan for
("Common failure modes" reads like reference material, not "I'm
broken, where do I look"). A small `TROUBLESHOOTING.md` or a
prominent banner in the README pointing to that section would
shorten the time-to-unblock for someone who just typed
`npm run dev` and saw a SAB error. Why it matters: most
contributors give up on the *second* error, not the first; if
the second error is harder to find an answer for than the first,
they bounce.

### 3. The agent-driven workflow isn't surfaced for human contributors

The project's actual dev process — sub-agent dispatches,
five-reviewer passes, parallel ownership of file regions — is
documented in `docs/AGENT-PROCESS.md`. But CONTRIBUTING.md
doesn't reference it (this audit added a one-line pointer);
README's "Iterating on it" section name-drops the five-reviewer
pass without explaining what it is. A human contributor opening
a non-trivial PR genuinely needs to know "expect a reviewer
pass; here's what it looks like; here's what the reviewer
will and won't catch." Why it matters: the pattern is part of
why this project's design quality has held up across rapid
iteration; hiding it makes the project look chaotic instead of
disciplined.

### 4. There is no "what is _not_ in scope" front door

The README's "Coming soon" section lists what's coming. The
PLAYGROUND.md's closed-Epic graveyard explains two specific
things that were tried and rejected. But the *general* "things
this project deliberately doesn't do" (no backend, no auth, no
shared store, no GCC port, no full IDE, no cross-browser parity)
is scattered across four docs. New contributors regularly
propose features that have already been ruled out architecturally.
**Recommendation:** a single "What this project is not" sub-
section, either in the README or in PRD's Non-Goals (which
exists but is short). Why it matters: the project's design
discipline depends on recognising which proposals are
architecturally off-limits before a reviewer pass burns a day
on them.

### 5. There is no automated link-checker or markdown-lint in CI

This audit found one broken anchor (`README.md#how-to-use-it`)
that had been broken for some unknown length of time. Cross-
link rot is the #1 failure mode for a codebase with this many
markdown files cross-linking to each other; a one-shot human
audit will miss new rot. A 5-minute CI job
(`lychee` or similar) would catch the next broken link the day
it lands. Why it matters: this audit takes time; preventing the
next round costs almost nothing.

### 6. The third demo app (Hello Mac, on `feat/hello-mac-app`) is invisible from the docs

When Hello Mac merges, every demo-app inventory in the docs will
need updating: README headline screenshot caption, README
"Two demo apps" → "Three demo apps", PRD ASCII boot disk,
ARCHITECTURE multi-app-model section, HOW-IT-WORKS Part 1 step
5, and DEVELOPMENT recipes. This audit deliberately did not
update any of those because the agent on the feature branch is
expected to. **Recommendation:** post-merge, a single squash-
commit "docs: surface Hello Mac across the doc set" would close
this — but it should be a tracked checklist item on the merging
PR, not left as a subsequent oversight.

---

## Recommended next steps

In priority order. Each is a small follow-up issue / PR.

1. **Add a contributor "first commit" recipe to `CONTRIBUTING.md`**
   (15-line addition; closes gap #1). Highest leverage per LOC.

2. **Add a CI link-checker** (`lychee-action` against all `*.md`
   files; one workflow file). Closes gap #5; prevents the next
   round of doc-rot.

3. **Decide canonical home for status, then de-dup the other two**
   (structural concern #1). Fine to defer until after Hello Mac
   lands and ENV stabilizes; but flag it before another Epic
   ships and the three copies drift again.

4. **Rewrite README's "Coming soon" as narrative**
   (structural concern #5). Quick prose pass, ~30 minutes.

5. **Audit PRD's Risks table for resolved-vs-active entries**
   (structural concern #2). Apply the existing
   `(resolved YYYY-MM-DD)` convention consistently.

6. **Pull `docs/DEVELOPMENT.md`'s `Common failure modes` section
   into `docs/TROUBLESHOOTING.md`** (gap #2) and link it from
   the README header. Or leave it inline but add an explicit
   pointer from README's Status section.

7. **Decide framing for `docs/AGENT-PROCESS.md`** (structural
   concern #4 + gap #3) — internal vs contributor-facing —
   then either rewrite or reference more aggressively from
   CONTRIBUTING.

8. **Post-Hello-Mac-merge: docs sweep for the demo-app inventory**
   (gap #6). Track on the merge PR's checklist.
