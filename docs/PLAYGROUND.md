# Playground

_Last updated: 2026-05-15._

The design rationale and rolling status of Epic #21 — the in-browser
playground for resource-fork edits to classic Mac apps. Companion docs:
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the system this playground
plugs into, and [`AGENT-PROCESS.md`](./AGENT-PROCESS.md) for the
five-reviewer pass that produced this design. See also
[`PRD.md`](../PRD.md), [`LEARNINGS.md`](../LEARNINGS.md), and
[`src/app/README.md`](../src/app/README.md) for the apps the playground
edits.

The Epic itself, with the live status tracker, lives at
[#21](https://github.com/khawkins98/classic-vibe-mac/issues/21).

## The vision

> "Edit a `STR#` and watch the Mac re-launch with your change in well
> under a second, all in a single browser tab."
>
> — Epic #21

The user has explicitly called this the project's core differentiator.
It's the feature that turns a "1993 Macintosh that lives at a URL"
into a place where someone can actually _make_ something without
installing a toolchain.

## Hard constraint: pure browser, no infra

The user's red line, restated every review:

> "everything runs as JavaScript in the visitor's browser. No backend.
> No relay. No compile service. No database."

This rules out, in advance:

- Server-side Docker compile (Epic #19 option 2B). DoS-as-a-service
  surface; abuse mitigations cost real money on a project with no
  budget.
- GitHub OAuth + `workflow_dispatch` (Epic #19 option 2C). Needs
  `repo` scope, needs a token-exchange relay (which IS a backend),
  reintroduces the onboarding step the playground was supposed to
  remove.
- Cloud-sync of edits, multi-user collaboration, anything that needs
  a shared store.
- TLS-MITM relays, DNS proxies, anything in the family killed by
  Epic #12.

Every design choice below is downstream of this constraint.

## Why option 2F (Rez-in-WASM + resource patcher) won the architecture review

Five-reviewer pass on Epic #21, summary:

- **Security review:** clean. With option 2B/2C dropped, the threat
  surface collapses to "any website you visit can run JS." Strict
  CSP (`script-src 'self'; object-src 'none'; base-uri 'none'`) is
  hygiene, not load-bearing.
- **Editor / UX:** Phase 1 estimate is 2-3x light. Scope-down before
  kickoff or it'll bleed.
- **Compilation feasibility:** 2F is the right call. Phase 2 is
  **4-6 weeks**, not 2-3. The single critical-path unknown is
  **Boost.Wave**, Rez's C-preprocessor dependency. 2.3MB / 446 files,
  transitively pulls Boost.Thread + Filesystem + Spirit. No public
  WASM port. Pre-commit to a fork point at week 2 — if Boost.Wave
  hasn't landed clean, fall back to `mcpp` or a hand-rolled subset.
- **Hot-load:** option 3D (template-splice) works, but only if we
  ship an empty-volume `.dsk` as a CI artifact and patch the
  catalog + bitmap + MDB in-browser to insert one file. ~5-7 days.
  Writing a real HFS encoder is 12-18 days; not worth it for the
  single-file shape we need.
- **Scope/PM:** flagged that this displaces #14, #17, #9, #15.
  User explicitly overruled — this Epic is the differentiator.

Verdict: ship, with the implementation choices below. The
architecturally-honest version of "covers ~70% of the playground
promise with ~5% of option 2A's effort."

## What 2F covers and what it doesn't

**In scope: resource-fork edits.** STR# (string lists), DLOG
(dialogs), MENU (menu definitions), ALRT (alerts), WIND (windows),
DITL (dialog item lists), CNTL (controls), and friends. The visible
surface of every classic Mac app — labels, menu names, window
titles, button text, dialog wording — is in `<app>.r`. Most "tweak
a string and watch the result" use cases are exactly resource edits.

**Out of scope: C source changes.** Edit `reader.c` to change the
event loop, layout math, or HTML parsing? That goes through the
existing CI / `git push` pipeline. Download as zip → fork → push →
CI does what it does today (~3-4 min wall time). The honest trade
is: zero-friction loop for the common case, normal-friction loop
for the deep case. Nobody loses anything they had; some people gain
the fast loop.

This is a deliberate scope cut. The previous Epic (#19) was killed
in part for trying to cover both cases with a single mechanism and
arriving at "needs an HFS writer we don't have, plus OAuth, plus a
hardened compile sandbox." 2F walks away from that.

## Status

_Canonical shipped-state record. README.md and PRD.md point here;
don't duplicate this in either file._

| Phase | What | State |
|-------|------|-------|
| Boot loop + multi-app demo | System 7.5.5 boots in browser, Reader + MacWeather auto-launch, two-way data flow live, mouse + keyboard input | ✅ shipped |
| Playground Phase 1 — editor + persistence | CodeMirror 6, C syntax, single-file editor, IndexedDB persistence, download-as-zip, sample projects seeded at build time, strict CSP | ✅ shipped (PR #32) |
| Playground Phase 2 — in-browser Rez compilation | WASM-Rez source vendored under `tools/wasm-rez/`; Build button preprocesses → WASM-Rez → resource fork splice → `.bin` download; output bytes SHA-256-identical to native Retro68 Rez at 103KB gzipped | ✅ shipped on `main` |
| Playground Phase 3 — hot-load into the running Mac | Template-splice HFS patcher + `InMemoryDisk` + worker re-spawn; Build & Run round-trips ~820ms warm in production | ✅ shipped on `main` |
| Rez syntax highlighting | CodeMirror 6 StreamLanguage grammar for `.r` files | ✅ shipped (#23) |
| Build & Run first-run modal | "What just happened?" orientation dialog after first hot-load | ✅ shipped (#46) |
| Audio | PCM via AudioWorklet; buffer reset on reboot; null-guard on blit | ✅ shipped (#47) |
| Split-pane layout | Side-by-side editor + emulator at ≥1200px viewport | ✅ shipped (#25, #45) |
| File tab bar + dirty indicators | Multi-file tabs, unsaved-change dot, per-file persistence | ✅ shipped (#22) |
| Smart bundle migration | Preserve user-edited files across `bundleVersion` bumps | ✅ shipped (#24) |
| Hello, Mac! starter sample | Minimal WIND+DrawString+WNE starter project in the playground | ✅ shipped (#26) |
| Architecture review | 5-reviewer pass; all critical findings resolved | ✅ closed (#49) |
| Pixel Pad (#17) | QuickDraw drawing app; live PNG preview via drawing-watcher extfs bridge | ✅ shipped |
| Reader URL bar (#14) | URL fetch via Mac→JS request/response over extfs; request-ID correlation; AbortController | ✅ shipped |
| Markdown Viewer (#9) | Reads .md from :Shared:, renders with C Markdown parser | ✅ shipped |
| Ethernet relay (#15) | Opt-in AppleTalk zone networking via ?zone=; SPSC ring SAB; Cloudflare DO relay in worker/ | ✅ shipped |
| Epic #12 — Real Mac TCP/IP via relay | Closed after review (architecture wrong + ToS violation) | ❌ closed |
| Epic #19 — Full in-browser IDE with C compilation | Original framing closed after review; **capability shipped 2026-05-15 via a different path** (wasm-compile Retro68's existing toolchain instead of porting GCC from scratch). See Epic #19 post-mortem below. | ✅ shipped (different path) |
| In-browser C compilation (`compileToBin`) | cc1 + as + ld + Elf2Mac wasm-compiled from Retro68, orchestrated from `cc1.ts`; SIZE-resource splice, `--emit-relocs` for runtime relocation; end-to-end Build & Run for `wasm-hello/hello.c` boots cleanly in BasiliskII | ✅ shipped 2026-05-15 (#97) |

For the full issue tracker (open Epics, child issues, roadmap) see
<https://github.com/khawkins98/classic-vibe-mac/issues>.
See [Closed-Epic graveyard](#closed-epic-graveyard) for the full post-mortems.

## Phase 1 / Phase 2 / Phase 3 sketches

Three phases, mostly independent. Numbers are post-review, post-
scope-down honest estimates, not the original Epic's.

### Phase 1 — Source viewer + editor + persistence (~4-6 days)

Per the editor reviewer's scope-down. CodeMirror 6 with
`minimalSetup` + the C language pack only. **Single-file editor**
for v1: no file tree, no tabs, no Rez highlighting. IndexedDB
persistence with `bundleVersion`-only invalidation (no 3-way diff
UI yet). Strict CSP. Mobile hides the editor with an "open in
desktop browser" message. "Reset to default" per file.
Download-as-zip via JSZip in the browser (~25KB). One inline
`// ← try changing this` comment in the seeded sample as
onboarding affordance.

```
[ ] CodeMirror 6 minimalSetup + C lang pack
[ ] IndexedDB persistence, bundleVersion-only invalidation
[ ] IDB-unavailable fallback (in-memory + persistent banner)
[ ] UI-state persistence (open file, cursor, debounced 1s)
[ ] Sample projects copied at Vite build time from src/app/<name>/
[ ] Reset-to-default per file
[ ] Download-as-zip
[ ] Strict CSP, treat IDB content as untrusted text
[ ] Settings: "Show editor" checkbox (default ON when ≥1200px)
```

Status (2026-05-08): ✅ shipped on main. Files live under
`src/web/src/playground/` (`editor.ts`, `persistence.ts`, `types.ts`)
plus sample bundles under `src/web/public/sample-projects/`.

### Phase 2 — Rez compilation in-browser (~4-6 weeks, gated on spike)

The interesting part. The compilation reviewer's honest estimate;
the original Epic's 2-3 weeks is not realistic.

**Time-boxed 1-week research spike first.** Goal: get `mcpp +
WASM-Rez` (or `Boost.Wave + WASM-Rez` if Boost.Wave ports cleanly)
compiling a trivial `.r` file with one STR# resource against
vendored multiversal RIncludes, end-to-end, in a browser tab.
Pre-commit to a fork point at the spike's week-2 mark: Boost.Wave
or fall back to mcpp / hand-rolled.

```
Spike phase (week 1):
[ ] Compile Rez to WASM via Emscripten
[ ] Choose preprocessor (Boost.Wave vs mcpp vs hand-rolled subset)
[ ] Vendor multiversal RIncludes (~600KB unpacked, NOT 5MB)
[ ] Map Rez's #include to read from the editor's IDB virtual FS
[ ] STR# round-trip: input .r -> output bytes match native Rez

Build-out phase (3-5 weeks, gated on spike):
[ ] Precompile each sample's .code.bin once on CI
[ ] Build click handler: read .r from IDB -> WASM-Rez -> splice
    new resource fork onto precompiled .code.bin -> complete .bin
[ ] Editor markers from Rez error messages
[ ] Always re-run Rez against the WHOLE .r file (don't patch
    individual resources — resource map offsets shift)
```

Realistic bundle size: 3-6MB gzipped (not 1-2MB as the original Epic
claimed). First compile after page load: ~1.5s. Warm compile:
**<500ms**. The Epic's "sub-second" claim is **warm sub-second**, not
first-call. Be honest about that in the UX copy.

Status (2026-05-08): ✅ shipped on main. WASM-Rez source vendored
under `tools/wasm-rez/`; compiled artefacts under
`src/web/public/wasm-rez/`. The Build button on the playground
preprocesses, runs WASM-Rez, splices a fresh resource fork onto the
CI-precompiled `.code.bin`, and downloads the resulting MacBinary.
See [#30](https://github.com/khawkins98/classic-vibe-mac/issues/30)
for the build-out tracker.

### Phase 3 — Hot-load into the running Mac (~5-7 days, gated on Phase 2)

Template-splice path, not "write a real HFS encoder." Per the
hot-load reviewer.

```
[ ] Ship empty-volume .dsk blob as a CI artifact (built by hfformat once)
[ ] In-browser HFS patcher (~500 lines TS): patch catalog leaf +
    bitmap + MDB to add one file
[ ] InMemoryDisk class for the BasiliskII disks API (~50-100 lines,
    alongside existing ChunkedDisk)
[ ] Worker re-spawn via existing dispose() + new boot()
    (NO Cmd-Ctrl-Restart key injection — too fragile)
[ ] Lock Type/Creator editing in the editor
    (Desktop DB icon-binding edge case)
[ ] Weather poller torn down on re-spawn
    (currently leaks a 15-min interval per worker re-spawn)
```

Status (2026-05-08): ✅ shipped on main. Build & Run round-trips
~820ms warm in production. Followups still tracked under
[#29](https://github.com/khawkins98/classic-vibe-mac/issues/29)
(weather poller teardown on re-spawn) and
[#31](https://github.com/khawkins98/classic-vibe-mac/issues/31)
(lock Type/Creator editing); the core path landed via
[#27](https://github.com/khawkins98/classic-vibe-mac/issues/27)
+ [#28](https://github.com/khawkins98/classic-vibe-mac/issues/28).

### Total realistic estimate

Originally scoped at ~7-12 weeks of focused work depending on the
Boost.Wave outcome. Actual landed: all three phases shipped on
`main` over a single intensive sprint by sidestepping Boost.Wave
entirely (TypeScript-side preprocessor against the IDB virtual FS;
see [`src/web/src/playground/preprocessor.ts`](../src/web/src/playground/preprocessor.ts)).

## Closed child issues

All child issues for Epic #21 are closed:

| # | Title | State |
|---|-------|-------|
| [#22](https://github.com/khawkins98/classic-vibe-mac/issues/22) | File tree + tabs + dirty-state in editor | ✅ closed |
| [#23](https://github.com/khawkins98/classic-vibe-mac/issues/23) | Rez (.r) syntax highlighting | ✅ closed |
| [#24](https://github.com/khawkins98/classic-vibe-mac/issues/24) | Smart bundle migration (preserve user-edited files) | ✅ closed |
| [#25](https://github.com/khawkins98/classic-vibe-mac/issues/25) | Side-by-side editor + emulator at viewport ≥1200px | ✅ closed |
| [#26](https://github.com/khawkins98/classic-vibe-mac/issues/26) | "Hello, Mac!" minimal starter sample | ✅ closed |
| [#27](https://github.com/khawkins98/classic-vibe-mac/issues/27) | HFS template-splice path | ✅ closed |
| [#28](https://github.com/khawkins98/classic-vibe-mac/issues/28) | InMemoryDisk class for the BasiliskII disks API | ✅ closed |
| [#29](https://github.com/khawkins98/classic-vibe-mac/issues/29) | Weather poller teardown on emulator worker re-spawn | ✅ closed |
| [#30](https://github.com/khawkins98/classic-vibe-mac/issues/30) | WASM-Rez full integration build-out | ✅ closed |
| [#31](https://github.com/khawkins98/classic-vibe-mac/issues/31) | Lock Type/Creator editing in the editor | ✅ closed |

## Known gotchas the spike will hit

These come straight from the compilation reviewer's comments on
Epic #21. Anyone picking up the spike should read these first.

- **Boost.Wave porting to WASM is the load-bearing unknown.** Rez
  uses Boost.Wave for `#include` and macros. 2.3MB / 446 files,
  pulls Boost.Thread + Filesystem + Spirit transitively. No public
  WASM port. Pre-commit to a week-2 fork point: if it isn't
  landing, fall back to `mcpp` (an existing WASM-capable C
  preprocessor) or hand-roll a preprocessor for the Rez-relevant
  subset (`#define`, `#include`, `#if`/`#endif`, no fancy macro
  expansion). The fallback is honest work — Rez `.r` files don't
  use the gnarly preprocessor features.
- **Multiversal RIncludes size.** Original Epic said 5MB; reviewer
  measured ~600KB unpacked. Vendor as data, not as a separate
  fetch. Bundle inflates the WASM-Rez payload to 3-6MB gzipped
  total — still loads fast on second visit (cached), but the
  first-visit cost is real.
- **MacBinary CRC.** When you splice a new resource fork onto a
  precompiled `.code.bin` and re-emit MacBinary, the CRC at the
  end of the header has to be recomputed (CRC-16-CCITT over the
  first 124 bytes). Easy to forget; surfaces as Finder refusing to
  run the binary with no error.
- **Always re-run Rez against the WHOLE `.r` file.** Don't try to
  patch individual resources. Resource map offsets shift; every
  byte downstream of the edit moves. That's a bear trap. Recompile
  the whole `.r` file each time; it's still <500ms warm.
- **"Sub-second compile" is warm sub-second, not first-call.**
  First call after page load: ~1.5s (WASM instantiation +
  Rez init + RIncludes parse). Second call onward: <500ms. Be
  honest in the UX copy ("first compile takes a moment…") or
  visitors will think it's broken.
- **Bison version pinning.** Rez's grammar files were generated
  with a specific Bison; rebuilding the parser tables with a
  different version produces different LALR tables and subtle
  parse divergences. Pin the Bison version in CI.

## Known gotchas Phase 3 will hit

From the hot-load reviewer.

- **HFS template-splice strategy.** Don't write a real HFS
  encoder. Ship one empty-volume `.dsk` blob as a CI artifact
  (built once by `hfformat`), then in-browser patch three things
  to add one file: the catalog B-tree leaf node (file record +
  thread record), the volume bitmap (mark allocation blocks
  used), and the MDB / VolumeInfo (file count, modtime, free
  blocks). ~500 lines TS. The worker reads it via the existing
  disks API once we add an `InMemoryDisk` class.
- **Type/Creator lock.** Desktop DB icon-binding is a real edge
  case. If the user changes the Type or Creator in the editor,
  the Finder's Desktop DB on the synthetic disk has no entry for
  the new combo and the icon goes generic. Phase 3 should
  literally lock those two fields read-only in the editor — see
  [#31](https://github.com/khawkins98/classic-vibe-mac/issues/31).
- **Weather poller teardown.** The main-thread weather poller
  uses `setInterval` (15 min). Worker re-spawn doesn't tear it
  down because it lives on the main thread, so each re-spawn
  leaks one timer. Small but real; fix tracked at
  [#29](https://github.com/khawkins98/classic-vibe-mac/issues/29).
  Phase 3's `dispose()` path needs to call into a poller-stop
  hook before spinning up the new worker.
- **In-memory disk class.** The existing `ChunkedDisk` is wired
  for read-only XHR. We need a parallel `InMemoryDisk` backed by
  a `Uint8Array` that satisfies the same disks-API contract.
  ~50-100 lines, alongside `ChunkedDisk`. Tracked at
  [#28](https://github.com/khawkins98/classic-vibe-mac/issues/28).
- **No Cmd-Ctrl-Restart key injection.** Tempting because it's
  the period-correct gesture, but the input ring's lock state
  during early boot makes the key sequence unreliable. Use the
  worker's `dispose()` + `boot()` cycle instead — the System 7
  boot animation is genuinely charming and reframes the latency
  as a feature.

## Closed-Epic graveyard

Two Epics that died honestly. Listing them so the next contributor
doesn't reinvent the wheel.

### Epic #12 — Real Mac TCP/IP via WebSocket relay (closed)

[#12](https://github.com/khawkins98/classic-vibe-mac/issues/12).
Killed by the five-reviewer pass.

- **Architecture is wrong by an OSI layer.** BasiliskII's
  `ether js` mode emits raw L2 Ethernet frames, not TCP byte
  streams. A real internet bridge needs a SLIRP-class userspace
  TCP stack on the relay (ARP responder, DHCP, DNS proxy, NAT44,
  TCP/UDP socket bridging keyed by 4-tuple). That's a project,
  not "100-200 lines TS."
- **Cloudflare ToS §2.2.1(j)** explicitly forbids "VPN or other
  similar proxy services." Account termination is the documented
  remedy. Running this on the maintainer's CF account puts the
  whole presence at risk.
- **iCab 2.x is actively-licensed shareware.** icab.de shipped
  iCab 6.3.7 in April 2026; Alexander Clauss is alive in Hamburg.
  Vendoring it on a public template repo is unauthorized
  redistribution of currently-monetized software.
- **TLS-MITM is a non-starter.** Shipping a CA cert that the Mac
  trusts means anyone with that key can impersonate every site.

Replaced with three smaller issues: #14 (Reader URL bar via
host-fetch + CORS-permissive sources), #15 (Mac-to-Mac AppleTalk
verbatim from Infinite Mac's existing relay — peer-to-peer between
visitors, no internet bridge), and a deferred "real internet"
milestone gated on solving SLIRP / ToS / abuse / iCab licensing.

### Epic #19 — Full in-browser IDE with C compilation (closed)

[#19](https://github.com/khawkins98/classic-vibe-mac/issues/19).
Killed by the five-reviewer pass.

- **Phase 2C requires a backend.** GitHub OAuth from a static
  site needs either Device Flow (terrible first-run UX) or a
  token-exchange relay (which IS a backend). PKCE doesn't help —
  GitHub's OAuth still requires a client secret.
- **Phase 2C requested `repo` scope.** Full read/write on every
  repo the user owns and is a collaborator on. Disproportionate
  for "compile my Hello Mac demo." Would have to be reframed as
  a GitHub App with fine-grained `contents:write` +
  `actions:write` per-repo.
- **Phase 3 silently assumed an in-browser HFS writer.** Doesn't
  exist anywhere in our stack. Today the boot disk is built by
  `hfsutils` in CI and shipped read-only. Every Phase 3 option
  needed _something_ to author HFS structures client-side.
- **Phase 1 is dead-weight without Phase 2.** github.com already
  renders source with highlighting, has a file tree, shows
  multiple files, offers download-as-zip. Shipping the same
  feature inside our own page is a worse github.com.
- **Option 2A (full Retro68 → WASM) is 4-9 engineer-months.**
  cc1 alone is ~25MB stripped native. Fork/exec emulation in
  Emscripten is the hard part. Out of scope as a single Epic.

Replaced with #21 (this Epic), which commits to **option 2F** as
surfaced by the compilation reviewer: Rez-in-WASM + precompiled
CRT + resource patcher. Covers ~70% of the emotional promise with
~5% of 2A's effort.

The lesson, to save the next person re-deriving it: **a full
in-browser IDE for classic Mac C is genuinely 4-9 engineer-months
of work**, dominated by porting GCC + the linker to WASM, _not_ by
the editor or the UI. If you want to revisit it, frame it as a
research spike with a ruthless time-box — not as a feature Epic.

### Epic #19 follow-up — we shipped the C compilation anyway, via a different path (2026-05-15)

The closure rationale above was correct **about the path it
assumed**: porting GCC from scratch into Emscripten was genuinely
4-9 engineer-months. What the post-mortem missed is that there's a
much shorter path: **don't reimplement Retro68's toolchain — just
wasm-compile the existing binaries.** Each tool (cc1, as, ld,
Elf2Mac) runs as a standalone Emscripten module, orchestrated from
JavaScript instead of via the GCC driver's fork/exec model. No
fork/exec emulation needed because each invocation is a fresh
`Module.callMain([…])`.

That work landed in [`wasm-retro-cc`](https://github.com/khawkins98/wasm-retro-cc)
over ~2 weeks (Phases 2.0 → 2.3d, May 2026) and integrated into
cv-mac's `compileToBin` in PRs #82 → #97. The final binary boots in
BasiliskII end-to-end as of 2026-05-15.

A few things still hold from the original closure:

- **OAuth / GitHub Pages backend issue is still real** — we ship
  `.bin` files as downloads (or hot-load via the in-memory HFS
  patcher), not commits back to your repo. The "edit in browser,
  PR to your fork" flow remains out of scope.
- **In-browser HFS writer was still needed** — solved separately
  via the template-splice patcher (#46) for Phase 3 hot-loading.
- **`cc1.wasm` is genuinely ~12 MB** — the size estimate was
  right; the 4-9 month effort estimate assumed we'd have to
  fork/exec-emulate it, which turned out unnecessary.

**Meta-lesson worth capturing:** when an Epic gets closed as
"infeasible," the closure rationale describes a *specific path*
being infeasible. A different path may exist. The trigger to
revisit a closed Epic is **"someone found a path the post-mortem
didn't consider"**, not "we have more engineer-months now." See
LEARNINGS Key Story #6 for the full retrospective.
