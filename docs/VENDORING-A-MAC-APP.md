# Vendoring a period Mac app

Recipe for adding a third-party period Mac app to the cv-mac sample
shelf so it builds + runs end-to-end in the browser playground.
Companion to [`docs/DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md)
— that's for when things break, this is the happy path.

The recipe was extracted from cv-mac #256 (Glypha III). Glypha went
from "find the source" to "playable with sound" in five PRs across one
evening, ~9000 LOC vendored. The steps below are what worked.

---

## Picking a candidate

A good candidate has all of these:

| Trait | Why it matters |
|-|-|
| Source available under MIT / BSD / GPL | Legal vendoring + clear LICENSE.upstream |
| Has a `.r` source file alongside `.c` files | wasm-rez consumes Rez text; not raw `.bin` resources |
| Pure 68k Toolbox calls, no PowerPC-only paths | Retro68 targets 68k; we don't ship a PPC compiler |
| Total source under ~10 MB | Practical bundle size; large samples lag the editor |
| No proprietary fonts, sounds, or images | License clean even if you didn't write them |

[softdorothy](https://github.com/softdorothy)'s repos are well-suited —
John Calhoun open-sourced several of his late-80s/early-90s Mac games
under MIT. Glypha III (#256), Glider 4, Pararena 2, and Stunt Copter
all fit the profile. The community archive at macintoshgarden.org is a broader hunting
ground but check licenses carefully.

## The recipe

1. **Vendor the source** into `src/app/wasm-<name>/`:

   ```bash
   mkdir src/app/wasm-myapp
   # download / clone upstream source files
   cp ~/upstream/MyApp/Source/*.c   src/app/wasm-myapp/
   cp ~/upstream/MyApp/Source/*.h   src/app/wasm-myapp/
   cp ~/upstream/MyApp/Source/*.r   src/app/wasm-myapp/myapp.r
   cp ~/upstream/MyApp/LICENSE      src/app/wasm-myapp/LICENSE.upstream
   ```

   Keep the original LICENSE alongside as `LICENSE.upstream`. Don't
   rename files inside — leave them upstream-identical so future
   re-syncs are clean.

2. **Add a small overlay at the top of `<name>.r`** for two resources
   most upstream `.r` files lack:
   - `'CVxx' (0)` Owner signature (matches `appCreator` below)
   - `SIZE -1` with a generous heap hint (start at 4 MB / 2 MB —
     bump later if the app needs more; see DEBUGGING-VENDORED-APPS.md)

   See [`src/app/wasm-glypha3/glypha3.r`](../src/app/wasm-glypha3/glypha3.r)
   for the pattern. Everything below the overlay is the upstream `.r`
   verbatim so the IDs the game's C code hardcodes (`GetPicture(N)`,
   `GetSound(N)`, etc) all resolve to their original assets.

3. **Compatibility shim in a header**, if needed. Period code often
   uses old API names (`DisposPtr` vs `DisposePtr`, `BlockMove` flags,
   `Universal Headers` macros). The pattern: a project-local
   `Externs.h` with `#define`s that map old names to modern Retro68
   names. Glypha's Externs.h is a small worked example.

4. **Add the sample to `SAMPLE_PROJECTS`** in
   [`src/web/src/playground/types.ts`](../src/web/src/playground/types.ts):

   ```ts
   {
     id: "wasm-myapp",
     label: "My App (Author, License)",
     files: ["main.c", "myapp.r", /* … */],
     rezFile: "myapp.r",
     outputName: "MyApp.bin",
     appType: "APPL",
     appCreator: "CVxx",         // matches the 'CVxx' overlay above
     complexity: 4,              // 1-6, ★/☆ rating in the dropdown
   },
   ```

5. **Wire it into the Vite sample seed**. The plugin in
   [`src/web/vite.config.ts`](../src/web/vite.config.ts) has a
   `SAMPLE_PROJECTS` table that mirrors the playground's. Add an
   entry that lists every file the playground will fetch at runtime.

6. **Audit + run the unit tests:**

   ```bash
   # Combined .c + .r audit — verifies both halves of the build path
   # without a browser. ~5s for all samples, ~1.5s for one.
   npm run audit:wasm-e2e -- wasm-myapp
   # ✓ wasm-myapp  c=✓ ⟦bytes⟧ ⟦ms⟧  r=✓ ⟦bytes⟧ ⟦ms⟧

   # Or run each half separately for full per-stage diagnostics:
   node scripts/audit-wasm-samples.mjs wasm-myapp
   node scripts/audit-wasm-rez.mjs wasm-myapp

   node --test tests/unit/wasm-rez-stack.test.mjs
   # ✓ wasm-rez handles 2000-literal stress
   # ✓ wasm-rez compiles vendored Glypha .r
   #   (add a similar one for your sample if its .r is over ~500 KB)
   ```

7. **Browser test.** `npm run dev`, open the playground, select your
   new sample, Build & Run. Watch for the failure modes catalogued in
   DEBUGGING-VENDORED-APPS.md — silent ExitToShell, the app's own
   error alert, blank window. If you hit one, head over to that doc
   for the instrumentation pattern.

## Common post-vendor fixes

What I needed to tweak for Glypha specifically — likely similar for
other 68k games:

- **Heap too small.** Default SIZE in upstream `.r` files often
  predates modern Mac OS expectations. Start at 4 MB / 2 MB; trim if
  the audit shows the bin is too big.

- **Missing `cvm_log` support.** If the app uses `cvm_log` for
  diagnostics, add `#include <cvm_log.h>` (system header, mounted by
  cc1.ts) and `#include <stdio.h>` for `sprintf` (cvm_log takes a
  single string, not printf-style).

- **App signature.** The `appCreator` field in `SAMPLE_PROJECTS`
  must match the `'CVxx' (0)` signature resource in the `.r`
  overlay, OR the Finder will not recognize the .bin as an APPL.

- **PPC fallbacks.** If you see `#ifdef powerc` blocks in the source,
  the `#else` branch is what 68k Retro68 takes — make sure it
  compiles. Sometimes the PPC-only branch defines a function the
  68k branch references; pull the function down.

## Reference

- [`docs/DEBUGGING-VENDORED-APPS.md`](./DEBUGGING-VENDORED-APPS.md) —
  for when something goes wrong (it will).
- [`src/app/wasm-glypha3/`](../src/app/wasm-glypha3/) — the canonical
  worked example. ~9000 LOC vendored, 2.7 MB upstream `.r`, real
  sprite art + 17 snds, plays in the browser.
- [`scripts/audit-wasm-samples.mjs`](../scripts/audit-wasm-samples.mjs)
  — exit 0 means your `.c` files link; exit 1 means something in the
  toolchain doesn't like them.
- [`scripts/stress-wasm-rez.mjs`](../scripts/stress-wasm-rez.mjs) —
  exit 0 means your `.r` file compiles; useful for checking large
  upstream Rez before you try the in-browser path.
