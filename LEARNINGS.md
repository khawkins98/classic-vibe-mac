# Learnings

A running log of things we've learned building classic-vibe-mac — gotchas,
dead ends, surprises, and decisions worth remembering. The goal is to save
the next person (or future-you) from rediscovering the same lessons.

## How to use this file

- Add an entry whenever you hit something non-obvious: a quirk of Retro68, a
  CORS issue with the Infinite Mac CDN, an HFS tool that didn't behave as
  expected, a System 7 API gotcha, etc.
- Date each entry. Group by topic when patterns emerge.
- Keep entries short — a paragraph or two. Link to commits, PRs, or external
  docs for depth.
- It's fine to record negative results ("tried X, didn't work because Y").
  Those are often the most valuable.

## Format

```
### YYYY-MM-DD — Short title
**Context:** what we were trying to do
**Finding:** what we learned
**Action:** what we did about it (or chose not to)
```

---

## Entries

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
