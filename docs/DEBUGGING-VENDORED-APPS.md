# Debugging vendored Mac apps

Recipes for when a vendored period app fails silently in the playground —
shows its own alert, ExitToShells before reaching gameplay, or just
displays a blank window. Distilled from the cv-mac #256 closeout, where
Glypha III went from silent crash → playable in five PRs.

When to reach for this: **the app shows its own dialog / alert / silent-crashes
before reaching the gameplay you expected.** The pattern below narrows the
question from "Mac app broken" to "this specific init function fails with
this specific error code", which is a tractable problem.

When **not** to reach for this: build/link errors (those surface in the
playground's Build log already), or "Build button does nothing" (that's
toolchain plumbing, not vendored-app behaviour).

---

## Recipe 1 — Instrument the init path

The first question is always *where* in startup the app dies. Drop
[`cvm_log`](../src/app/wasm-debug-console/cvm_log.h) into the suspect
function and read the [Debug Console pane](../docs/PLAYGROUND.md). If
init runs `Foo() → Bar() → Baz()` and only "Foo" prints, the bug is
in `Bar`.

```c
#include <cvm_log.h>

void main(void) {
    cvm_log_reset();              /* wipe the log so each run is clean */
    cvm_log("main: entered");     /* canary — confirms _start ran */

    cvm_log("main: -> ToolBoxInit");
    ToolBoxInit();
    cvm_log("main: -> OpenMainWindow");
    OpenMainWindow();
    cvm_log("main: -> InitSound");
    InitSound();
    /* … */
}
```

Remove once you've found the failing step. The
[wasm-debug-console](../src/app/wasm-debug-console/) sample is a working
end-to-end demo of the logging pipeline.

---

## Recipe 2 — Surface ResError and heap state at the failure point

Toolbox calls (`GetResource`, `NewPtr`, `NewHandle`, `SndNewChannel`, …)
return NULL on failure with the actual error code in `ResError()` /
`MemError()`. The stock upstream code typically discards this and just
shows a generic alert. Capture it.

```c
#include <stdio.h>
#include <cvm_log.h>

theSound = GetResource('snd ', 1000);
if (theSound == 0L) {
    OSErr  e   = ResError();
    char   buf[200];
    sprintf(buf,
        "GetResource('snd ', 1000) failed ResError=%d FreeMem=%ld MaxBlock=%ld",
        (int)e, (long)FreeMem(), (long)MaxBlock());
    cvm_log(buf);
    return e;
}
```

`cvm_log` is single-arg (not printf-style), so sprintf into a local
buffer first. `FreeMem()` and `MaxBlock()` are critical here — if the
resource really IS in the fork (Recipe 3 confirms this), the failure
is almost always memory exhaustion, and FreeMem tells you whether the
SIZE resource hint needs to go up.

Common error codes the playground sees:
| Code  | Constant      | Likely meaning |
|------:|---------------|-|
|  -108 | memFullErr    | Heap too small — bump SIZE -1 |
|  -192 | resNotFound   | Resource isn't in the file (or Resource Manager isn't seeing it — see Recipe 3) |
|   -39 | eofErr        | Truncated resource / fork |
|   -43 | fnfErr        | File not found |
|   -49 | opWrErr       | File already open with write permission |

---

## Recipe 3 — Rule out the splice / build path offline

Before assuming the Resource Manager has a bug, prove the resources
*actually exist* in the compiled `.bin`. The playground does the splice
in-browser, but
[`scripts/splice-bin.mjs`](../scripts/splice-bin.mjs) reproduces it in
Node so you can inspect the result without spinning up a tab.

```bash
# 1. Compile the .c via Node-side wasm-cc1 (audit pipeline)
#    — see scripts/build-and-extract-sample.mjs for a reusable harness.
node scripts/build-and-extract-sample.mjs   # writes /tmp/debug-console.bin
                                            # adapt to point at wasm-glypha3/

# 2. Compile the .r via wasm-rez
node scripts/stress-wasm-rez.mjs src/app/wasm-glypha3/glypha3.r
# writes /tmp/stress-wasm-rez-output.rsrc.bin

# 3. Splice them like the browser would
node scripts/splice-bin.mjs /tmp/glypha-cbin.bin \
                            /tmp/stress-wasm-rez-output.rsrc.bin \
                            /tmp/spliced.bin

# 4. Inspect — does the resource you're looking for exist?
node scripts/extract-resource-fork.mjs --info /tmp/spliced.bin
```

If the resource is present in step 4's output at the expected ID, the
build path is fine — focus on Recipe 2's runtime diagnostic. If it's
missing, the bug is in wasm-rez or the splice; bisect from there.

---

## Worked example — Glypha III "Failed Loading Sounds"

The actual #256 run, for shape:

1. **Symptom**: full sprite-art title screen renders → Glypha's own
   "Failed Loading Sounds" alert → no game.
2. **Recipe 3** confirmed all 17 snd resources were present in the
   spliced `.bin` at IDs 1000-1016 — splice was correct, ruled out as
   cause.
3. **Recipe 2** added `cvm_log(ResError + FreeMem)` inside
   `LoadBufferSounds`. Hypothesised heap exhaustion: 1 MB `SIZE -1`
   hint vs ~540 KB of resources + GWorlds + Resource Manager overhead.
4. Bumped `SIZE -1` to 4 MB pref / 2 MB min as a pre-emptive fix;
   diagnostic would have told us exactly what FreeMem was if it
   hadn't been enough.
5. Game runs. Diagnostic removed in the cleanup PR.

Five PRs total (cv-mac #287, #288, #289, #290, #291, #292), one
evening's autonomous session. The toolkit above is what made step 2 +
step 3 take ~10 min each instead of half a day each.
