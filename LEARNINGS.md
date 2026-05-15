# Learnings

A running log of things we've learned building classic-vibe-mac — gotchas,
dead ends, surprises, and decisions worth remembering. The goal is to save
the next person (or future-you) from rediscovering the same lessons.

---

## Key stories — read these first

The handful of entries below are the *meta*-lessons that shape how every
subsequent piece of work on classic-vibe-mac should go. If you're new to
the codebase (or just back after a break) and only have time for one
file, this is the section to read.

They're narrative on purpose: the cost of skipping these isn't "you'll
miss a small gotcha", it's "you'll spend half a day discovering one of
these patterns the hard way and then ship the same fix that would have
been free if you'd known the pattern existed".

### 1. The m68k-runner harness story — *structural checks lie; build the harness early*

We spent ~7 hours one afternoon shipping six PRs that each fixed a real
toolchain bug and each one looked structurally clean to every test we
had — but the binary still silently exited at app launch on the
deployed BasiliskII. Every failure was *structural-pass-but-runtime-fail*.
The deploy-and-eyes-on cycle was 15-30 minutes per iteration; we ran
~10 of them before pivoting to building [a local m68k boot tracer](#2026-05-15--the-m68k-runner-harness-built-late-paid-for-itself-within-an-hour-now-the-backbone-of-toolchain-testing)
(`tools/m68k-runner/`). The MVP took ~90 minutes; it diagnosed the next
bug in its trace within 30 seconds of finishing the build. **General
rule:** when iteration cost is X minutes and you've done it N times
without convergence, tooling that takes N×X minutes to build has already
paid for itself in expected future iterations. We hit that threshold at
N=3 and didn't build until N≈7.

### 2. Ship-to-staging is the boot test — *headless can't simulate the runtime*

Before the harness existed, the only way to know whether a wasm-built
binary would actually run on the embedded BasiliskII was to deploy and
click. Headless Playwright probes of the emulator gave inconclusive
screenshots; structural inspectors passed for every broken binary in
the long chain. [The decision](#2026-05-15--in-browser-c-compile-and-run-ship-to-staging-is-the-boot-test-strategy)
to ship-to-staging-with-eyes was right *given the tooling we had at the
time*, but the right next move was always going to be replacing
ship-to-staging with the harness. **General rule:** when the
verification environment doesn't faithfully simulate the production
runtime, prefer staging-with-eyes over piling more layers onto the test
harness — *but recognise that as a temporary state* and plan the tooling
that closes the loop locally.

### 3. cc1.wasm (and the Retro68 toolchain in general) is not re-entrant

GCC's `main()` mutates static globals (most notably `decode_options`'
"output file already set" flag) and never resets them on exit.
Emscripten can't simulate process re-creation; the heap and statics
persist across `callMain` returns. **A second `Module.callMain([…,
"-o", "/tmp/out.s"])` on the same Module instance sees the prior call's
`-o` state and errors with "output filename specified twice".** This
was silently breaking every Show Assembly compile after the first since
#80 — the asm pane just kept showing stale-but-valid output, so users
didn't notice. [The fix](#2026-05-15--cc1wasm-and-the-retro68-toolchain-in-general-is-not-re-entrant):
instantiate a fresh Module per call; cache the wasm bytes and sysroot
blobs (cheap), not the Modules (expensive but unavoidable). **General
rule:** assume single-shot for C-runtime wasm binaries until proven
re-entrant. The Emscripten wrapper makes the API *look* re-entrant; the
underlying program almost certainly isn't.

### 5. The canonical-build diff is the highest-leverage diagnostic when bypassing the GCC driver — *use it first, not last*

Three days of "structural-pass-but-runtime-fail" bug-hunting on the in-browser C pipeline (cv-mac #82–#92, wasm-retro-cc#22–#26) culminated in a type-3 in production with no obvious cause. After 7+ deploy-and-eyes cycles and a Musashi harness that couldn't see past Retro68Relocate's first Toolbox call, the actual fix took **45 minutes** once we did the right diagnostic: pull the Retro68 docker image, run `m68k-apple-macos-gcc -v -save-temps -Wl,--verbose hello.c -o hello` on a known-working hello.c, and diff its tool invocations against ours.

**The fix was a single missing ld flag: `--emit-relocs` (`-q`).** Without it, ld applies relocation records in place and discards them — Elf2Mac then converts an ELF with no `.rela` sections into empty 2-byte 'RELA' resources, leaving libretrocrt's runtime relocator with nothing to apply. Any cross-segment pointer in the final binary still references its ELF virtual address (0x0000xxxx instead of the loaded 0x002000xx), and the first cross-segment call lands in low memory → type-3 address error at app launch.

The canonical build's collect2 invocation has `-elf2mac -q -undefined=_consolewrite` plain in plain sight — flags we'd never inferred from first principles. Comparing ELF sections via `objdump -h` showed the smoking gun: canonical had `RELOC` flag on `.code00001`/`.code00002`/`.data`, ours didn't. Comparing the resulting RELA resources via the m68k-runner harness made it visible-at-a-glance: canonical RELA 1 = 230 B (real relocations), ours = 2 B (empty terminator).

**General rule.** When you bypass the GCC driver (no CMake, no `m68k-apple-macos-gcc`, no `collect2`), you are off the documented path. The driver isn't a thin wrapper — it carries dozens of implicit flags, default library lists, link-script choices, and a post-processor wrapper for `Elf2Mac`. No published recipe describes "run cc1, as, ld, Elf2Mac as separate wasm modules from JS" because nobody had done it before us. **In that situation, the GCC driver's `-v` output IS the canonical recipe.** A 45-minute Docker pull + `gcc -v` capture + side-by-side diff is worth more than 10 deploy-and-eyes cycles.

This entry exists because we *didn't* do this first. We spent days bisecting one symptom at a time, each fix landing legitimately but failing to close the loop, because no individual fix would have closed the loop — the canonical recipe had several flags we were missing simultaneously. **Next time you're in a bypass situation: run the canonical build first.** Diff against ours. Treat every delta as a hypothesis. The fix that actually closes the loop is probably one of those deltas.

### 4. PROVIDE() in a Retro68 ld script silently overrides input-object symbols

Retro68's stock ld scripts (both `retro68-flat.ld` and the multi-seg
script Elf2Mac generates dynamically) define `_start` via `PROVIDE(_start
= .);` as a "fallback to a safe spot" — a bare `RTS`. The intent is
that when an input object defines `_start`, PROVIDE skips. In practice,
on bare-ld + `-T script` invocations (vs the compiler-driver path
that Retro68 normally uses), **PROVIDE wins even with `start.c.obj`
explicitly linked** — the script's PROVIDE fires during section
evaluation before archive scanning has fully unified symbols, and the
trampoline's `LONG(_start - _entry_trampoline - 6)` resolves to the
fallback's address. App launches, trampoline `RTS`-es to the fallback's
single-byte function, app exits without ever calling `main`.

We hit this **twice** — once on the [flat
script](#2026-05-15--link-startcobj-first-before-any-archive-else-main-never-runs)
(fixed in PR [#86](https://github.com/khawkins98/classic-vibe-mac/pull/86)
/ [wasm-retro-cc#23](https://github.com/khawkins98/wasm-retro-cc/pull/23))
and again on the multi-seg copy (which had the same PROVIDE line; fixed
in PR [#90](https://github.com/khawkins98/classic-vibe-mac/pull/90) /
[wasm-retro-cc#25](https://github.com/khawkins98/wasm-retro-cc/pull/25)
after the harness pinpointed the trampoline offset). **General rule:**
when patching a Retro68 ld script in your toolchain, **audit every ld
script in the bundle for the same `PROVIDE(_start)` line** — don't
assume the fix to one carries over to the others.

---

## How to use this file

- Add an entry whenever you hit something non-obvious: a quirk of Retro68, a
  CORS issue with the Infinite Mac CDN, an HFS tool that didn't behave as
  expected, a System 7 API gotcha, etc.
- Date each entry. Group by topic when patterns emerge.
- **If the lesson is foundational to *how* you'd debug things, not just
  one specific fix, also write it as a narrative under "Key stories"
  above.** Examples: "we should have built tooling earlier", "structural
  checks lie about behaviour", "this whole class of bug recurs".
- Keep regular entries short — a paragraph or two. Link to commits, PRs,
  or external docs for depth.
- It's fine to record negative results ("tried X, didn't work because Y").
  Those are often the most valuable.

## Format

```
### YYYY-MM-DD — Short title
**Context:** what we were trying to do
**Finding:** what we learned
**Action:** what we did about it (or chose not to)
```

For "Key stories" entries, drop the strict Context/Finding/Action
structure and write narrative paragraphs — they're memos to future-you,
not bug reports.

---

## Entries

### 2026-05-09 — Reader URL bar: `:Unix:` is the correct extfs write path; worker can't fetch()
**Context:** Implementing issue #14 (Reader URL bar). We needed Mac C code to write a
request file, and JS code to read it, fetch the URL, and write back the result.
**Finding:** Two distinct extfs volumes exist at runtime:
  - `:Shared:` — baked onto the HFS boot disk at build time; **read-only from JS** once the
    disk image is burned. Reader's `LoadDocument()` works here.
  - `:Unix:` — BasiliskII's live `extfs /Shared/` mount; **read/write at runtime** from both
    Mac (via HCreate/HOpen/FSWrite) and JS (via `activeFs.createDataFile()`). This is the
    correct path for the request/result ping-pong.
  The extfs volume name is always `Unix:` regardless of the path you pass in the `extfs`
  Basilisk pref — confirmed in `BasiliskII/src/extfs.cpp`'s `FSItem` root entry.
**Finding (2):** The emulator worker thread is stuck in `Atomics.wait` between blits; any
`fetch()` call inside it would never resolve (microtask queue is starved). The weather
poller pattern (fetch on main thread, postMessage bytes to worker) is the required approach
for all host-side network I/O.
**Action:** `shared-poller.ts` runs entirely on the main thread; the worker only handles
`poll_url_request` (read file) and `url_result_write` (write file) as short synchronous
FS operations. This is the canonical pattern for any future Mac↔JS data exchange.

### 2026-05-09 — Request-ID correlation prevents stale result files
**Context:** Reader URL bar needs to handle rapid URL submissions (user types fast, or
retries quickly).
**Finding:** Without a request ID, a result file from a previous fetch could be read by a
newer request. The fix: Mac writes `<monotonic-id>\n<url>\n` to the request file; result
files are named `__url-result-<id>.html`. The Mac only accepts a result whose ID matches
`gUrlRequestId`. JS uses `AbortController` to cancel in-flight fetches when a new ID
arrives.
**Action:** Both sides implemented in `reader.c` (LongToStr + WriteUrlRequest + CheckUrlResult)
and `shared-poller.ts` (AbortController + per-ID file naming).

### 2026-05-09 — Classic Mac dialog pattern: SetDialogDefaultItem / SetDialogCancelItem
**Context:** Implementing the "Open URL" modal dialog for Reader (DLOG 131).
**Finding:** After `GetNewDialog()`, you must explicitly call:
  - `SetDialogDefaultItem(dlg, 1)` to wire Return/Enter to button 1
  - `SetDialogCancelItem(dlg, 2)` to wire Escape/Cmd-. to button 2
  These are not automatic from the DITL layout — the Dialog Manager won't draw the
  default-button bold ring or handle keyboard shortcuts without these calls.
  `SelectDialogItemText(dlg, n, 0, 32767)` puts focus in an EditText item.
**Action:** Pattern documented in `reader.c`'s `DoOpenUrlDialog()`. Use the same three
calls for any future modal dialog with a text input field.

### 2026-05-09 — HCreate/HDelete before HOpen for file-write on `:Unix:`
**Context:** Mac side needs to write a new file (or overwrite an existing one) to `:Unix:`.
**Finding:** `HOpen(..., fsWrPerm, &refNum)` will fail with `fnfErr` if the file doesn't
exist. The correct sequence is:
  1. `HDelete(0, 0, path)` — silently succeeds even if the file doesn't exist.
  2. `HCreate(0, 0, path, creator, type)` — creates the file.
  3. `HOpen(0, 0, path, fsWrPerm, &refNum)` — opens it for writing.
  4. `FSWrite(refNum, &count, buf)` + `FSClose(refNum)`.
  Attempting to call `HOpen` on a path that doesn't exist returns `fnfErr` (-43).
  `dupFNErr` (-48) from `HCreate` is safe to ignore (file already exists from a previous
  run — `HDelete` should have removed it, but racing concurrent writes are benign to ignore).
**Action:** WriteUrlRequest() in `reader.c` follows this pattern. Any future Mac code that
writes to `:Unix:` should use the same sequence.

### 2026-05-09 — Color rendering investigation: `screen win/W/H` is correct and 32bpp
**Context:** Issue #48 asked us to verify that the BGRA→RGBA blit in `emulator-loader.ts`
was rendering correct hues. The user noted "colors might be a bit off."
**Finding:** The `copyAndSwapBgraToRgba()` function is correct — BasiliskII's WASM video
driver outputs 32bpp BGRA (big-endian Mac ARGB interpreted as little-endian bytes = B,G,R,A).
The swap `dst[R]=src[2], dst[G]=src[1], dst[B]=src[0]` is correct. The `screen win/W/H`
pref format (without explicit depth) is also confirmed correct: Infinite Mac uses the
identical format in their working reference implementation and their driver defaults to
32bpp. The SAB is sized `W×H×4` matching 32bpp. Any perceived "off" hue is most likely
gamma perception (Mac CRT ~1.8 vs modern sRGB ~2.2) — not a code bug.
**Action:** No code change needed. Issue closed as investigated/working-as-intended.

### 2026-05-09 — Copilot CLI v1.0.43 SEA binary: fork→spawn patch required for extensions
**Context:** The Copilot CLI ships as a Single Executable Application (SEA binary) on
v1.0.43. The extension SDK (`@github/copilot-sdk/extension`) calls `joinSession()` which
internally uses `child_process.fork()` to spawn the extension module. Inside a SEA binary,
`fork()` re-invokes the SEA, not a plain Node.js process — so the extension can never boot.
**Finding:** The fix is to monkey-patch `child_process.fork` to call `child_process.spawn`
instead, inside the CLI's `app.js` entry point at
`~/.copilot/pkg/universal/1.0.43/app.js`. Add this block before the main `require`:
```js
const cp = require('child_process');
const _fork = cp.fork.bind(cp);
cp.fork = (mod, args, opts) => cp.spawn(process.execPath, [mod, ...(args||[])], {stdio: 'inherit', ...(opts||{})});
```
v1.0.44 ships as plain Node.js and does NOT need this patch.
**Action:** Patch was applied to v1.0.43 app.js. Extensions in `.github/extensions/` will
activate on the next CLI restart. If upgrading to v1.0.44+, remove the patch from the old
binary (or just ignore it since the patched binary is not used).

### 2026-05-08 — Phase-2 precompiled `.code.bin` missing in production
**Context:** The Build button on the deployed playground was 404'ing on
`precompiled/<project>.code.bin`, killing the headline Phase-2 feature
in production even though local `npm run dev` worked fine.
**Finding:** The CI workflow had a step "Co-locate .code.bin precompiles
into web public/" whose comment claimed it ran BEFORE `npm run build` so
Vite would pick the files up via `publicDir`. It actually ran AFTER —
ordering nudged during a refactor, comment didn't follow. So vite's
`copyPrecompilesToPublic()` plugin found nothing (CI's artifact lives at
`artifact/build/` not `<repo>/build/`), the post-build copy populated
`src/web/public/precompiled/` after dist had already been written, and
the deploy artifact (`src/web/dist`) shipped without those files.
Locally the gap was invisible because a previous `cmake --build` had left
real files in `<repo>/build/<project>/<App>.code.bin`, so the vite
plugin DID copy them.
**Action:** Copy the `.code.bin` files directly into `src/web/dist/precompiled/`
*after* `npm run build`, the same pattern the workflow already uses for
`app.dsk` and `system755-vibe.dsk`. Two reasons over "just reorder":
(1) it bypasses the vite plugin entirely, so a future refactor of the
plugin can't break deploy again; (2) it parallels the disk-image step,
which is the reviewer's mental model for "CI artefacts that aren't
source assets".
**Generalisation:** If a step's comment says "must run BEFORE step X",
consider whether the step really needs to be before X — or whether
"after X, write straight to the X output dir" is a more robust pattern
that doesn't depend on ordering. Order-of-CI-steps is a load-bearing
invariant that nothing enforces; output-dir writes are checked by the
next step's `test -s` assertion.

### 2026-05-08 — MacWeather "(baked)" caption was misleading users
**Context:** Live-deployed MacWeather always rendered "(baked)" under
the timestamp even when the host page had successfully fetched
open-meteo (visible in network tab as HTTP 200). Code-side state
`gReadFromBoot` apparently never flips to false on the C side; the
JS-to-C signal path through the extfs `:Unix:weather.json` write isn't
currently surfacing freshness to the running app.
**Finding:** The caption is more harmful than helpful — users see
"(baked)" and think the live fetch failed, when in reality the data
above it is already live. The "Updated HH:MM" line on its own already
tells the user when the weather was refreshed; the freshness label is
redundant when right and misleading when wrong.
**Action:** Suppress the caption in `macweather.c` (Phase 3 owns the
JS poller fix; deleting the misleading caption is a C-side, no-conflict
way to stop the user-facing miscommunication). Phase 3 can reintroduce
a real freshness signal once the JS poller pipeline reliably surfaces
one. Big-picture lesson: a UI element that depends on a fragile
cross-process signal should fail invisibly, not display "everything is
broken" by default — render-nothing > render-wrong.
### 2026-05-08 — Playground Phase 3: HFS template-splice beats writing an encoder
**Context:** Phase 3 (Issue #21/#27) needed an in-browser way to take a
freshly-compiled MacBinary and turn it into a mountable HFS disk image
without any backend. The reviewer's load-bearing call: don't write a
real HFS encoder (1.5–2.5k lines, B-tree splits, extent overflow file,
catalog leaf rebalancing). Instead, ship a known-good empty volume as a
static asset and PATCH it.
**Finding:** The patcher came in at ~370 lines of TS
(`src/web/src/playground/hfs-patcher.ts`), of which ~120 are comments.
Three localized edits are sufficient for the "one app per disk" v1:
(1) append a cdrType=2 file record to catalog leaf node 1, (2) mark
N alloc-blocks used in the volume bitmap, (3) bump drFreeBks/drFilCnt/
drNxtCNID/drLsMod/drWrCnt in the MDB and copy to the alternate MDB.
Test infrastructure verifies byte-level round-trip equivalence with
hfsutils: the patched disk's file `hcopy -m`s back to a MacBinary with
the same resource fork bytes as we put in.
**Gotcha:** HFS catalog `keyLength` includes the trailing pad byte
(when present), not just the unpadded payload. IM:Files is ambiguous
on this; hfsutils' `libhfs/btree.c` is the authoritative reference.
Concrete: for "Reader" (6-char name) keyLength is 13, NOT 12. Got
this wrong on the first pass and `hcopy` failed with "unexpected
catalog record". Diff against an hfsutils-produced ground-truth disk
caught it instantly.
**Gotcha:** Adding a file requires bumping the ROOT DIRECTORY's
valence counter, not just appending the file record. Otherwise the
disk mounts but the Finder shows the volume as empty (the Finder
walks `dirVal` not the catalog leaf directly).
**Action:** Vendored `empty-secondary.dsk` (1.4 MB) as a static asset
under `src/web/public/playground/`. The patcher reads it, patches in
memory, and hands the bytes to the worker via a new `InMemoryDisk`
class that lives next to `ChunkedDisk`.

### 2026-05-08 — Worker reboot lifecycle: tear down the weather poller too
**Context:** Phase 3's `reboot(diskBytes)` path tears down the running
emulator session and spawns a fresh worker with the new secondary
disk. The existing `dispose()` killed the worker, the rAF loop, the
input wiring, and the visibility-pause controller — but missed one
thing.
**Finding:** `startWeatherPoller` returned a stop function from day
one (Phase 2), but `emulator-loader.ts` discarded it. After dispose,
the poller's setInterval kept firing into a terminated worker —
`worker.postMessage()` to a terminated port is silently dropped, but
the periodic fetch keeps hitting open-meteo every 15 minutes for the
lifetime of the page. Issue #29 was the trigger; the fix is to
return-and-track the stop function alongside the other teardown
steps.
**Action:** `ActiveSession` now owns `stopWeather` and `disposeSession`
calls it before `worker.terminate()`. New session re-arms the poller
in `boot()` so reboot keeps the live-weather flow working.

### 2026-05-08 — Playground Phase 2: do the C preprocessor in TypeScript, not in WASM
**Context:** Phase 2 of Issue #21 needed `#include` / `#define` / `#if` /
macro coverage for real Apple `.r` files. The spike's MiniLexer.cc
(`tools/wasm-rez/vendor/MiniLexer.cc`) skips lines starting with `#` —
fine for the trivial STR# case the spike validated, fatal for
`reader.r`'s 5 `#include`s.
**Finding:** The obvious play is "extend MiniLexer in C++". I went the
other way — implemented the entire preprocessor in TypeScript
(`src/web/src/playground/preprocessor.ts`) BEFORE the source hits the
WASM. The WASM only ever sees the post-preprocess slice (comments
stripped, includes inlined, defines substituted, conditionals already
resolved). Three things made this the right call:

1. **The WASM artefact stays stable.** No emsdk in CI's hot path,
   prebuilt blobs are committed under `src/web/public/wasm-rez/`.
   Vendoring is Track 1b of Issue #30. Faster turnaround on every
   future preprocessor improvement.
2. **The IDB-VFS bridge is naturally a JS concern.** `#include` has to
   resolve against IndexedDB user files plus a `RIncludes/` static
   asset bundle. Doing that through Emscripten's FS would be a
   bidirectional async-file callback nightmare; doing it in JS is just
   a `Map` lookup.
3. **Error reporting carries the include stack as text the editor can
   render directly.** `error-markers.ts` remaps a diagnostic on an
   included header to the `#include` line of the active buffer with a
   "in <file>:<line>:" prefix.

End-to-end validation: piping the TS-preprocessed reader.r and
macweather.r through the spike's mini-rez native build produces a
resource fork that's SHA-256-identical to native Retro68 Rez's output.
So the architectural pivot doesn't lose fidelity; it just moves the
preprocessor stage out of the WASM and into JS.
**Action:** Phase 2 ships the JS preprocessor. The agreed week-2
fallback (vendor mcpp as an additional WASM blob) is documented in
`tools/wasm-rez/README.md` for the day a real `.r` trips on
variadic macros, `#x` stringification, or `##` token-paste — none of
which our existing apps use.

### 2026-05-08 — `.code.bin` is misnamed: it's resource-fork-heavy, not data-fork-only
**Context:** Phase 2 spec for Issue #30 Track 7 said "splice the
freshly-WASM-Rez-compiled resource fork onto the precompiled `.code.bin`
(the data-fork-only intermediate)". I trusted the description and built
the splice as `header + data fork (from .code.bin) + new resource fork
(from WASM-Rez)`. First end-to-end test threw: "precompiled .code.bin
has rsrc=20460 (expected 0)".
**Finding:** Despite the name `Reader.code.bin`, the file is a *resource*
fork heavy MacBinary. Layout for our reader: data fork = 20 bytes (a
tiny CFM stub for PowerPC interop), resource fork = 20460 bytes
containing the real CODE 1, CODE 2, ..., DATA, RELA, BNDL, ICN#, FREF,
SIZE-from-toolchain, cfrg etc. resources. The user's `.r`-defined
resources (MENU, WIND, DITL, ALRT, STR#, vers) are NOT in `.code.bin`
— they get appended by the upstream CMake recipe via `Rez --copy
<code.bin>`. Reader.bin = Reader.code.bin's resource fork merged with
reader.r.rsrc.bin's resource fork.
**Action:** Implemented a real Mac resource fork merge in `build.ts`:
parse both forks (Inside Macintosh "Format of a Resource Fork"),
catenate the (type, refList, data) catalogs, user wins on (type, id)
collision, emit a fresh fork. Verified the result is structurally
identical to the on-disk `Reader.bin` (16 types, same per-type counts,
same fork header). The bytes differ in type ordering (insertion-order
vs alphabetical) and per-resource data offsets, but the Resource Manager
reads through the offsets so a `Reader.bin` produced by the playground
loads exactly like a `Reader.bin` produced by the toolchain.

### 2026-05-08 — WebAssembly under strict CSP needs `'wasm-unsafe-eval'`
**Context:** Phase 1's CSP was `script-src 'self'`. Phase 2's Build
button calls `WebAssembly.instantiate()` to load wasm-rez.{js,wasm}.
First page-load attempt threw `CompileError: WebAssembly.instantiate()
violates Content Security policy directive ... 'unsafe-eval' is not an
allowed source of script`.
**Finding:** Browsers treat WebAssembly compilation as eval-like. The
CSP3 `'wasm-unsafe-eval'` source-keyword specifically permits WASM
compilation while still blocking `eval()` proper. Browser support:
Chrome 102+, Firefox 116+, Safari 16+. Older browsers ignore the
unknown token and reject WASM with the same error — the playground's
Build button silently degrades on those.
**Action:** Added `'wasm-unsafe-eval'` to `script-src` in
`src/web/index.html`, leaving `unsafe-eval` itself off. Long comment
in the HTML explains the reasoning so the next agent doesn't widen
the carve-out.

### 2026-05-08 — Multiversal RIncludes are generated, not source: ship `Multiverse.r` umbrella + named stubs
**Context:** Phase 2 needed to vendor Apple's `.r` headers
(Processes.r, Menus.r, Windows.r, Dialogs.r, MacTypes.r) so reader.r /
macweather.r compile against them. First pass: copy
`/usr/local/share/Retro68/RIncludes/*.r` from a Retro68 install. We
don't have one in CI.
**Finding:** Those headers are emitted by `multiversal/make-multiverse.rb`
from YAML defs. Running Ruby in the playground's CI just to materialize
five files is overkill, and Ruby itself adds a ~200 MB CI dependency.
Meanwhile, the spike's `multiversal/custom/Multiverse.r` (300 lines,
hand-curated) already defines every type our two apps need — STR/STR#,
MENU, MBAR, WIND, DLOG, DITL, ALRT, vers, SIZE, ICN#, BNDL, FREF, cfrg,
rdes — and is byte-identical-output for the spike's smoke tests.
**Action:** Vendor `Multiverse.r` directly under
`src/web/public/wasm-rez/RIncludes/` and provide 5 one-line named stubs
(`Processes.r` etc.) that re-include it. `reader.r` / `macweather.r`
compile unchanged because to the preprocessor `#include "Menus.r"` and
`#include "Multiverse.r"` resolve to the same token stream. Total size
on the wire: 28 KB unpacked (well under the 600 KB / 80-150 KB gzipped
budget). If a future app needs a richer header surface, vendor the
generated multiversal output from a Retro68 install instead.

### 2026-05-08 — Emscripten's glue hardcodes the original CMake target name; remap via `locateFile`
**Context:** Renamed the prebuilt WASM artefact from the spike's
`mini-rez.wasm` to `wasm-rez.wasm` for naming consistency under
`src/web/public/wasm-rez/`. First Build click in the browser failed
with "expected magic word 00 61 73 6d, found 3c 21 64 6f" — i.e. the
fetch returned `<!do…` (an HTML 404 page).
**Finding:** Emscripten's JS glue (`wasm-rez.js`) embeds the WASM
filename it emitted from CMake — `mini-rez.wasm` — as a string and
fetches it relative to the document URL. Renaming the file on the
server doesn't help; the glue still asks for the old name.
**Action:** `locateFile` callback in the Module factory call remaps
`mini-rez.wasm` → `${baseUrl}wasm-rez/wasm-rez.wasm`. Documented
inline in `src/web/src/playground/rez.ts`. If the WASM ever gets
rebuilt with `--target-name wasm-rez` in the CMake config, the remap
becomes a no-op and can be deleted.

### 2026-05-08 — CodeMirror 6 needs `style-src 'unsafe-inline'`; theme rules ship as inline `<style>` tags
**Context:** Wiring strict CSP on the playground page (Phase 1 of Issue
#21). Started with `default-src 'self'; script-src 'self'; style-src
'self'; object-src 'none'; base-uri 'none'`. CodeMirror loaded but the
editor rendered without any of its theme — gutter colors, font, line
heights, selection background were all stripped.
**Finding:** CodeMirror 6's `EditorView.theme()` injects a generated
`<style>` element into the document head at construction time. The
browser blocks that under `style-src 'self'` because there's no nonce
and no hash. There is no documented way to feed CM a precomputed CSS
file as the theme — it needs to mutate styles when the document changes
size, when extensions reconfigure, etc. The same applies to the bundled
`@codemirror/view` core styles. Without `'unsafe-inline'` (or a
hash-based allowlist for every theme rule, recomputed on every CM
upgrade), CM is effectively unstyled.
**Action:** Allow `style-src 'self' 'unsafe-inline'`. Acceptable trade-off
for Phase 1 because (a) we ship no user-controlled style strings — every
inline style is generated from the bundled CM source, (b) `script-src
'self'` is still strict, which is where XSS lives, and (c) the editor
reviewer's scope cap doesn't gate on style-src tightness. Alternatives
considered: precomputed CSS file (CM team explicitly says no), runtime
nonce injection (would need an HTML transformer plugin in Vite, and
nonces leak in dev tools anyway), hash allowlist (brittle across CM
releases). Document the carve-out in `index.html` so the next agent
doesn't re-derive it.

### 2026-05-08 — Retro68 RIncludes ship no `Finder.r`; BNDL/FREF/ICN# must be raw `data` resources
**Context:** Adding the standard Finder-binding resource set (signature
+ BNDL + FREF + ICN# + STR ) to Reader so double-clicking `.html` files
on the boot disk would route to us instead of triggering the Finder's
"Could not find the application program …" dialog.
**Finding:** Apple's classic MPW Rez had `#include "Types.r"` macros that
defined the BNDL/FREF/ICN# resource types, so you could write
`resource 'BNDL' (128) { 'CVMR', 0, { 'ICN#', { 0, 128; 1, 129 }; … } };`
and Rez would emit the correct on-disk bytes. Retro68's RIncludes are
generated from the multiversal headers (`autc04/multiversal/defs/*.yaml`)
and **do NOT include any Finder.r resource type definitions** — multiversal
focuses on programmatic interfaces (FSSpec, AppleEvent calls, etc.) and
never carried the Finder resource macros. Trying to use the Apple-style
syntax fails at Rez parse time with "no type definition for 'BNDL'". The
multiversal repo doesn't have `Finder.r` either; it's just not part of
the toolchain.
**Action:** Write the BNDL/FREF/ICN# bytes longhand using `data 'TYPE'
(id, "label") { $"hex" };`. Inside Macintosh: More Macintosh Toolbox
p. 7-58 documents the wire format (signature[4] + sigID[2] +
typeCount-1[2] + per type: type[4] + count-1[2] + per mapping:
localID[2] + resID[2]). FREF is type[4] + localIcon[2] + Pascal-string
filename. ICN# is 128 bytes icon + 128 bytes mask. Once you have the
bytes the Finder doesn't care that Rez was bypassed.

Also: `add_application(Reader …)` in Retro68 defaults the binary's
MacBinary Type/Creator to `APPL/????`. The signature resource alone is
not enough — you have to pass `CREATOR CVMR` to `add_application` so
the `-c` flag reaches Rez when it builds the .bin. Without that, even a
correctly-crafted BNDL goes unbound because the Finder's binding is
keyed on the file's Type/Creator, not its resources.

**Verification trick:** After the boot-disk script runs,
`hls -l ":Shared:"` should show `TEXT/CVMR` for the HTML files (not
`????/????`), and `xxd -s 65 -l 8 build/Reader.bin` should print
`APPLCVMR` (offset 0x41 in the MacBinary header is type+creator).


<!-- Newest entries on top. -->

### 2026-05-08 — Network fetch must run on main thread; the WASM worker's microtask queue is starved
**Context:** MacWeather needs live weather JSON written into the Mac's
extfs-mounted `/Shared/` tree. First attempt: run the `fetch()` poller
inside the BasiliskII Web Worker (where `Module.FS` lives) so we could
write to the Emscripten FS directly.
**Finding:** The fetch network request goes out cleanly, but the
`then()`/`await` callback after the response arrives never fires. The
worker is busy: BasiliskII's idleWait calls `Atomics.wait` on the SAB
input lock between blits, blocking the worker until a UI event arrives
or the timeout (~16ms) expires. The microtask queue runs only between
event-loop turns, and `Atomics.wait` keeps the worker pinned in
`run-script` state — the fetch's response event handler queues a
microtask, but no event-loop turn happens to drain it. Net result: the
poller's first fetch hangs forever (visible: `[weather-poller] GET …`
log fires, no `received N bytes` follows).
**Action:** Run the poller on the main thread instead, where the page's
event loop has plenty of idle time between requestAnimationFrame
frames. The main thread posts `{ type: "weather_data", bytes }` to the
worker via `postMessage` (with a transfer list to avoid copy); the
worker's message handler writes the bytes into `FS` at
`/Shared/weather.json`. If the message arrives before preRun has
created `/Shared/`, we buffer in a module-scope array and replay on
preRun. This is also how Infinite Mac structures their persistent-disk
saver (UI thread does IndexedDB I/O, posts results to the worker).
Bonus: the main thread can use `navigator.geolocation` later if we want
real coords; the worker can't.

### 2026-05-08 — Vite dev needs `Cross-Origin-Embedder-Policy: credentialless` for cross-origin fetches
**Context:** Even with the poller moved to the main thread (above),
fetches to `api.open-meteo.com` were silently hanging in `npm run dev`.
**Finding:** Vite's dev server was sending
`Cross-Origin-Embedder-Policy: require-corp` (required for SAB).
`require-corp` blocks any cross-origin response that doesn't carry a
`Cross-Origin-Resource-Policy: cross-origin` header. open-meteo doesn't
emit CORP, so the network response is delivered but the renderer
refuses to surface it — fetch promise hangs forever, no error, no
console message. Production GH Pages avoids this by routing requests
through the `coi-serviceworker` shim, which intercepts the response and
rewrites the headers; in dev there's no SW.
**Action:** Switch the dev server header to
`Cross-Origin-Embedder-Policy: credentialless`. Same SAB guarantees,
but cross-origin fetches without credentials are allowed without CORP.
Production stays on `require-corp` via the SW shim. Belt-and-braces:
the fetch call uses `mode: "cors", credentials: "omit"` so the same
code path works in both contexts.

### 2026-05-08 — System 7 Startup Items: every app runs concurrently, but the LAST one launched is frontmost
**Context:** Multi-app boot: I want both Reader and MacWeather to
auto-launch on boot, both visible. First version: copy both .bin files
into `:System Folder:Startup Items:` and let Finder run them.
**Finding:** Mac OS 7's Finder DOES launch every Startup Item — they
run concurrently under cooperative multitasking — but the
last-to-launch wins front-most-app. Whichever app was most recently
sent `kAEOpenApplication` (or whose `WaitNextEvent` returned first
after launch) sits in front. With Reader and MacWeather both in
Startup Items, Reader's window covered MacWeather's nearly-completely;
only the bottom strip "Updated 12:00 (baked)" peeked out.
**Action:** Install only ONE app into `:System Folder:Startup Items:`
(the one we want frontmost on first boot — currently MacWeather, since
it's the live-data demo). Every other app goes into `:Applications:`
and the user double-clicks to launch. `scripts/build-boot-disk.sh`
takes a comma-separated `<app1.bin,app2.bin,…>` list; the LAST entry
goes to Startup Items. CI orders the list so the demo we want
front-most is last.

### 2026-05-08 — extfs `Unix:` volume isn't reliably mountable in System 7.5.5; bake samples onto `:Shared:` for first-boot reliability
**Context:** MacWeather opens `weather.json` from the extfs-mounted
`/Shared/` tree (BasiliskII surfaces it as `Unix:` per the existing
LEARNINGS entry). The JS poller writes `/Shared/weather.json` after
each fetch, so the file IS present in the worker's FS.
**Finding:** Iterating mounted volumes via `PBHGetVInfoSync` from
inside MacWeather returns only the boot disk and (sometimes) the
chunked app disk — the `Unix:` extfs volume isn't always in the VCB
chain. `HOpen(0, 0, "Unix:weather.json", …)` returns -35 (`nsvErr`,
"no such volume"). The volume name in upstream macemu IS "Unix" (per
the prior learning), but System 7's Finder isn't always picking up the
extfs mount. Couldn't pin down whether it's a timing issue
(volume mounts after our app starts), a Mount Manager issue (no `MNTR`
trap installed?), or a pref issue (`extfs /Shared/` vs `/Shared` —
checked both, no change).
**Action:** Two-tier read path. MacWeather first tries the live extfs
volume (`PBHGetVInfo` for "Unix" → `HOpen` with that vRefNum); if that
fails, falls back to `:Shared:weather.json` baked onto the boot disk
at build time by `scripts/build-boot-disk.sh`. The baked file is a
sane sample (Cupertino, May 8, 62°F) so first-boot demos work even if
extfs is wedged. The "live" plumbing is wired end-to-end and verified
working (worker logs `wrote N bytes`); fixing the System-7-side mount
is future work. UI shows `(baked)` or `(live)` next to the time so
the data source is visible.

### 2026-05-08 — extfs surfaces as Mac volume `Unix:`, not `Shared:` (bake :Shared: onto the boot disk instead)
**Context:** Reader was launching from Startup Items but logging "no
content found" — every `HOpen(0, 0, ":Shared:index.html", fsRdPerm, ...)`
call was failing. The premise from the earlier "Seeding the Shared Mac
volume" entry — that `extfs /Shared/` would expose `/Shared/` in the
Emscripten FS as a Mac volume named "Shared" — was wrong.
**Finding:** Read `mihaip/macemu/BasiliskII/src/Unix/user_strings_unix.cpp`:
the volume name is hard-coded.

```
{STR_EXTFS_CTRL,        "Unix Root"},
{STR_EXTFS_NAME,        "Unix Directory Tree"},
{STR_EXTFS_VOLUME_NAME, "Unix"},
```

Confirmed by `ExtFSInit()` in `BasiliskII/src/extfs.cpp`: the root FSItem's
guest name is `GetString(STR_EXTFS_VOLUME_NAME)`, with no override path.
Infinite Mac doesn't try to address the volume by Mac name either — they
treat `/Shared/Downloads` and `/Shared/Uploads` as host-side staging dirs
the BlueSCSI bridge consumes by inode, not as `:Shared:` paths from the
guest. Our Reader app, by contrast, opens by Pascal-string `:Shared:`,
which can never match a `Unix:`-named volume. The seed files were being
written into `/Shared/` correctly (FS.readdir confirms 5 files post-
preRun); they just appeared on the guest as `Unix:index.html`,
`Unix:about.html`, etc. — invisible to a `:Shared:` lookup.
**Action:** Pivoted to Option B from the brief — bake the HTML files
directly into the boot HFS image. `scripts/build-boot-disk.sh` now
copies `src/web/public/shared/*.html` into both `:Shared:` (boot volume
root) and `:System Folder:Startup Items:Shared:` (so the path works
regardless of what working directory Process Manager hands the app at
launch). The `extfs /Shared/` plumbing in the worker stays — it's still
useful for future Uploads/Downloads features where the guest-volume name
is irrelevant — it just no longer carries the Reader content. Local
verification: Reader displays "Welcome to Reader" with working links to
about/credits/inside-macintosh/lorem (see
`public/screenshot-shared-fix.png`). Things tried before pivoting:
trailing-slash variation in the `extfs` pref (`/Shared` vs `/Shared/`)
— irrelevant, the volume name is the bug; reading the upstream worker
postMessage handlers for a remount signal — no such thing exists. The
upstream "premise" was correct *for upstream* because no upstream
software reads from `:Shared:` by name.

### 2026-05-08 — Seeding the Shared Mac volume from JS via Emscripten FS
**Context:** The C-side Reader app (commit 46fe8c4) reads HTML files from
`:Shared:index.html`. We needed to wire BasiliskII's `extfs /Shared/` pref
(already in `BASE_PREFS`) so the host page's `src/web/public/shared/*.html`
files actually appear inside the emulated Mac as a volume named `Shared`.
**Finding:** No special FS mount call is needed. Confirmed against
`mihaip/infinite-mac@30112da0db` `src/emulator/worker/worker.ts` — they do
exactly `FS.mkdir("/Shared")` + `FS.createDataFile(parent, name, bytes,
true, true, true)` inside the Module's `preRun` hook, and BasiliskII's
extfs picks the contents up at boot when MacOS scans the volume. Since
`preRun` is synchronous (cannot await), the bytes have to be fetched
*before* the dynamic `import(coreUrl)` runs and then handed in via a
closure variable. The HTML files seed once per page load; updates after
boot would require ejecting/remounting the volume.
**Action:** Added `sharedFolder.files` to `EmulatorConfig`, pass it
through the start message, fetch the bytes alongside the ROM, and write
them to `/Shared/<name>` in `preRun`. Failures per-file are non-fatal —
Reader has its own "no content" fallback. End-to-end visual verification
of the Reader UI itself is blocked: CI for `feat/html-viewer` is currently
red (the Reader C compile fails on `Controls.h` not found in the Retro68
container) so we can't pull a fresh `app.dsk` with the Reader binary in
its Startup Items. The locally cached disks still contain the old
Minesweeper boot. JS-side wiring type-checks clean and the worker logs
the seed count; once the C-side CI is green and a Reader-bearing
`app.dsk` lands, the volume should appear in the Mac without further
changes.

### 2026-05-08 — Mouse/keyboard input requires the main thread to participate in the cyclical lock
**Context:** After the modelid-30 fix the emulator boots cleanly to the
desktop with Minesweeper open, but the in-emulator cursor refused to
track the host cursor and clicks landed nowhere. The bomb dialog from
earlier rounds had a Restart button that wouldn't respond either.
**Finding:** Our `emulator-input.ts` was writing event slots
(`mousePositionFlagAddr`, `mouseButtonStateAddr`, etc.) directly into
the SharedArrayBuffer with no synchronization. The BasiliskII worker,
ported from Infinite Mac, expects a four-state cyclical lock at
`globalLockAddr`: `READY_FOR_UI_THREAD (0) → UI_THREAD_LOCK (1) →
READY_FOR_EMUL_THREAD (2) → EMUL_THREAD_LOCK (3)`. The worker's
`acquireInputLock` is a `compareExchange(2, 3)` — it only succeeds when
the UI side has released the lock by storing `2`. We never did. So the
worker's lock acquisition perpetually failed, no input was ever read,
and the cursor hardware state inside BasiliskII never updated.
**Action:** Rewrote `emulator-input.ts` to mirror upstream
`SharedMemoryEmulatorInput` (mihaip/infinite-mac@30112da0db
`src/emulator/ui/input.ts`): a small queue, a coalescing drain that
acquires the lock with `compareExchange(0, 1)`, writes events with the
same conventions as upstream's `updateInputBufferWithEvents` (notably
`mouseButtonState = -1` for "no change", per-cycle), then releases with
`Atomics.store(2)` + `Atomics.notify`. Also: per-event
`getBoundingClientRect()` (the rect can change), CSS-px → emulator-px
scaling (canvas.width / rect.width), `setPointerCapture` so menu drags
that wander out of the canvas still get the matching pointerup, and a
fresh mousemove enqueued before each mousedown so the press lands at
the live cursor position. Loader (`emulator-loader.ts`) now hands the
SAB to the input layer via `setInputBuffer(buffer)` instead of the old
`setBufferAdapter` callback shape. Local verification: Apple menu
pulls down on click, cursor follows movements across the canvas.

### 2026-05-08 — `modelid` in BasiliskII prefs is `gestaltID − 6`, not the gestalt itself (was likely the bomb)
**Context:** Round-3 of the "unimplemented trap" investigation. Prior
rounds ruled out the C code, the resource fork, and the resource layout.
The remaining hypothesis was "Quadra-650 ROM lacks Toolbox traps Retro68
references" — the recommended single-iteration fix was to swap to a
later 68k ROM. Investigated swap candidates first.
**Finding (ROM swap rejected):** Infinite Mac at the pinned commit
(`30112da0db`) ships exactly **one** 68040-class ROM:
`Quadra-650.rom`. The other 68k ROMs they vendor are all OLDER:
Mac-IIfx (1990, 68030), Mac-II/IIx (1987-88, 68020), Mac-Plus/SE/Classic
(68000). The "Universal" / Quadra-840AV / Performa-588 ROMs that would
have a more complete trap table are not in the upstream tree, and
sourcing them from elsewhere would mean an unpinnable URL of
unverifiable provenance. So a single-iteration ROM swap from Infinite
Mac was not actually available. **Did NOT change the ROM.**
**Finding (real bug):** While reading
`mihaip/macemu/BasiliskII/src/prefs_items.cpp` and `rom_patches.cpp` to
work out the modelid for alternative ROMs, found that the BasiliskII
`modelid` pref is documented as "Mac Model ID (**Gestalt Model ID minus
6**)". The implementation (`patch_rom_32`) writes the raw modelid into
ROM at UniversalInfo offset 18 (`productKind`), and the Gestalt selector
reports back `productKind + 6`. Cross-checked against Infinite Mac's
own config layer (`src/emulator/common/emulators.ts`):
`emulatorModelId(type, gestaltID) => gestaltID - 6`. **Quadra 650 has
gestaltID 36, so the correct modelid is 30 — not 36.** Our worker had
been hardcoding `modelid 36`, which made Gestalt report machine type
42, which is not a valid production Mac. System 7.5.5 selects which
INITs to load and which Toolbox patches to install based on Gestalt
machine type; an unknown machine type skips a meaningful chunk of the
patch ladder. Several of those patches install traps Retro68's C
runtime calls during pre-`main()` startup. A patch that doesn't install
leaves an A-line vector pointing at the "unimplemented trap" handler.
That's exactly the dialog we see.
**Action:** Changed `modelid 36` → `modelid 30` in
`src/web/src/emulator-worker.ts`, with an inline comment explaining the
−6 offset. ROM stays Quadra-650.rom; `cpu 4` (68040) stays;
`fetch-emulator.sh` is untouched.
**Verified locally:** Built the Vite bundle, copied the boot disk +
chunks into `src/web/dist/`, ran `vite preview`, and screenshotted
with Playwright (`public/screenshot-debug-rom.png`). System 7.5.5
boots cleanly and **Minesweeper actually launches and renders its
window** with the 10×10 grid and "Mines: 10 :)" UI. No bomb. The
Quadra-650 ROM was never the problem — three rounds of bisection
were chasing a wrong-gestalt artifact. Lesson: when porting an
emulator config, copy the formula (`gestaltID − 6`), not the constant.

### 2026-05-08 — `hls -l` columns are `rsrc data`, not `data rsrc` (rsrc fork was fine all along)
**Context:** Working hypothesis after rounds 1+2 was that `hcopy -m` was
silently dropping the resource fork. The CI log line
`f  APPL/????      7011         0 May  7 23:42 Minesweeper` was being
read as "data=7011, rsrc=0", which would explain the bomb (no SIZE
resource → Process Manager bombs). Plan was to round-trip through
Retro68's own `Minesweeper.dsk`, then assert the rsrc fork is non-zero.
**Finding:** Reproduced locally with the CI artifact's `Minesweeper.bin`
on macOS hfsutils. The columns in `hls -l` per its man page are:
`<type-flag>  <TYPE>/<CREATOR>  <rsrc-bytes>  <data-bytes>  <date>  <name>`.
So "7011 0" actually means **rsrc=7011, data=0** — exactly what an APPL
should look like (resource-fork app, empty data fork). Verified by
extracting back to MacBinary and checking the header rsrc-length field
at offset 0x57: `00 00 1b 63` = 7011 bytes. Forks survive `hcopy -m`
byte-perfect; only the MacBinary CRC at 0x7A-0x7B differs across
round-trips. **The resource fork was never the bug.** The "unimplemented
trap" bomb is somewhere else — most likely one of the round-2 entry's
hypotheses (Retro68 runtime startup before main, SIZE flag combinations,
ROM trap-table mismatch, or Type/Creator handling by Finder).
**Action:** (1) Added a defensive rsrc-fork assertion to
`scripts/build-boot-disk.sh` (correctly reading column 3 as rsrc, column
4 as data) so future regressions in the copy pipeline fail loudly
instead of silently. (2) Restored full Minesweeper from the .bak files
since the bisection's hello-world isn't useful — the bug isn't in the
app code or in the resource layout, it's upstream. (3) Did NOT change
the copy mechanism — `hcopy -m` is working correctly. The
"copy-via-Retro68-.dsk" round-trip was tested and produces identical
on-disk forks (same APPL/????, same 7011-byte rsrc), so it would not
have changed anything. (4) Next investigation should follow round-2
hypotheses 1, 4, 5: try a different ROM (Universal/Quadra-840AV vs
Quadra-650), or compile the official Retro68 "console" sample
byte-for-byte and see if it bombs in our pipeline. If the Retro68
sample boots cleanly, copy whatever it does; if it bombs too, the
bug is in the BasiliskII/ROM/SDK combination.

### 2026-05-08 — Bisection round 2: even SIZE-only + NewWindow bombs (NOT in our code)
**Context:** Round 1 hello-world bombed (preceding entry). Round 2
went one step further: dropped the `WIND` resource entirely, created
the window from C with `NewWindow(NULL, &rect, "\pHello",
true, documentProc, (WindowPtr)-1L, true, 0L)`, and stripped the .r
file to just `vers` and `SIZE -1`. C source is now ~30 lines of pure
textbook Toolbox init + `WaitNextEvent`.
**Finding:** Same bomb. Identical "unimplemented trap" dialog at the
exact same moment in launch. Proof: `public/screenshot-helloworld.png`
(latest). This **rules out** the suspect surface in our app code and
resource fork. The C is now too small to hide a bug, and the .r file
is too small (vers + SIZE) to carry one. Whatever Toolbox call is
hitting the unimplemented trap, it happens during the Retro68 C
runtime startup BEFORE main() — or, equivalently, it happens during
Process Manager / Finder launch of the app driven by the SIZE
resource flags or the .bin Type/Creator. Most likely culprits, with
investigation order for the next agent:

  1. **Retro68 runtime + the Quadra-650 ROM trap table.** Retro68's
     C startup (the code that runs before main) sets up an A5 world,
     calls `MaxApplZone` / `MoreMasters` itself, may register
     exception handlers, and may reference Toolbox calls that
     post-date the 1992 Quadra-650 ROM. Specifically suspect:
     `_HWPriv` (Power Manager), `_FSDispatch` (FSSpec / new file
     manager — only on System 7.0+ ROMs, but with selectors that
     vary), `_SysEnvirons` (System 7), or AppleEvent dispatch.
     The Quadra-650 shipped with System 7.1; the boot disk is
     System 7.5.5 which patches the trap table on boot, but the
     patches happen *after* INIT load — if our app launches
     BEFORE the System 7.5.5 patches finish, we're effectively
     running against the raw 7.1 trap set. Run our app NOT from
     Startup Items but from a manual double-click after the
     desktop is fully up, and see whether the bomb still fires.
     This is the highest-value cheap experiment.
  2. **The `.bin` Type/Creator inside the boot disk.** Verify with
     `hls -l ':System Folder:Startup Items:Minesweeper.bin'` that
     Type=APPL and Creator is a real 4-char code (not `????` and
     not `BINA`). If `hcopy -m` left the file as MacBinary
     (Type=BINA, Creator=mBIN), the Finder would try to open it
     with StuffIt Expander, which doesn't exist on this disk,
     and the resulting error path could surface as the bomb we
     see. The `hcopy -m` flag is supposed to strip MacBinary back
     to two-fork — confirm it actually did.
  3. **SIZE flag combinations.** Try the absolute minimum SIZE:
     just `is32BitCompatible` + memory partition; drop suspend/
     resume, background, HLEvent flags entirely. The
     `acceptSuspendResumeEvents` bit makes the Process Manager
     post osEvts to us — if our event handling is broken in some
     way the Process Manager doesn't tolerate, that could trigger
     a Toolbox call we don't expect.
  4. **Try Retro68's "console" sample** (the official hello-world
     that ships with the toolchain) byte-for-byte. If THAT bombs
     in our pipeline, the bug is in the pipeline (boot disk
     packing, Type/Creator, SIZE, ROM choice) — not in any C we
     write. If it works, copy what it does.
  5. **Switch ROMs.** Quadra-650.rom is the most-common Infinite
     Mac default but it's old (1992). A "Universal" ROM (later
     Quadra/Performa) has a more complete trap table. This is a
     `prefs` file change in `src/web/src/emulator-worker.ts` and
     a re-fetch.

The hello-world is what's currently deployed; the demo page shows
the bomb under "Hello" rather than "Minesweeper", which is no
worse than before. Originals preserved at
`src/app/minesweeper-full.{c,r}.bak` for restoration once the
upstream bug is found and fixed.

### 2026-05-08 — Bisection round 1: hello-world ALSO bombs with "unimplemented trap"
**Context:** Following up the previous "Minesweeper bombs" entry. Bisected
by replacing `src/app/minesweeper.{c,r}` with the smallest possible
Toolbox app: `InitGraf` / `InitFonts` / `InitWindows` / `InitMenus` /
`TEInit` / `InitDialogs(NULL)` / `InitCursor` / `MoreMasters() x4`,
then `GetNewWindow(128, ...)` from a single `WIND` resource, then
`WaitNextEvent` loop drawing `\p"It works."` in the update event.
Resource fork stripped to `WIND 128`, `vers 1`, `SIZE -1` (256K min,
512K preferred, `not32BitCompatible`, `notHighLevelEventAware`). No
`MBAR`/`MENU`/`ALRT`/`DITL`/`STR#`. Originals preserved as
`src/app/minesweeper-full.{c,r}.bak`.
**Finding:** Same bomb. The deployed page boots System 7.5.5 cleanly,
Finder runs through Startup Items, launches our `Minesweeper.bin`,
and immediately bombs with "Sorry, a system error occurred —
unimplemented trap." Proof: `public/screenshot-helloworld.png`. Since
the C source is now ~30 lines of textbook init + `WaitNextEvent` and
the .r file is three resources, the bomb cannot be in the
Minesweeper-specific code. The bug lives in one of: (a) the Retro68
runtime startup itself (the C runtime that runs *before* `main()` —
sets up the A5 world, registers exception handlers, etc.), (b) the
`SIZE -1` flag combination triggering a Finder/Process Manager call
the Quadra-650 ROM doesn't implement, (c) something about how the
`.bin` is decoded into the boot disk by `hcopy -m` (e.g. wrong
Type/Creator), (d) a version mismatch between Retro68's link-time
assumptions (System 7.5+? CFM-68K? Apple Event Manager?) and the
ROM's actual trap table. Of these, (d) is the most plausible: the
"unimplemented trap" bomb specifically means the CPU hit an A-line
trap (high nibble 0xA) whose entry in the trap dispatch table is
unimplemented. That's a Toolbox call the ROM doesn't ship.
**Action:** Documented and stopped per scope (one round of bisection,
user is asleep). Hello-world is what's currently deployed. The
demo page now shows a bomb under "It works." instead of under
Minesweeper, but that's no worse than before. Next bisection step
recommendations for the morning, in order of cheapness:
  1. **Strip even further: no resource file at all.** Move the
     window creation to `NewWindow()` with a hardcoded `Rect`, no
     `GetNewWindow`. Drop the .r file from the build entirely. If
     this also bombs, the bug is in Retro68's runtime/launch, not
     in any code we wrote.
  2. **Try `_Debugger`-style instrumentation.** Add a `DebugStr`
     call as the first line of `main()` (before any Toolbox call).
     If the bomb fires *before* the DebugStr triggers, the runtime
     is crashing before main. If after, it's a specific Toolbox
     call.
  3. **Check the `.bin` Type/Creator.** Run `hls -l` on the
     installed file inside the boot disk and confirm Type=`APPL`
     and Creator=4 chars (not the default `????`). Wrong
     Type/Creator can make Finder treat the file as a document
     and try to open it with an app that doesn't exist.
  4. **Recompile against the System 7.0 / 7.1 SDK headers** if
     Retro68 supports it — the current build may be linking
     against System 7.5+ symbols that the ROM in question
     (Quadra-650, ~1992) genuinely doesn't have.
  5. **Use a different ROM.** The Quadra-650 ROM is from 1992
     and shipped with System 7.1. Switching to a "Universal"
     ROM image (Quadra-840AV, Performa-style) would expand the
     trap table. This is an emulator-config change, not an app
     change.
  6. **Look at Retro68 issue tracker** for "unimplemented trap"
     bug reports. Other people have hit this; the fix is usually
     either a missing init call, a SIZE flag bit, or a specific
     compiler/linker flag (e.g. `-mcpu=68000` vs `-mcpu=68020`).

### 2026-05-08 — End-to-end deploy works; Minesweeper bombs with "unimplemented trap"
**Context:** First successful deploy to GH Pages with the chunked boot
disk, fixed `hls` Mac-path bug, BasiliskII coming up cleanly. Took a
live screenshot.
**Finding:** The full pipeline runs: page loads, COOP/COEP service
worker installs, page reloads cross-origin-isolated, BasiliskII
instantiates, ROM is read, first frame paints, System 7 boots, Finder
runs through Startup Items and **launches our Minesweeper.bin** — at
which point a classic Mac bomb dialog appears: "Sorry, a system error
occurred. unimplemented trap." That's a runtime crash *inside* our
demo app, not a pipeline problem. The proof is in
`public/screenshot-deployed.png`.
**Action:** Documented as the headline TODO on the deployed page and
in the README. Likely candidates for the bug: (a) a Toolbox call the
Quadra-650 ROM doesn't implement (we should check
`TrapAvailable(_WaitNextEvent)` and similar before calling), (b) a
missing `MoreMasters()` early in `main`, leaving the Memory Manager
short on master pointers, (c) a `.r` resource ID collision (e.g.
`SIZE -1` vs Finder defaults), (d) a `GetNewMBar(128)` call returning
NULL because resources didn't load. Bisecting by ripping minesweeper.c
down to a "draw a window, sleep on WaitNextEvent" hello-world is the
fastest way to localise this — out of scope for the overnight session,
queued for follow-up.

### 2026-05-08 — `hls /` is wrong; hfsutils takes Mac-style paths
**Context:** The first deployed build's boot disk step was failing
silently — the `|| {` guard around `build-boot-disk.sh` swallowed an
exit-1 and the chunked manifest never got written, so the loader
stayed in STUB mode on Pages.
**Finding:** `hls -a /` returns "no such file or directory" because
hfsutils paths are Mac-style — the volume root after `hmount` is `:`
or the empty string, NOT `/`. `/` is interpreted as a path on the
SCSI device's namespace and resolves to nothing.
**Action:** Dropped the leading `/` on both `hls -a` calls in the
sanity-check block of `scripts/build-boot-disk.sh`. The next deploy
emitted `dist/system755-vibe.dsk.json` + 96 chunks and the loader
fetched them cleanly.

### 2026-05-08 — BasiliskII WASM init contract: ported, boots
**Context:** Following up the previous "init contract is huge" entry —
actually doing the port. Goal was a minimum-viable shim that drives the
vendored .wasm to first frame.
**Finding:** The full Infinite Mac worker (~900 lines + 6 sibling
files) covers things we don't need: audio worklets, clipboard,
ethernet, file uploads, CD-ROMs, persistent IndexedDB savers, speed
governor, delayed disks, fallback-mode service worker bridges. A
stripped-to-the-bone port comes in around 480 lines
(`src/web/src/emulator-worker.ts`) and is enough to:
1. Allocate the SharedArrayBuffers the WASM expects (32bpp
   framebuffer, videoMode Int32, input ring at the offsets in
   `InputBufferAddresses`).
2. Read a chunked disk over synchronous XHR (the WASM calls
   `disk.read()` synchronously from inside Wasm, so we can't await
   `fetch()`).
3. Render BasiliskIIPrefs.txt + appended config (`rom Quadra-650.rom`,
   `cpu 4`, `modelid 36`, `ramsize 16777216`, `screen win/640/480`,
   `disk system755-vibe.dsk`, 7 placeholder disks, `jsfrequentreadinput
   true`) into the Emscripten FS at `/prefs`.
4. Stage `Quadra-650.rom` (1MB, fetched alongside the .wasm via
   `fetch-emulator.sh`) at `/Quadra-650.rom`.
5. Pass `["--config","prefs"]` as the Module's `arguments`.
6. Expose `globalThis.workerApi` shaped to match upstream
   `EmulatorWorkerApi` (the WASM ABI calls into it by name from
   Wasm-land — the names are not negotiable).

The Emscripten module is `MODULARIZE`'d ESM with `EXPORT_NAME=emulator`;
import as `await import('/emulator/BasiliskII.js')`, then call
`mod.default(moduleOverrides)`. Because we already have the `.wasm`
ArrayBuffer in hand, we hand it to Emscripten via `instantiateWasm` to
skip a redundant fetch.
**Action:** Verified end-to-end: the worker imports the BasiliskII ESM,
the WASM instantiates ("Basilisk II V1.1 by Christian Bauer et al."),
the ROM loads, `didOpenVideo` fires, the framebuffer paints. With a
fake (mostly-zero) disk image you get the classic "no bootable disk"
screen — flashing floppy/question-mark — proving the framebuffer +
boot loop are correct. With a real System 7.5.5 image (built by
`scripts/build-boot-disk.sh`) the path forward is just "feed it real
chunks." Subtle: never `mount.innerHTML = ""` once the canvas is in
place — every status update afterwards has to be console-only or it
wipes the canvas. Worker file uses `/// <reference lib="webworker" />`
so `DedicatedWorkerGlobalScope` types resolve under our DOM-only
`tsconfig.json`. coi-serviceworker is vendored at
`src/web/public/coi-serviceworker.min.js` and loaded as a non-module
script before the app script in `index.html` so production GH Pages
becomes cross-origin-isolated on the second navigation.

### 2026-05-08 — BasiliskII WASM init contract: not single-file, not CDN-pluggable
**Context:** Trying to wire `bootDiskUrl` so the page actually boots.
The previous LEARNINGS entry ("Boot disk plumbing") established that
Infinite Mac doesn't host a public single-file boot disk. Path forward
seemed to be either chunk it ourselves or ship a single `.dsk`. Read
`mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12`'s
`src/emulator/worker/worker.ts`, `src/emulator/worker/disks.ts`,
`src/emulator/worker/chunked-disk.ts`, and
`src/emulator/common/common.ts` to find the actual init contract.
**Finding:** The compiled BasiliskII Emscripten Module does NOT accept
a single-file disk URL. ALL disk access flows through their
`EmulatorWorkerChunkedDisk` (or a pluggable `EmulatorWorkerDisk`
interface implementing `read`/`write`/`size`/`name`), and that runs
inside a Web Worker that exposes a `globalThis.workerApi` of type
`EmulatorWorkerApi`. That class wires video (shared-memory or
fallback), input (shared-memory or fallback), audio, files, clipboard,
ethernet, disks, plus a `BasiliskIIPrefs.txt` file written into the
Emscripten FS and a 32-byte device-image header generated per disk.
The `EmulatorWorkerConfig` also takes a `wasm: ArrayBuffer`, a
`workerId`, a `dateOffset`, an `arguments: string[]` for the prefs
file, etc. Wiring all of that is on the order of hundreds of lines of
TypeScript. There is no shortcut; the .wasm was compiled with a
specific init contract and it's the contract.
**Action:** Decision: we ship the **disk** and **chunking** plumbing
now (paths A/B precursor work), but stay in honest STUB mode in the
loader because the init contract isn't ported. The disk flows through
`scripts/build-boot-disk.sh` (download → mount → inject Minesweeper
into `:System Folder:Startup Items:` → optional chunking via
`scripts/write-chunked-manifest.py`). When the worker-glue port lands,
the disk and chunks are already deployed; that PR only has to add the
worker, the EmulatorWorkerApi shim, and the prefs template. Reference
upstream paths are pinned in comments at
`src/web/src/emulator-loader.ts` boot()-phase 3 so the next agent can
pick up the trail without re-deriving.

### 2026-05-08 — Boot disk: build our own (System 7.5.5 from archive.org)
**Context:** Decision point on Path A (single bootable disk),
Path B (chunked manifest), or Path C (defer). Path B is the "right"
answer for the WASM init contract but requires the same worker port
either way (see preceding entry). Path A turns out to be incompatible
with the current .wasm but is still the cheapest *prep* work to do
now, because chunking a single .dsk is a 30-line Python script.
**Finding:** A bootable, pre-installed System 7.5.5 hard-disk image
(`Macos.dsk`, 24 MB) is hosted on the Internet Archive at
`https://archive.org/details/macos755_202104`, packaged for use with
MinivMac/BasiliskII. The System Folder is already blessed, the Finder
is already in place, and there's a `Startup Items` folder ready to
populate. hfsutils' `hcopy -m` decodes our Retro68 MacBinary back into
a real two-fork file with Type/Creator preserved, so dropping
Minesweeper in is a single command. Apple's 2001 free-redistribution
posture for System 7.5.3 (and the 7.5.5 updater) covers redistribution
of these binaries; mainstream archives have been mirroring them
openly on this basis for 25 years. License/attribution lives in the
new `NOTICE` at the repo root.
**Action:** `scripts/build-boot-disk.sh` downloads (with cache + SHA
verification + retry-on-302), mounts via `hmount`, lists/inspects via
`hattrib` and `hls`, copies via `hcopy -m`, unmounts, and writes
`dist/system755-vibe.dsk`. CI caches the upstream blob across runs via
`actions/cache@v4` so we hit archive.org once per cache-key bump, not
on every push. The SHA-256 pin in the script is a placeholder for now
— first successful CI run will print the observed hash to be locked
in (tracked as a Risk in PRD). The `--chunk` flag invokes
`scripts/write-chunked-manifest.py` (algorithmic port of Infinite
Mac's `write_chunked_image()`) to emit the chunked manifest format
the WASM consumes; this isn't wired in CI yet because there's no
loader to consume it, but the script is dependency-light (python3
stdlib only) and ready when the worker port lands.

### 2026-05-08 — Boot disk plumbing: System 7.5.5 has no public single-file URL
**Context:** Wiring BasiliskII WASM into the page. Plan was to point the
emulator at something like `https://infinitemac.org/disks/system-7.5.5.json`
as a boot disk URL.
**Finding:** Infinite Mac doesn't serve disk images as single files. The
boot disk is a *chunked* file: a build-generated JSON manifest
(`@/Data/System 7.5.5 HD.dsk.json` — NOT in the repo) lists ~190
SHA-named chunk filenames, which the worker fetches incrementally from a
private Cloudflare R2 bucket (`infinite-mac-disk`) routed through
system7.app / macos8.app / etc. There is no documented public URL
pattern, no GitHub-hosted copy, and the manifest itself is a build
artifact of Infinite Mac's pipeline (run via `scripts/import-disks.py`
against an Apple-provided System 7.5.5 image). Confirmed by reading
`src/emulator/common/common.ts` (`generateChunkUrl`),
`src/emulator/ui/config.ts` (`configToMacemuPrefs`),
`src/defs/disks.ts` (`SYSTEM_7_5_5.generatedSpec`), and the
top-level `wrangler.jsonc` (`r2_buckets: [{bucket_name:
"infinite-mac-disk"}]`) at infinite-mac@30112da0.
**Action:** Set `EmulatorConfig.bootDiskUrl = null`. The loader fetches
the WASM core successfully (real bytes, period-styled progress bar in
`.inset`), then enters a STUB phase that renders "Welcome to Macintosh"
and an explanation inside the marketer's window chrome. Path forward, in
order of effort: (1) generate our own chunked manifest from a System
7.5.5 ISO via Infinite Mac's `scripts/import-disks.py` and host the
chunks under `/disks/` on GH Pages (~150MB across many small files —
within Pages limits, lazy-loaded by chunk index); (2) ask upstream for a
stable public URL pattern; (3) ship a single-file System 7.5.5 .dsk and
recompile BasiliskII WASM with the non-chunked disk path enabled.
Recommend (1). This is the project's biggest remaining unknown for
end-to-end "boot in the browser."

### 2026-05-08 — BasiliskII WASM is GPL-2.0, not Apache-2.0
**Context:** Updating fetch-emulator.sh to vendor LICENSE/NOTICE files
alongside the binaries. The role brief and earlier PRD framed the
relevant license as Apache-2.0.
**Finding:** Infinite Mac's TypeScript glue is Apache-2.0, but the
compiled BasiliskII core is built from
`mihaip/macemu/BasiliskII/COPYING`, which is GPL-2.0. That means
redistributing the .wasm — which we do, by serving it from GH Pages —
inherits GPL-2.0 §3 obligations (corresponding source must be available
on request). Linking the upstream macemu commit satisfies the offer-source
obligation as long as we don't modify the binary.
**Action:** `scripts/fetch-emulator.sh` writes a NOTICE file calling out
both licenses and pinning the upstream commit + macemu repo. The
`src/web/.gitignore` ignores the .wasm/.js but explicitly negates
`LICENSE-infinite-mac` and `NOTICE` so they always travel with the
binaries in `dist/`. A downstream fork that wants to recompile BasiliskII
needs to vendor the macemu source (or otherwise satisfy GPL §3 itself).

### 2026-05-08 — GitHub Pages can't set COOP/COEP; SAB needs a service-worker shim
**Context:** Wiring the GH Pages deploy job for the Vite-built web frontend.
BasiliskII WASM needs `SharedArrayBuffer`, which the browser only exposes
in a cross-origin-isolated context (requires the response to carry
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`).
**Finding:** GitHub Pages serves a fixed set of headers and offers no way
to configure custom response headers — there's no `_headers` file equivalent,
no `web.config`, nothing. Confirmed by the long-running
`isaacs/github` Pages issues and several upstream Emscripten threads. Vite's
own dev server sets the headers (see `src/web/vite.config.ts`), so it works
locally; production breaks silently when the emulator tries to allocate a
`SharedArrayBuffer`.
**Action:** Workaround is `coi-serviceworker` — a tiny service worker that
re-fetches the page and injects the COOP/COEP headers on the way back, so
the second load is cross-origin-isolated. There's a Vite plugin wrapper. The
emulator-integration-engineer owns wiring it in; the build pipeline only
flags the constraint via an inline comment in the deploy job and a note in
PRD.md Component 4. If coi-serviceworker proves flaky, fallback is to host
on Cloudflare Pages (`_headers` file) or Netlify (`netlify.toml`) — both let
you set arbitrary response headers, GH Pages can't.

### 2026-05-08 — Use the official Pages actions, not gh-pages branch pushes
**Context:** PRD originally said "deploy to gh-pages branch." Decision point
on which deploy mechanism to use.
**Finding:** GitHub now ships first-party
`actions/upload-pages-artifact` + `actions/deploy-pages` actions that
publish via the Pages "environment" (not via a long-lived branch). They
handle the OIDC handshake, surface the deploy URL on the run summary, and
play nicely with environment protection rules. The third-party
`peaceiris/actions-gh-pages` and the npm `gh-pages` package are both still
common but require either a PAT or write access to a `gh-pages` branch and
miss the environment integration.
**Action:** Use the official actions in `.github/workflows/build.yml`. Repo
must have Pages enabled with "Source: GitHub Actions" in the repo settings —
this is a one-time manual step per fork. Document this in README when the
template-polish milestone lands. Concurrency group `pages-${{ github.ref }}`
with `cancel-in-progress: false` to avoid wedging deploy-pages mid-publish.

### 2026-05-08 — Chicago web font: no clean CDN, fall back to a stack
**Context:** Building the landing page chrome to feel period-authentic. The
role brief suggested ChicagoFLF (GPL) or "Chikarego" as the header font.
**Finding:** ChicagoFLF is real and GPL-licensed, but there is no canonical
CDN that serves it — the usual sources are personal GitHub repos and
abandonware archives, none of them pinnable in good conscience for a
template that other people will fork. Chikarego is similarly hosted in
fragmented places. Loading either properly means vendoring the .woff2 plus
its LICENSE/NOTICE into `src/web/public/fonts/`.
**Action:** For now we punt: `src/web/src/style.css` uses
`"Chicago", "ChicagoFLF", "Charcoal", "Geneva", -apple-system, ...`. Visitors
who happen to have Chicago installed locally see it; everyone else gets
Geneva, Helvetica, or the system sans. If we want the period look
guaranteed, the next step is to vendor a GPL-clean Chicago `.woff2` under
`src/web/public/fonts/` with a `LICENSE.txt` alongside, and wire an
`@font-face` rule. Logged so we don't accidentally pull a shady CDN copy
later.

### 2026-05-08 — Installing hfsutils inside the Retro68 container
**Context:** Wiring `scripts/build-disk-image.sh` into `.github/workflows/build.yml`
as a follow-on step to the CMake build. The script needs `hformat`/`hmount`/
`hcopy` from the `hfsutils` Debian package, which is not preinstalled in
`ghcr.io/autc04/retro68:latest`.
**Finding:** The Retro68 image is Debian-based and the GH Actions job runs as
root inside the container, so plain `apt-get update && apt-get install -y
hfsutils` works — no `sudo` (sudo isn't even installed) and no extra repos
required. `hfsutils` is in Debian main. The package is small (≈100KB) so the
install adds negligible CI time. Critically, do NOT install `hfsprogs`
instead — that's HFS+ tooling (`mkfs.hfs` there builds HFS+), and Basilisk
II / classic Mac OS through 8.0 only read HFS. Mounting an HFS+ image
silently fails on the emulator side.
**Action:** Added an "Install hfsutils" step in `build.yml` before the CMake
configure step, with an inline comment calling out the hfsutils-vs-hfsprogs
trap. The disk-image step itself runs `./scripts/build-disk-image.sh
build/Minesweeper.bin dist/app.dsk` after the build, and `dist/app.dsk` is
appended to the existing workflow artifact alongside the Retro68 outputs.

### 2026-05-07 — Retro68 distribution: Docker image, not tarballs
**Context:** Setting up CI to cross-compile a Mac 68k app. PRD suggested either
prebuilt Retro68 tarballs or a Docker image; we needed to pick one.
**Finding:** autc04/Retro68 has not published a tagged release since v2019.8.2
(Aug 2019), and those releases ship no asset binaries — just source. The
project's actual distribution channel is the rolling Docker image
`ghcr.io/autc04/retro68:latest`, rebuilt automatically on every commit to
Retro68 master. README and real-world workflows (manufarfaro/armadillo-editor,
ClassiCube, schismtracker) all use the Docker image.
**Action:** Use `container: ghcr.io/autc04/retro68:latest` in build.yml. No
toolchain caching needed — GH Actions pulls and caches the image automatically,
and avoiding a from-source toolchain build saves ~1 hour per cold run.

### 2026-05-07 — Retro68 .APPL artifact may be 0 bytes
**Context:** Deciding which build outputs to upload as workflow artifacts and
later release assets.
**Finding:** `add_application(Foo foo.c)` produces several outputs: `Foo.bin`
(MacBinary, both forks), `Foo.dsk` (mountable HFS image with the app inside),
and `Foo.APPL`. The `.APPL` is the data fork only — for resource-only apps
it's literally 0 bytes, which crashes the GitHub Releases upload API.
**Action:** Treat `.bin` and `.dsk` as the canonical artifacts. We still
upload `.APPL` to the workflow artifact (the zip wrapper is fine with 0-byte
files), but anything that hits the Releases API later must use `.bin`/`.dsk`
only. Verify step in build.yml uses `test -s` on `.bin` and `.dsk` only.

### 2026-05-07 — Retro68 toolchain file path
**Context:** Wiring up CMake `-DCMAKE_TOOLCHAIN_FILE=...`.
**Finding:** The path inside the Docker image is
`/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake`
(note the `m68k-apple-macos/cmake/` segment — older snippets sometimes show
a flatter `toolchain/m68k-apple-macos.cmake` path that doesn't exist in
current builds). The PPC equivalent lives at
`powerpc-apple-macos/cmake/retroppc.toolchain.cmake` if we ever pursue the
OS 9 stretch goal.
**Action:** Hardcoded the m68k path in build.yml and the comment block in
src/app/CMakeLists.txt.

### 2026-05-07 — "Startup Items" only auto-launches from the boot volume's blessed System Folder
**Context:** PRD plan was to ship a tiny secondary `app.dsk` containing a
`Startup Items` folder, mount it next to Infinite Mac's CDN-hosted System 7.5.5
boot disk, and let the app auto-launch on boot.
**Finding:** In classic Mac OS (System 7 through 9.2.2), Startup Items is a
Finder convention tied to the *active blessed* System Folder on the boot volume.
The Finder scans exactly that one folder at login and launches its contents.
A `Startup Items` folder on a secondary mounted disk has no special meaning —
it's just a regular folder. So the current architecture (boot from CDN disk +
mount our secondary `app.dsk`) will not auto-launch by itself.
**Action:** `scripts/build-disk-image.sh` still places the binary in a
`Startup Items` folder on the secondary disk (so the structure is right for
future work), but we need one of these to actually trigger auto-launch:
  1. Inject the app into the boot disk's System Folder/Startup Items at
     emulator-config time (requires writable boot disk or an overlay).
  2. Make our disk the bootable one (ship a minimal blessed System Folder on it,
     or merge with a System 7.5.5 image at build time).
  3. Have the web layer drive Basilisk II to open the app post-boot
     (no real automation hook in BasiliskII WASM, so this is the weakest option).
Option 1 or 2 is the path forward. Logged so the next agent doesn't spend a
day debugging "why doesn't my app launch."

### 2026-05-15 — The m68k-runner harness: built late, paid for itself within an hour, now the backbone of toolchain testing

**Context.** From the morning through afternoon of 2026-05-15 we shipped six PRs (cv-mac #82–#88, wasm-retro-cc #22–#25) attempting to make wasm-built `.bin` files actually boot in BasiliskII. Each one fixed a real bug — cc1 re-entrancy, missing `start.c.obj`, PROVIDE overrides, missing libgcc, missing SIZE resource, flat-vs-multi-seg ld script — and each one looked structurally clean to every test we had: `inspect_macbinary.py` passed, `npx playwright test` was green, `npx tsc --noEmit` was clean, the bundle deployed without warnings. The bug only revealed itself when Ken hard-refreshed the deployed Pages site, double-clicked the WasmHello app, and described what he saw on screen — a 15-30 minute round trip per iteration. We ran ~10 of those.

**The trap.** Every failure was *structural-pass-but-runtime-fail*. The toolchain produced a binary whose shape — type, creator, CODE 0/CODE 1 byte layout, resource fork header magic, jump table size, A5 world dimensions — looked right at every layer except *did the CPU actually do something useful when this was launched on a real Mac*. None of our checks tested that.

By PR #87 we'd already been bitten three times in a row by this pattern. We should have built the harness then. Instead the sunk-cost logic of "the next fix is probably the one" kept the deploy-and-eyes-on cycle going. Each individual fix felt close enough to the answer that building tooling felt like overhead.

**The trigger.** When Ken asked "is there no way to simulate building binaries on our local and simulating execution without having to actually go through this whole loading them up inside of an emulator?" — and followed up explicitly with "should we pivot to local testing now?" — that broke the inertia. We parked the live debugging, filed [cv-mac #89](https://github.com/khawkins98/classic-vibe-mac/issues/89) with the full design rationale, and built the MVP in ~90 minutes.

**Build vs. payoff.**

  - Vendored [Karl Stenerud's Musashi](https://github.com/kstenerud/Musashi) (~4.4 MB of MIT-licensed 68k CPU emulator) + `softfloat/`.
  - Wrote `tools/m68k-runner/runner.c` — 240 lines that parse MacBinary II, set up an A5 world from CODE 0, point the m68k PC at the entry trampoline, run for a cycle budget, and log every instruction + every A-line trap.
  - Configured Musashi's `M68K_INSTRUCTION_HOOK = M68K_OPT_SPECIFY_HANDLER` so the per-instruction callback links directly into our hook.
  - `make` builds in ~5 seconds. `./m68k-run path/to/hello.bin --trace --max=100` runs in milliseconds.

**Round 1.** First binary I ran through the harness — the freshly-deployed multi-seg bundle, the one whose eyes-on test showed silent-exit — produced this trace within seconds of finishing the build:

```
[trace] 00200006  6100    sp=00ffffec [sp]=0020000a   ← BSR pushes return addr
[trace] 0020000a  0697    sp=00ffffec [sp]=00200010   ← ADDI added 6 (PROVIDE
                                                          fallback offset),
                                                          should have been 0x258c
[trace] 00200010  4e75    sp=00fffff0 [sp]=00000000   ← RTS pops 0 (not _start)
[trace] 00000000  00ff    sp=00ffffec [sp]=27000000   ← PC = 0, executing garbage
```

That trace immediately revealed: the multi-seg ld script's `PROVIDE(_start = .)` line was *still* winning over libretrocrt's `_start`, the same bug wasm-retro-cc#23 patched in the flat script but didn't repeat in the multi-seg copy. **The harness paid for its build cost (~90 min) on its first run** — what would have been the next 30-minute eyes-on cycle became 30 seconds.

**Forward value.** Every subsequent toolchain change can now be Musashi-tested before any deploy. Future Retro68 upgrades, ld script changes, libgcc updates, SIZE-resource changes, even C++-runtime additions — all become testable against a known-good baseline trace in seconds. The deploy-and-eyes-on loop is still ground truth for "does it visibly do the right thing on the user's screen" (we wouldn't catch a `DrawString`-to-wrong-port bug without it), but it's no longer the *only* loop. The harness rules out 80%+ of the failure space before we burn a deploy on it.

**The general rule for next time.** When iteration cost is **X minutes** and you've done it **N times** without convergence, tooling that takes **N × X minutes** to build has already paid for itself in expected future iterations. Don't wait until N is much larger. We hit that threshold around N=3 (PR #87) and didn't build until N≈7. The cost of *not* building tooling compounds non-linearly with how many distinct bug layers exist — each new layer was undetectable until the previous one was fixed, so the first ~4 PRs felt like they should have closed the loop but the 5th, 6th, and 7th were the ones that actually mattered, and we couldn't tell which would be the last from the inside.

**Auxiliary benefits** that emerged from this build:

  1. **Traces are the dispositive evidence in PR descriptions.** [wasm-retro-cc#25](https://github.com/khawkins98/wasm-retro-cc/pull/25)'s body has 4 lines of trace showing exactly which instruction goes wrong — far more informative than "binary still crashes type-3" or "still silent exit", and lets a reviewer audit the fix without needing to run anything.
  2. **The harness surfaces audit gaps.** Building the harness *and asking it* "what does CODE 1's trampoline immediate look like?" immediately revealed that the multi-seg script also had the PROVIDE trap. Without the trace, that script would have remained the suspect-but-unverified piece for another deploy cycle.
  3. **The Musashi-MVP exit reasons map cleanly to "where in startup we got":** *trampoline jumps to PC=0* means PROVIDE won; *Retro68Relocate range fault* means relocations are broken; *trap @ InitGraf* means we're past startup and into Toolbox. Each is a distinct, immediately-actionable signal.

**Mature state.** Today's MVP has no Toolbox stubs (A-line traps are logged and skipped), no LoadSeg, no Process Manager — sufficient for startup-time diagnosis (the failure modes that motivated the build), insufficient for full behavioral checks. [cv-mac #89](https://github.com/khawkins98/classic-vibe-mac/issues/89) tracks the expansion list: LoadSeg stub, the ~12 most-used Toolbox traps, a minimal heap simulator, OCR-like assertions on captured `DrawString` calls. Each expansion is opportunistic — pulled in when a concrete bug needs it, not built speculatively.

**This entry is the story of the harness because the *meta*-lesson matters more than the bug-by-bug LEARNINGS above.** If a future agent reads only one entry in this file before starting toolchain work, this one should be it: **build the harness early; structural checks lie; eyes-on is ground truth but expensive; tooling that closes the loop in seconds rewards a few hours of investment many times over.**

### 2026-05-15 PM — The type-3 was a missing `--emit-relocs` flag, diagnosed in 45 minutes via canonical-build diff

**Context.** Multi-day debugging of "structural-pass-but-runtime-fail" in the in-browser C pipeline (cv-mac #82–#92, wasm-retro-cc#22–#26) hit a wall: even after fixing PROVIDE(_start), the multi-seg ld script, SIZE resource splicing, libgcc inclusion, section-name selectors for `_start`, etc., **production still bombed with a type-3 address error at app launch**. Each prior fix was legitimate. None of them, individually or together, closed the loop.

The Musashi harness ([cv-mac #89](https://github.com/khawkins98/classic-vibe-mac/issues/89)) had run out of diagnostic depth — it could verify the trampoline reaches `Retro68Relocate`, but couldn't see what happened next without an unbounded investment in Toolbox stubs (Resource Manager, Memory Manager, low-memory globals, OS trap dispatch, LoadSeg, …). [cv-mac #95](https://github.com/khawkins98/classic-vibe-mac/pull/95) added a first batch of stubs but the harness's diagnostic horizon still ended at the first GetResource call.

**The diagnostic that actually worked.** Per [cv-mac #96](https://github.com/khawkins98/classic-vibe-mac/issues/96): pull the `ghcr.io/autc04/retro68:latest` Docker image, build the SAME `wasm-hello/hello.c` inside it with `m68k-apple-macos-gcc -v -save-temps -Wl,--verbose -o hello.code.bin hello.c`, and **side-by-side every flag against our pipeline.**

The result, in three layers:

1. **GCC `-v` output** showed the canonical collect2 invocation explicitly:
   ```
   collect2 -plugin liblto_plugin.so … -elf2mac -q -undefined=_consolewrite -o hello.code.bin \
     -L<sysroot>/lib hello.o --start-group -lgcc -lc -lretrocrt -lInterface --end-group
   ```
   The flag we were missing: `-q` (short for `--emit-relocs`).

2. **`objdump -h` on the ELF** confirmed the consequence. Canonical ELF: `.code00001`, `.code00002`, `.data` all had the `RELOC` flag. Ours: same sections, **no `RELOC` flag**. ld had applied the relocations in place and discarded them, because we hadn't asked it to keep them.

3. **The Musashi harness's resource listing** made the runtime impact visible. Canonical RELA 1 = 230 B (real relocation entries); ours = 2 B (empty terminator). At runtime libretrocrt's `Retro68Relocate` walks the RELA resource to fix up cross-segment pointers. With 230 B of real entries, fix-up works and `main()`'s first cross-segment call lands on real code. With 2 B of nothing, every cross-segment pointer still references its ELF virtual address (0x0000xxxx), so the first such call jumps to low memory → type-3 address error.

**The fix.** One line added to `compileToBin`'s ld argv:

```ts
"--emit-relocs",
```

After the fix, the rebuilt binary has byte-identical resource layout to the canonical: 12544 B total, 8 CODE segments, RELA 1 = 230 B, RELA 2 = 5 B, RELA 3–8 = 2 B each (empty for segments with no relocs). Musashi harness runs cleanly through `_start`, into `Retro68Relocate`, with PC staying within CODE 1 — no low-memory wandering.

**Meta-lesson (also captured at the top of this file as Key Story #5).** When you bypass the GCC driver (no CMake, no `m68k-apple-macos-gcc`, hand-rolled cc1 + as + ld + Elf2Mac orchestration from JavaScript), **the canonical build's `-v` output is your specification.** It's free. It's exact. It's *already correct*. There's no shortcut that beats it. Three days of bug-by-bug diagnosis would have collapsed to one afternoon if we'd run the diff first.

**The reason we didn't run the diff first** is that the diff-first move *felt* like overhead. Each individual bug we found was real, each fix was justified, and at any moment the next deploy felt like it would close the loop. The cost of building diagnostic infrastructure feels speculative when the next experiment feels close enough. **It almost never is.** When you've been wrong N times in a row about "the next deploy will fix it", treat that as load-bearing evidence that your mental model is incomplete and only an external source of ground truth (the canonical build, the original spec, the working reference) can close the gap.

### 2026-05-15 — `_start` ended up in `.code00002` because file-form ld selectors don't match standalone `.o` files

**Context.** After fixing the multi-seg-PROVIDE bug ([wasm-retro-cc#25](https://github.com/khawkins98/wasm-retro-cc/pull/25)), the binary still crashed at launch — CHK error in BasiliskII's bomb dialog. The Musashi harness once again earned its keep: dumped the linker map and showed `.text._start 0x00002554 0x4c /sysroot/lib/start.c.obj` placed under `.code00002`, not `.code00001`.

**Why that's fatal.** The entry trampoline (laid out at the top of `.code00001` by the ld script) does a relative `BSR+ADDI+RTS` to reach `_start`. The relative jump assumes target is in the same segment. When `_start` lives in `.code00002`, the trampoline computes an address as if it were in CODE 1, hits unmapped memory, dies.

**Root cause.** The script's `.code00001` filters for the entry code are archive-form:

```
*/libretrocrt.a:start.c.obj(.text)
*/libretrocrt.a:start.c.obj(.text.*)
```

These match `start.c.obj` *only when ld sees it as an archive member*. Our pipeline (and cv-mac's `compileToBin`) extracts a standalone `/sysroot/lib/start.c.obj` and passes it explicitly on the ld command line — so ld treats it as a standalone object, and archive-form filters don't match. `.text._start` falls through every selector until `.code00002`'s catch-all `*(.text.*)` claims it.

The link map shape gives this away: archive-loaded files appear as `libretrocrt.a(start.c.obj)`; standalone-loaded files appear as `/sysroot/lib/start.c.obj` — *no parentheses*. Same source object, different formatting; the script's selector syntax distinguishes them.

**What didn't work.** Tried adding file-path-form selectors (`*/start.c.obj(.text.*)`, `*start.c.obj(.text.*)`, `/sysroot/lib/start.c.obj(.text.*)`) inside the same SECTIONS block. None matched — the link map didn't even list them. GNU ld silently ignored file-path-form selectors that have no archive separator when mixed with archive-form selectors in the same script. Disorienting; the manual implies either form should work. In practice, **don't mix**.

**Fix that worked.** Switch to **section-name** selectors, which are file-agnostic:

```
*(.text._start)
*(.text._start.*)
```

Added above the archive catch-all in `.code00001`. Pulls `.text._start` whether `start.c.obj` reaches ld as an archive member or as a standalone object.

Shipped as [wasm-retro-cc#26](https://github.com/khawkins98/wasm-retro-cc/pull/26). cv-mac vendored bundle re-synced.

**Diagnostic gotcha caught along the way.** When you ask ld for a link map via `-Map=/tmp/link.map` while running ld through Emscripten's `Module.callMain`, the map gets written to the **Module's MEMFS**, not the host's `/tmp`. I lost a round of diagnosis reading a stale host-side `/tmp/link.map` from a previous run, thinking my filter changes had no effect. Always `Module.FS.readFile("/tmp/link.map")` and write it back to the host fs before reading.

**General rules added.**

1. **For runtime-required symbols that must land in a specific output section, prefer section-name selectors (`*(.text._start)`) over file-name selectors.** File-name selectors are fragile to how the object reaches ld.
2. **The link map's input-section listing is authoritative about which selectors matched.** If a selector you wrote doesn't appear there, ld silently rejected it. Don't trust the script syntax; trust the map.
3. **Don't mix archive-form and file-path-form selectors inside the same SECTIONS block.** Pick one. Section-name selectors avoid the question entirely.

**Pattern.** The Musashi harness diagnosed this in ~30 seconds (read the map, see the symbol address, compare against segment boundaries). Without it: another 30-minute deploy + eyes-on cycle, then guessing. This is the second time in a single afternoon the harness paid for itself. Reinforces the meta-lesson above.

### 2026-05-15 — Missing SIZE resource crashes libretrocrt startup with type-3
**Context:** After landing #86 (the ld-script + start.c.obj + libgcc fixes from wasm-retro-cc#22/#23), eyes-on test on deployed Pages showed a *new* failure mode: the app launches and immediately quits with a type-3 (illegal instruction) dialog. Same crash regardless of `main`'s body — including `int main(){ return 0; }` and `int main(){ while(1); return 0; }` produce identical type-3 dialogs with different binary SHAs (the compile sees source, the runtime can't survive startup).

**Finding:** Without a `SIZE` resource (`-1`) in the application's resource fork, the Mac OS Process Manager allocates the app a default tiny heap. libretrocrt's `Retro68Relocate` — the first non-trivial thing `_start` calls — fixes up runtime relocations and allocates working memory; on the tiny default heap it runs out of room and writes past the end, producing the type-3 trap before `main()` is ever invoked.

The Retro68 reference binary `hello-toolbox-retro68.bin` ships a `SIZE` resource generated by Rez from a project `.r` file via the CMake `add_application` macro. Its content:

```
SIZE -1: 10 bytes
  bytes: 00 80 00 10 00 00 00 10 00 00
  flags=0x0080 preferred=1048576 (1 MB) minimum=1048576 (1 MB)
```

Our in-browser pipeline doesn't run Rez for `rezFile === null` projects (today: only `wasm-hello`). The cv-mac splice path for `.r`-driven projects also doesn't currently generate a SIZE for projects whose `.r` doesn't define one.

**Action:** Added `makeRetro68DefaultSizeFork()` to `src/web/src/playground/build.ts` — a 320-byte hand-crafted resource fork containing exactly the reference's `SIZE -1` payload. `runBuildInBrowserC` now splices it onto the wasm-built binary via the existing `spliceResourceFork` helper. Regression test in `tests/e2e/playground-size-splice.spec.ts` parses the spliced output's resource fork and asserts the SIZE bytes match the reference verbatim.

**Why hand-crafted and not Rez-generated:** SIZE is fixed 10 bytes for any application using libretrocrt's defaults; running an entire wasm-rez compile to produce 10 bytes of static content would be ~30× the code path for zero benefit. The hand-craft also keeps the splice path purely synchronous + no extra wasm modules. If we later want per-project SIZE (different memory requirements), the same helper can read the bytes from a project field.

**General rule:** Mac classic apps with non-trivial C-runtime initialization need a SIZE resource. The Process Manager's default heap (~8 KB on early System versions, marginally larger on 7.5.5) is enough for assembly-only apps that don't allocate; it is NOT enough for any C app that uses libc or relocates globals.

### 2026-05-15 — Link `start.c.obj` first, before any archive (else `main` never runs)
**Context:** First eyes-on test of in-browser `Build & Run` on `wasm-hello`. App launched (zoom-rect animation, no crash dialog), then disappeared in milliseconds. SysBeep test produced no beep. Bare-loop test (`for (volatile long i = 0; i < 2e8; i++) ;`) exited just as fast — `main` was never running at all. Pasting invalid syntax did surface a compile error in the panel, so the compile path was definitely seeing user edits; the failure was downstream.

**Finding:** Extracted CODE 1 from the offending `.bin` and walked the entry trampoline's `ADDI.L #imm, (A7)` immediate to locate `_start`. The bytes there were `4e 75` — bare m68k `RTS`. That's the **`PROVIDE(_start = .)`** *fallback* from `retro68-flat.ld`:

```
PROVIDE(_start = .);
Retro68InitMultisegApp = .;
SHORT(0x4e75); /* rts */
```

Reference build's `hello-toolbox-retro68.bin` has libretrocrt's real `_start` (`LINK A6, #-8; MOVE.L #imm, D0; …`) at that offset.

Why ours doesn't pull the real one: **GNU ld's archive search is symbol-driven** — it pulls a `.o` from a `.a` only when an unresolved symbol references it. Our `in.o` defines `main` and references nothing in libretrocrt, so the archive scan never reaches `start.c.obj`. The script's `PROVIDE(_start = .)` then *defines* `_start` (as the fallback RTS) during script evaluation, `ENTRY(_start)` is satisfied, link succeeds — and the resulting binary's `_start` is a bare RTS. Launching the app jumps to that RTS and exits cleanly. `-u _start` *should* have forced the search but didn't — PROVIDE fires during script eval before archive search completes.

The Retro68 ld driver handles this implicitly by passing `start.c.obj` (or its equivalent crt setup) as an explicit input file *before* the script processes the PROVIDE. Bare ld doesn't.

**Action:** Three things together (all on wasm-retro-cc#22; the bundle vendoring + bridge update is this PR):

1. **Ship `libretrocrt.a:start.c.obj` as a standalone `.o`** in the bundle (extracted at bundle build time). The cv-mac bridge passes it to `ld` ahead of any `.a`, satisfying `_start` before the script's PROVIDE can fire.
2. **`--start-group … --end-group`** around the archives. Once start.c.obj is pulled it transitively references atexit / malloc / exit / etc., which cross-reference between libretrocrt / libc / libgcc. Single-pass scan misses these; the group forces iterative scanning.
3. **Add `libgcc.a` to the bundle.** libretrocrt's `syscalls.c` uses `__udivsi3` / `__mulsi3` (m68k has no native 32-bit divide; the compiler emits soft-fp helpers). The Retro68 ld driver auto-adds `-lgcc`; bare ld doesn't.

After: `while(1);` source produces a `.bin` with `below_a5=1400` (vs reference's 1428; was 76), real libretrocrt code at `_start`, and CODE 1 grows from 40 B to 7548 B. Within 2 % of the Retro68 reference's structural fingerprint.

**Rule of thumb:** when linking via `ld` directly (not through a compiler driver), be explicit about the things drivers do for you:

1. **Order matters.** Objects providing required symbols (like `_start`) must appear *before* any script-side `PROVIDE` of those symbols.
2. **`--start-group` for archive cross-references.** Single-pass scan silently drops them.
3. **`libgcc.a` is not optional** for m68k C — the compiler emits soft-fp/-divide helpers no other runtime provides.

This caps off the cv-mac #64 north star: write C in a browser tab, click Build & Run, watch a real 68k app boot inside BasiliskII. The compile-and-run loop now actually runs.

### 2026-05-15 — cc1.wasm (and the Retro68 toolchain in general) is not re-entrant
**Context:** First eyes-on test of the in-browser C compile-and-run path on deployed Pages. First click of Build & Run on `wasm-hello` worked end-to-end — Apps disk mounted, app launched cleanly, no crash dialog. Second click returned `error: cc1 exited rc=1 (hello.c:1)` with no parseable diagnostic surfaced.
**Finding:** GCC's `main()` mutates static globals — including `decode_options`' "output file already set" flag — and never resets them on exit. Emscripten can't simulate process re-creation; the heap and statics persist across `callMain` returns. The second `Module.callMain([..., "-o", "/tmp/out.s"])` on the same Module instance sees the prior call's `-o` state still set and errors with:

```
this.program: error: output filename specified twice
this.program: error: too many filenames given; type 'this.program --help' for usage
```

Same root cause as the Node-side bug I hit earlier in `wasm-retro-cc/scripts/verify-show-asm-bundle.mjs` (browser Emscripten can't reset module statics any better than Node Emscripten can).

**Worse:** the bridge's `compileToAsm` had the *exact same bug* — it cached the cc1 Module across edits, so every Show Assembly compile after the first was silently failing. The asm view kept showing the first successful result because the bridge doesn't clear it on subsequent failures, so the UX looked fine.

The wasm-retro-cc/spike `full-pipeline.mjs` test got away with it because each tool is loaded fresh per run of the script — same effect as fresh Module per call.

**Action:** Both `compileToAsm` and `compileToBin` in `src/web/src/playground/cc1.ts` now instantiate a **fresh** Module per invocation. The expensive parts have caches that survive:
  - cc1.mjs / as.mjs / ld.mjs / Elf2Mac.mjs ES factory modules — once-loaded via the browser's ES module loader.
  - cc1.wasm + sibling wasms — once-fetched, browser HTTP cache hits on re-instantiation.
  - Parsed sysroot blobs (`{ blob: Uint8Array, index: SysrootIndexEntry[] }`) — module-scope `headersBlobPromise` / `libsBlobPromise`.

What re-runs per call: Emscripten Module instantiation (~100–300 ms for cc1) and MEMFS sysroot mount (~100–200 ms for the 220-file headers walk). Net Show Assembly latency went from ~150 ms warm to ~400–500 ms warm — under the panel's 500 ms debounce, so the user-perceived "stop typing → asm updates" cycle is unchanged.

Regression guard: `tests/e2e/playground-compile-to-bin.spec.ts` now includes a "survives repeat calls" test that fails fast if the cache ever sneaks back in.

**Two general lessons:**
1. **Eyes-on caught what headless missed.** The cc1 silent-fail in Show Assembly had been there since #80 shipped — Playwright specs only ever exercised the first compile, so the bug never surfaced. The first real user click (yours) hit it on attempt #2. Reinforces the "ship-to-staging is the boot-test strategy" entry above: there's failure-mode space the headless harness doesn't cover.
2. **Assume single-shot for C-runtime wasm binaries until proven re-entrant.** GCC, binutils, and most C-compiled CLI tools were never written with "reset and run again in same process" in mind. The Emscripten wrapper makes the API LOOK re-entrant; the actual program almost certainly isn't.

### 2026-05-15 — In-browser C compile-and-run: ship-to-staging is the boot-test strategy
**Context:** cv-mac #64's north star — "write C in a browser tab, click Compile & Run, watch it boot on a 68k Mac." After cv-mac #80/#81/#82 + wasm-retro-cc #18/#19/#20, the JS-side compile path is real (`compileToBin` produces a structurally-valid MacBinary II APPL from `.c` source via cc1 → as → ld → Elf2Mac, all in the user's tab). What's not yet known: whether the 896-byte single-segment output actually boots on the embedded BasiliskII.
**Finding:** Headless Playwright probing of the boot path was inconclusive. The flow:
  1. Intercept the prebuilt-demo `.bin` fetch and substitute our wasm-built binary.
  2. Click the demo button — playground patches the bytes into the empty HFS template ("Apps" volume) and reboots the emulator.
  3. Wait for "Hello, World! loaded" status (mount confirmed).
  4. Screenshot the canvas — expecting to see an "Apps" disk icon appear.

  The mount fires correctly (status row flips), but the "Apps" disk never visibly renders in the headless screenshot regardless of how long we wait. The same flow with the *known-working* `hello-toolbox-retro68.bin` shows the same blank state in our probe — so the issue is headless capture, not the binary. Likely cause: Finder's desktop-redraw on disk-mount needs an event pump cycle that the headless tab isn't generating, or the canvas readback in Playwright captures stale frames after a worker reboot.
**Action:** **Stop probing headlessly.** Take the cheapest dispositive path: ship the in-browser C compile path to the deployed Pages playground (cv-mac #83 onwards) and click "Build & Run" with eyes on the screen. Failure modes the user sees are unambiguous (type-3 dialog, blank desktop, or visible "Hello, World!"). If real-user boot succeeds, the multi-segment ld script and SIZE resource (documented in wasm-retro-cc LEARNINGS "Phase 2.3d") become nice-to-have polish for larger programs rather than blockers. If it fails, the visible failure mode points at the specific fix.

Rule of thumb crystallised from this: when the verification environment doesn't faithfully simulate the production runtime, prefer staging-with-eyes over piling more layers onto the test harness. Visual evidence on real hardware is the ground truth a deeper headless probe is approximating anyway.

### 2026-05-15 — In-browser C toolchain bundle: split sysroot blobs for path-aware fetching
**Context:** Vendoring wasm-retro-cc#20's bundle into `src/web/public/wasm-cc1/`. The bundle holds four wasm tools (cc1, as, ld, Elf2Mac) + the Retro68 sysroot. Show Assembly only needs cc1 + headers; full Build .c needs all four tools + the lib archives + the ld script. The naive "one sysroot blob with everything" design would push the Show Assembly fetch cost up by ~1 MB brotli for libs it never reads.
**Finding:** Split the sysroot into two blobs at pack time — `sysroot.bin` (headers: gcc-include + include minus c++/) and `sysroot-libs.bin` (libretrocrt + libInterface + libc + libm + retro68-flat.ld). Each blob has its own JSON index. The cv-mac bridge fetches only what the current operation needs:
  - `compileToAsm` (Show Assembly) → `sysroot.bin` only.
  - `compileToBin` (Build .c) → `sysroot.bin` + `sysroot-libs.bin`.

  Both paths run independently; their respective lazy-load promises don't fight. Browser HTTP cache hits the same URL for shared assets (notably `cc1.wasm`), so a user who opens Show Assembly first and then clicks Build .c re-uses the cached compiler.
**Action:** Documented in the bundle's README under "Why two sysroot blobs". The bridge's `loadHeadersBlob` / `loadLibsBlob` cache promises live in `cc1.ts` module scope so multiple `compileToBin` calls within a session re-use the parsed blob without re-fetching or re-parsing.

### 2026-05-15 — Case-fold collisions in macOS-extracted sysroot (Strings.h vs strings.h)
**Context:** First `compileToBin` run against `hello_toolbox.c` failed at cc1 with `fatal error: strings.h: No such file or directory` — even though `sysroot.bin` was mounted in MEMFS at `/sysroot/`.
**Finding:** Two distinct header files coexist in the Retro68 SDK:
  - `/usr/m68k-apple-macos/include/Strings.h` — Mac Toolbox `StringHandle`, `EqualString`, etc.
  - `/usr/m68k-apple-macos/include/strings.h` — BSD-style `strcasecmp`, `strncasecmp`.

  Newlib's `string.h` does `#include <strings.h>` (lowercase, BSD) on line 24. On a case-sensitive filesystem (Linux/Emscripten MEMFS) the lookup resolves to the lowercase variant; on macOS HFS+ (case-insensitive by default) the two files collapse into a single entry — whichever case won extraction-time order. The packed sysroot on our build host (macOS) had `Strings.h` (the Toolbox version) and *no* `strings.h`. MEMFS being case-sensitive then refused the lowercase include.
**Action:** wasm-retro-cc's `build-show-asm-bundle.mjs` now emits a **lowercase alias entry** for any path whose lowercase form isn't already a distinct entry — same byte range in the blob, ~38 alias entries on the headers blob, ~1.7 KB JSON overhead. The on-disk content for `Strings.h` is actually the BSD strings.h (the Toolbox one was lost to the case-collision); fully correct fix would be re-extracting the sysroot on a case-sensitive filesystem. The alias workaround is forward-compatible — it costs nothing once the underlying extraction stops collapsing.

Long-term reminder: any extraction or packaging step that runs on macOS HFS+ should be checked for case collisions on identifiers known to differ only in case (Toolbox Pascal names vs lowercase C convention).

### 2026-05-07 — Infinite Mac WASM artifacts are vendored in git, not released
**Context:** Scaffolding the web frontend; PRD assumed we'd pull pre-built
`BasiliskII.wasm` from "Infinite Mac releases."
**Finding:** mihaip/infinite-mac has no GitHub Releases that ship the WASM
binaries. The compiled emulator cores (`BasiliskII.wasm`, `BasiliskII.js`,
`SheepShaver.wasm`, several `minivmac-*.wasm`, `dingusppc.wasm`, `ppc.wasm`,
`previous.wasm`, `snow.wasm`) live committed in
`src/emulator/worker/emscripten/` on the `main` branch. There's also no
documented stable CDN URL pattern for them — infinitemac.org serves them from
its own bundle, not as a public API.
**Action:** For the POC the web build will fetch the BasiliskII core directly
from `raw.githubusercontent.com/mihaip/infinite-mac/main/src/emulator/worker/emscripten/`
at build time (a small script in `scripts/`, not yet implemented — TODO in
`src/web/README.md`). Longer-term we may want to pin a specific commit SHA
to avoid upstream churn, and/or vendor copies into `public/` with proper
Apache-2.0 NOTICE attribution. Infinite Mac's license is Apache-2.0, so
redistribution is fine as long as we keep the LICENSE + NOTICE.
