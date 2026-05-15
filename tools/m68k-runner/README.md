# m68k-runner — CLI Musashi-based boot tracer

Minimum-viable harness for testing wasm-retro-cc compiled binaries
without the 30-minute browser-deploy round trip. See cv-mac #89 for
the full rationale and roadmap.

## Why

The in-browser `compileToBin` pipeline (cv-mac #82–#88,
wasm-retro-cc#22–#25) had a recurring failure pattern: every layer of
fix landed structurally clean (passes `inspect_macbinary.py`, valid
MacBinary II shape) but still failed at runtime on the deployed
BasiliskII emulator. The eyes-on test loop was 15-30 minutes per
iteration. The Musashi-CLI harness runs the same binary through a
68k CPU emulator natively in seconds, with instruction-by-instruction
trace and A-line trap logging — enough to see *where* a binary dies,
not just *that* it does.

The first run of this harness (against the broken
multi-seg-script-without-PROVIDE-fix binary) immediately showed the
entry trampoline jumping to memory address 0 after `RTS`, with the
PC-modifier immediate at the PROVIDE fallback value (`0x06`) instead
of the real `_start` offset (`0x258c`). Replaced what would have been
another 30-minute deploy-and-test cycle.

## Build

```
make
```

Builds Musashi (the vendored 68k emulator under `musashi/`) and the
`runner.c` harness into a single CLI binary, `./m68k-run`. Requires
only `cc` and `make`.

## Run

```
./m68k-run path/to/hello.bin [--trace] [--max=N] [--quiet]
```

- `--trace` — one stderr line per executed instruction
  (`PC OPCODE SP [SP]`).
- `--max=N` — instruction budget (default 1,000,000). Stops cleanly
  when reached.
- `--quiet` — suppress A-line trap log lines (still respects --trace).

Exit codes: `0` for normal stop or `ExitToShell`; `1` for argument /
file format errors; `2` for unrecoverable CPU faults (out-of-range
memory access).

## What it can detect

| Failure | Signal |
| --- | --- |
| `_start` is the PROVIDE fallback RTS | trace shows trampoline RTS popping `0x00000000` to PC |
| `_start` is in the wrong segment | trace shows trampoline `RTS` landing outside CODE 1's range (cv-mac #92 / wasm-retro-cc#26) |
| Retro68Relocate faults | illegal-instruction exception with PC inside Retro68Relocate's range |
| `main()` reached | trace shows a `jsr` to `main`'s address from `_start` |
| Which resource the binary asks for first | `[GetResource] type='RELA' id=1 → ...` log line |
| Toolbox traps fired | per-trap log line with trap number + symbolic name |
| Clean app exit | `ExitToShell` trap fired, done line records it |

## Toolbox stub coverage

Minimal Resource Manager + Memory Manager stubs so the harness can run
**through** the first Toolbox call rather than dying at it. We're not
emulating Mac OS — we're faking just enough that libretrocrt's startup
can complete its first phase.

Stubbed (with semi-real semantics):
- **Resource Manager:** `GetResource`, `ReleaseResource`, `HomeResFile`,
  `CurResFile`, `SizeRsrc`, `ResError`, `SetResLoad`, `GetResAttrs`.
  `GetResource(type, id)` returns a Handle backed by the resource bytes
  we parsed from the MacBinary input. Repeated calls for the same
  `(type, id)` return the same Handle (some libretrocrt code does
  pointer equality on Handles).
- **Memory Manager:** `NewHandle`, `DisposeHandle`, `HLock`, `HUnlock`,
  `GetHandleSize`, `SetHandleSize`, `NewPtr`, `DisposePtr`, `BlockMove`.
  Bump-pointer allocator backed by a 192 KB heap region. No free; no
  size tracking on Handles.
- **Stripped semantics:** `StripAddress` (no-op on 32-bit), `BlockMove`
  (memmove of bytes between regions).

Calling conventions matter: Resource Manager uses Pascal stack args
(caller reserves return-value slot, pushes args, trap pops args and
leaves return). Memory Manager uses register convention (D0 = size in,
A0 = handle out, D0 = result code). The stubs handle both.

## What's NOT here (yet)

- **No OS trap dispatch.** `GetOSTrapAddress`, `GetToolTrapAddress`,
  `_Unimplemented` — libretrocrt uses these for ROM version detection
  early in startup. Returning zero from them confuses the relocator's
  "is StripAddress available?" check.
- **No low-memory globals.** The Mac has ~1 KB of well-known
  low-memory globals at fixed addresses (e.g. `ROM85` at `0x028E`,
  `CurrentA5` at `0x0904`, `MemTop` at `0x0108`). libretrocrt reads
  these to figure out which ROM family it's running on. We leave the
  region zero-filled, so the detect logic sees "very old 64K ROM" and
  picks code paths that may or may not run on our minimal stubs.
- **No LoadSeg trap dispatcher.** Multi-seg apps patch LoadSeg into the
  jump table so that calling an unloaded segment loads it from disk
  and jumps. Our harness pre-loads all segments at fixed addresses but
  doesn't intercept the LoadSeg trap — calling cross-segment uses the
  on-disk jump table entries directly, which don't yet point at the
  real code addresses we loaded.
- **No QuickDraw, Window Manager, Event Manager, etc.** A `DrawString`
  call is logged and skipped; no port is set up, no bitmap is painted.

## Current useful diagnostic range

The harness will reliably tell you:

1. Whether the entry trampoline lands inside `.code00001` (the cv-mac
   #92 / wasm-retro-cc#26 bug)
2. Whether `_start` runs
3. Whether `Retro68Relocate` is entered
4. **Which resource the relocator asks for first** (RELA 1 for
   multi-seg; CODE for some flat builds)

After the first GetResource, our stub returns a Handle but the
relocator's subsequent path makes assumptions about low-memory globals
and trap dispatch that our stubs don't satisfy. Expect the harness to
drift into low-memory garbage shortly after — the diagnostic value
ends at the first GetResource line.

cv-mac #89 tracks the expansion list. Each new layer of stub coverage
is opportunistic — added when a concrete bug needs it, not built
speculatively.

## Vendored

`musashi/` is a copy of [Karl Stenerud's Musashi
4.60](https://github.com/kstenerud/Musashi) (MIT licensed). The `softfloat/`
subdirectory is John R. Hauser's SoftFloat (vendored by Musashi).
Both ship with their original copyright + license headers in each
source file; no changes were made except the `m68kconf.h` switch to
`M68K_INSTRUCTION_HOOK = M68K_OPT_SPECIFY_HANDLER` to route the
per-instruction callback to `runner.c`'s `m68k_instr_hook`.

To refresh: `git clone --depth 1
https://github.com/kstenerud/Musashi /tmp/musashi-fresh && cp /tmp/musashi-fresh/*.c
/tmp/musashi-fresh/*.h /tmp/musashi-fresh/Makefile musashi/ &&
cp -R /tmp/musashi-fresh/softfloat musashi/`, then re-apply the
`m68kconf.h` patch.
