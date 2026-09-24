# Troubleshooting

Cmd-F for your symptom. Each entry maps **symptom → root cause → fix**.
Detailed walkthrough follows the quick-reference table.

Cross-links: [`HANDBOOK.md`](./HANDBOOK.md) (end-user manual for the
playground — every button, every shortcut, where files live),
[`DEVELOPMENT.md`](./DEVELOPMENT.md) (iteration loops),
[`LEARNINGS.md`](../LEARNINGS.md) (running gotchas log),
[`README.md`](../README.md#try-it) (Try it),
[`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md) (when
a vendored period app fails silently — instrumentation recipes +
offline splice repro).

---

## Quick-reference table

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| Page loads chrome but no canvas; console shows `SharedArrayBuffer is not defined` or COOP/COEP error | Not in a cross-origin-isolated context | Dev: use `npm run dev` (Vite sets headers). Prod: hard-reload twice to let `coi-serviceworker` install. |
| Mac canvas only shows "Welcome to Macintosh — Pick a project and Build & Run" | Expected. The Mac boots on demand (#279), not on page load | Pick a project and click **Build & Run**. After the first build, the menubar "Reboot Mac" item reboots with the last-built disk. |
| BasiliskII bombs at boot: "unimplemented trap" dialog | Wrong `modelid` pref or a stale/broken boot disk | Check `modelid 30` in `emulator-worker.ts`; re-pull the CI artifact (or re-run `scripts/build-boot-disk.sh` locally). |
| Edited sample doesn't appear after Build & Run | Tab is running a stale bundle, or the browser cached the boot disk | Hard-reload (`Cmd-Shift-R`); disable cache in DevTools during dev. Compare `bundleVersion` / `toolchainVersion` in the `[cvm] build` console line. |
| Build fails: `Foo.h: No such file or directory` (a Toolbox header) | Header not in Retro68's universal interfaces (the sysroot the in-browser cc1 ships with) | Use a different umbrella header (`Windows.h`, `Quickdraw.h`, `MacTypes.h`). The shipped header list is `src/web/public/wasm-cc1/sysroot.index.json`. |
| `hls` says "no such file or directory" for a path that exists | Mac-style HFS paths, not UNIX paths | Use `:` or empty string for root, `:System Folder:` for subdirectory — not `/`. |
| Build & Run succeeds but app doesn't appear | App is on the secondary disk built for this Build & Run, not the boot disk; nothing auto-launches | Open the volume named after your project on the Mac desktop, then double-click the app inside. |
| Build fails with "Couldn't load the build tools — … Reload the page and try again." | The tab outlived a GitHub Pages redeploy; the lazily-loaded build-pipeline chunk it references now 404s | Reload the page. (Message added in #358.) |
| `wasm-rez-stack` unit test fails with `Maximum call stack size exceeded` on Node 24 | Node's default V8 stack is too small for the 2000-literal stress input | The test spawns `stress-wasm-rez.mjs` with `node --stack-size=2000` (#358). Pass the same flag if you run the stress script by hand. |
| In-browser C build shows `cc1 exited rc=1` after the first successful build | cc1.wasm's static state (GCC's `decode_options`) persists across `Module.callMain` invocations — second call sees the first's `-o` flag and errors. | Fresh `Module` instance per compile call (this is what `compileToBin` already does — if you hit this in your own code, don't reuse the same cc1 Module). LEARNINGS Key Story #3. |
| In-browser C build: WasmHello downloads but bombs with type-3 at launch | Likely the `--emit-relocs` ld flag is missing — relocations aren't preserved in the output ELF so `Retro68Relocate` walks empty RELA at runtime and pointers fault. | Already fixed on main (cv-mac #97). If you're forking, make sure `cc1.ts`'s ld argv includes `--emit-relocs`. |
| In-browser C build fails with `unknown filename` or similar MEMFS error | The compile pipeline writes intermediate files to `/tmp/` in the Module FS; a previous failed run may have left stale files | Reload the page (each fresh page load gets fresh Modules). Or check `src/web/src/playground/cc1.ts` for `FS.unlink` calls before each write. |
| `bundleVersion` in console doesn't change after deploying a toolchain fix | `bundleVersion` hashes the C sample sources only, not the wasm-cc1 toolchain. Toolchain updates change `toolchainVersion` instead. | Look for `toolchainVersion=<hex>` in the same `[cvm] build` console line. |
| Vendored app shows its own error alert ("Failed Loading X") or ExitToShells silently after partial boot | Almost always heap exhaustion (memFullErr / `-108`) — period apps' default `SIZE -1` hint is small. Sometimes a missing resource the app's C code hardcodes. | Bump `SIZE -1` in the app's `.r` to 4 MB pref / 2 MB min as a first try. Full diagnostic recipe in [`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md). |
| Build fails with `WASM-Rez threw: Aborted(Assertion failed: i < n, at: …/ResourceDefinitions.cc,253,compile)` | Malformed `ALRT` resource in the `.r` — shorthand `{ OK, OK, OK, OK }` instead of the full per-stage tuple `{ OK, visible, silent; … }` | Spell out the tuple. `npm run audit:wasm-rez` catches this in CI. (Fixed for shipped samples in #297.) |
| Build fails with `Aborted: memory access out of bounds` deep in wasm-rez on a large `.r` (e.g. a 2.7 MB vendored upstream) | wasm-rez's C-stack overflows on left-leaning CONCAT trees in long hex-literal sequences. Cliff was at ~1340 literals/resource. | Already fixed on main (#287, STACK_SIZE bumped to 8 MB). If you forked off pre-#287, rebuild wasm-rez from `tools/wasm-rez/`. |
| Build progress modal shows the *previous* build's failure or a frozen elapsed timer | Stale state left in the reused WinBox | Already fixed on main (#298). Hard-reload to get the new bundle. |
| Doing local pre-push smoke tests on a `wasm-*` sample change | n/a — what to run | `npm run audit:wasm-e2e -- <sample>` runs both .c + .r locally in ~1.5 s. Drop the `--` for all samples. |

---

## Detailed walkthroughs

### "Page shows chrome but no canvas / console errors about SharedArrayBuffer"

You're not in a cross-origin-isolated context. Two cases:

- **Local dev.** Vite sets COOP/COEP for you (see
  `src/web/vite.config.ts`). If you're seeing the error, you may have
  opened a non-Vite preview (e.g. a static `dist/` server). Switch back
  to `npm run dev`.
- **Production (GitHub Pages).** GH Pages can't set custom headers, so
  we ship a `coi-serviceworker.min.js` that re-fetches the page and
  injects the COOP/COEP headers on the way back. **The first load is
  expected to be in the wrong state and reload itself once.** A
  forced reload (Cmd-Shift-R) on the second visit confirms COI is
  installed. See `LEARNINGS.md` (2026-05-08, GH Pages COOP/COEP).

If `coi-serviceworker` ever proves unreliable, move to a host that
can set the response headers natively: Cloudflare Pages (`_headers`)
or Netlify (`netlify.toml`). Neither is wired up today. This fallback
used to live only in the PRD, which is now archived.

### "BasiliskII bombs at boot with 'unimplemented trap'"

Two things to check, in order:

1. **`modelid`.** It must be `gestaltID − 6`, i.e. `30` for Quadra 650.
   The constant lives in `src/web/src/emulator-worker.ts`. The wrong
   value makes Gestalt report a bogus machine type, System 7.5.5 skips a
   chunk of its trap-patch ladder, and bootstrap calls land in the
   "unimplemented trap" handler. Full story in `LEARNINGS.md`.
2. **The boot disk.** `system755-vibe.dsk` is a vanilla System 7.5.5
   image baked by `scripts/build-boot-disk.sh` in CI (no apps are
   preinstalled any more; see #276). If CI's "Build bootable System
   7.5.5 disk" step warned or failed, the deploy may be serving an old
   or missing disk. Check the latest `Build` workflow run, or rebuild
   locally the way CI does: `NO_STARTUP_ITEMS=1 scripts/build-boot-disk.sh "" <output.dsk>`.

### "My edits don't show up after Build & Run"

Samples compile in the browser on every Build & Run, so there's no
disk to rebuild by hand. A stale result is almost always a stale page:

- The tab predates a deploy and is running old JS. Hard-reload
  (`Cmd-Shift-R`). The `[cvm] build` console line prints
  `bundleVersion` (sample sources) and `toolchainVersion` (cc1/as/ld/
  Elf2Mac + sysroot); compare them against a fresh tab.
- The browser cached the boot disk's chunked manifest aggressively.
  Open devtools, check the network tab for 304s on
  `system755-vibe.dsk.json` and its chunks. Disable cache (devtools →
  Network → "Disable cache" while open) for development sessions.
- You changed a bundled sample on disk, but the playground is still
  showing your IndexedDB copy. **Reset** re-seeds the project from the
  bundled defaults (see [`HANDBOOK.md`](./HANDBOOK.md)).

### "Build fails: `Foo.h: No such file or directory`" (a Toolbox header)

The in-browser cc1 compiles against Retro68's universal interfaces,
vendored as the sysroot blob in `src/web/public/wasm-cc1/`
(`sysroot.index.json` lists every header). They don't ship every
header. The fix is usually one of:

- The header is genuinely not in Retro68's tree — find the trap or
  type definition you actually need and pull it from a different
  header (`Windows.h`, `Quickdraw.h`, `MacTypes.h`).
- The header is included indirectly via another umbrella — check what
  the `src/app/wasm-*` samples include.

If you discover a Retro68 quirk worth remembering, add it to
[`LEARNINGS.md`](../LEARNINGS.md) — the "hfsutils-vs-hfsprogs",
"`hls -l` columns", and "`modelid = gestaltID − 6`" entries are the kind
of thing this file exists to capture.

### "`hls` says no such file or directory"

`hfsutils` paths are Mac-style. The volume root is `:` or the empty
string, not `/`. `hls /` resolves to nothing. Use `hls` (no arg, or `:`)
for the root, `hls ":System Folder:"` for a subdirectory. See
`LEARNINGS.md` (2026-05-08).

### "Build & Run succeeded but my app isn't visible"

Build & Run doesn't touch the boot disk. Each run builds a fresh
secondary disk in the browser: `src/web/src/playground/hfs-patcher.ts`
patches your app into the `public/playground/empty-secondary.dsk`
template and names the volume after your project (first 27
characters). The Mac then reboots with that disk mounted. Nothing
auto-launches. After the Mac boots (~1 s warm), look on the desktop
for the volume named after your project, open it, and double-click
your app.

### "Build fails with 'Couldn't load the build tools… reload'"

The build pipeline (preprocessor, rez, cc1 driver, HFS patcher, fork
splicers) is a lazily-loaded chunk with a content-hashed filename. If
the tab stayed open across a GitHub Pages redeploy, the chunk it
points at no longer exists, the dynamic import 404s, and the build
can't start. Reload the page to pick up the current bundle. (#358
replaced the raw import error with this message.)

### "`wasm-rez-stack` test fails with `Maximum call stack size exceeded` on Node 24"

`tests/unit/wasm-rez-stack.test.mjs` feeds wasm-rez a 2000-literal
resource via `scripts/stress-wasm-rez.mjs`. The evaluator recurses
once per literal, and on Node 24 the default V8 stack runs out first,
so you get `RangeError: Maximum call stack size exceeded`. This is not
a wasm-rez regression. As of #358 the test spawns the stress script
with `node --stack-size=2000`. Pass the same flag if you run
`stress-wasm-rez.mjs` by hand.

---

_If you add a fix here, add the corresponding entry to
[`LEARNINGS.md`](../LEARNINGS.md) too so future contributors can find it.
For vendored-app debugging specifically, the deeper recipes
(`cvm_log` instrumentation, splice repro, heap diagnosis) live in
[`DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md)._
