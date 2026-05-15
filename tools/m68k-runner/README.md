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
| Retro68Relocate faults | illegal-instruction exception with PC inside Retro68Relocate's range |
| `main()` reached | trace shows a `jsr` to `main`'s address from `_start` |
| Toolbox traps fired | per-trap log line with trap number + symbolic name |
| Clean app exit | `ExitToShell` trap fired, done line records it |

## What's NOT here (yet)

- **No Toolbox stubs.** A-line traps are logged, then `PC += 2` so
  execution continues without simulating what the real Toolbox would
  have done. Apps that branch on Toolbox return values will diverge
  from real-Mac behavior. Sufficient for the "where does startup die"
  diagnostic that motivated the build; insufficient for end-to-end
  behavioral checks.
- **No LoadSeg.** `Retro68Relocate` walks the segment table via
  `LoadSeg` to find segment base addresses. Without a real LoadSeg
  stub, `Retro68Relocate` reads wrong addresses and patches garbage.
  Affects multi-segment apps after the relocator runs.
- **No Process Manager.** We don't set up Process Manager globals, the
  Heap Manager, the A5 world's negative globals beyond a zeroed
  region, etc. The minimal A5 + jump table setup is enough for
  startup; not enough for a full app.

cv-mac #89 tracks the expansion list. The MVP earned its keep on the
first run; further investment is opportunistic.

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
