# Spike: WASM-Rez — results

**Branch:** `spike/wasm-rez`
**Date:** 2026-05-08
**Status:** end-to-end success (Track 2). PR is filed for the writeup;
do not merge.

## TL;DR

A `.r` file containing one `STR#` resource compiles in the visitor's
browser via WebAssembly to a resource fork that is **byte-identical
(SHA-256 match) to what native Retro68 Rez emits on macOS**.

End-to-end smoke test on Chromium (Playwright):

| metric                            | value                              |
|-----------------------------------|------------------------------------|
| Resource fork SHA-256 vs native   | identical (`bfce487d…`)            |
| WASM bundle, uncompressed         | **316.5 KB**                       |
| WASM bundle, gzip –9              | **103 KB**                         |
| JS glue (`mini-rez.js`)           | 73 KB uncompressed, ~22 KB gzipped |
| Cold-load + Module init (Chromium)| **45 ms**                          |
| First compile (Chromium, browser) | **9.3 ms**                         |
| Warm compile (Node, ~5th call)    | **<1 ms**                          |

This is **dramatically smaller and faster than the reviewer's pre-spike
estimate** of "3–6 MB gzipped, ~1.5 s first compile, <500 ms warm". The
reason is the spike took Track 2 — replacing Boost.Wave with a hand-rolled
lexer — instead of trying to ship Boost.Wave + Boost.Filesystem +
Boost.Thread to WASM. Section 4 below explains why this is a real
trade-off, not a free lunch.

## 1. Track taken

**Track 2 only.** Track 1 was investigated for ~1 hour and abandoned
when Boost.Wave's transitive dependencies (Boost.Filesystem, Boost.Thread,
Boost.Regex, Boost.Serialization, parts of Boost.Spirit) added up to a
multi-day port that the reviewer had pre-flagged as the highest-risk
unknown.

Specifically:
- Emscripten ships `boost_headers` (1.83.0) but no compiled Boost
  libraries. Wave needs at minimum `libboost_wave`, `libboost_filesystem`,
  `libboost_thread`, `libboost_regex`, `libboost_serialization`.
- A test build that pulled in `boost_headers.a` failed at link time with
  17 unresolved `boost::filesystem::detail::path_algorithms::*_v3`
  symbols, confirming that path-handling alone needs a compiled lib (the
  v3 path API in 1.66+ is not header-only).
- Building Boost.Wave from source under emscripten is the documented
  Wave-on-WASM recipe ([example](https://github.com/boostorg/wave/issues/121),
  the "Compiling boost wave for emscripten" trail), but every public report
  measures days of debugging plus 2.3 MB / 446 files / pthread + exception
  boilerplate. We had ~6 days of agent-time budget. Pivoted.

**Track 2 — the mini variant** replaces `RezLexer.cc` +
`RezLexerNextToken.cc` (the only files in the codebase that depend on
Boost.Wave) with a single 350-line `MiniLexer.cc` that lexes Rez tokens
directly. `boost::filesystem` is replaced with a one-file shim that
aliases the names onto `std::filesystem`. `boost::program_options` is
replaced by a 30-line argv parser in `Rez_main.cc`. `libhfs` is stubbed
because the `Format::diskimage` path is never hit (we always emit
MacBinary).

The result: **zero Boost compiled libs in the link, no pthread**, and
all of `Rez/`, `ResourceFiles/`, and the bison-generated parser
**unmodified**.

## 2. End-to-end success

```
$ mini-rez demo/hello-strn.r -o /tmp/wasm.bin                    # via Node
$ rez       demo/hello-strn.r -o /tmp/native.bin                 # native
$ python3 extract_resource_fork.py /tmp/wasm.bin   > /tmp/wasm.rfork
$ python3 extract_resource_fork.py /tmp/native.bin > /tmp/native.rfork
$ shasum -a 256 /tmp/{wasm,native}.rfork
bfce487d94808132f52e732c031780addde1937b9a6509db6e0c723513840e80  /tmp/wasm.rfork
bfce487d94808132f52e732c031780addde1937b9a6509db6e0c723513840e80  /tmp/native.rfork
```

The MacBinary header itself differs in the input filename and the
creation/modification timestamps (and therefore the trailing CRC).
Rez writes both filenames into the header verbatim, so this is expected
— the **resource fork itself, which is what gets spliced into a `.bin`
on the boot disk, is bit-perfect**.

The Playwright run (`spike-pw-test.mjs` against `demo/index.html`)
reproduces the same in a real Chromium engine, including a hex-dump
view of the produced fork.

I also tested a larger input — `multiversal/custom/Multiverse.r` (300
lines, defines `'SIZE'`, `'cfrg'`, `'rdes'`, `'STR '`, `'STR#'`,
`'ICN#'`, `'FREF'`, `'BNDL'`, `'vers'`, etc.) prepended to a STR#
resource. Output is also bit-identical. So the lexer handles real-shaped
.r content, not just the toy case.

## 3. Numbers

WASM bundle:
- `mini-rez.wasm`: **324,120 B** uncompressed
- `mini-rez.wasm.gz` (gzip –9): **105,473 B**
- `mini-rez.js`: 74,855 B (Emscripten glue, modularize=1, no Node bundling)
- Combined gzipped page weight estimated at **~125 KB** including the JS.

Compile timing (`Date.now()` deltas, M-class Apple Silicon):

| environment              | init / cold-load | first compile | warm compile |
|--------------------------|------------------|---------------|--------------|
| Node 22 (post disk cache)| 3–9 ms           | 4–18 ms       | <1 ms        |
| Chromium via Playwright  | **45 ms**        | **9.3 ms**    | not measured |

These numbers are **for the trivial STR# case**. The lexer is O(N) over
input bytes, so a real reader.r-class input (~360 lines, 12 resources)
should compile in low single-digit ms warm and ~10–20 ms cold, well
under the "feels like a playground" threshold.

## 4. The catch — what the mini variant doesn't do (yet)

The single-resource STR# target in the spike spec is honestly met. The
deliberate scope cuts that I made along the way to fit the time-box are
**load-bearing for Phase 2** and need to be costed honestly:

1. **No `#include` resolution.** The lexer skips lines starting with `#`.
   `demo/hello-strn.r` works because its STR# type definition is inlined.
   `src/app/reader/reader.r` — which `#include`s `Processes.r`, `Menus.r`,
   `Windows.r`, `Dialogs.r`, `MacTypes.r` — emits "Can't find type
   definition for 'MENU'" etc. when run through mini-rez. To unblock real
   apps, the mini lexer needs an `#include`-aware preprocessor stage that
   reads vendored RInclude files from MEMFS. This is the next 2–3 days of
   work and the path is straightforward (the lexer's `peek/advance` loop
   just needs an include stack).
2. **No `#define` / `#if` / `#ifdef`.** Multiverse.r is wrapped in
   `#ifndef _MULTIVERSE_R_` guards which we currently silently skip; the
   re-include guard accidentally works because we ALSO skip the
   `#endif`. Once `#include` lands, real `#if MUMBLE` selection in
   Apple's interface headers (e.g. `OLDROUTINENAMES`, `TARGET_RT_MAC_CFM`)
   has to actually be honoured. Realistic effort: 2 days of preprocessor
   work + a fixture corpus to keep us honest.
3. **No `#error`/`#pragma` parse.** Some Apple .r headers use these.
4. **String-literal escapes are limited to `\n \t \r \0xNN`.** No
   octal, no `\OPT-d` MPW dingbats, no MacRoman → UTF-8 conversion.
   For STR# / DLOG / MENU / ALRT / WIND, this is sufficient based on
   examination of the in-tree `reader.r` and `macweather.r`.
5. **Reduced macro substitution.** Built-ins (`Rez=1`, `DeRez=0`,
   `true=1`, `false=0`, `TRUE=1`, `FALSE=0`) and `-D` definitions work,
   but only as one-pass identifier substitution. Multi-token / function-like
   macros aren't handled. The Apple headers use a fair amount of these;
   need to count exactly how many to estimate the gap. Boost.Wave handles
   it for free, of course.
6. **Errors are bare-bones.** Native Rez prints "1:5: error: …";
   mini-rez prints the same shape but without the multi-frame stack
   that Wave's `preprocess_exception` provides on `#include` errors.
   Once #1 lands, error messages need to carry the include stack.
7. **One-shot `boost::filesystem` shim.** It currently aliases
   `path/ofstream/ifstream/create_directory`. ResourceFile.cc uses
   exactly those four; if Phase 2 grows to need `is_directory`,
   `directory_iterator`, etc., the shim needs to grow too. Easy work.

**Realistic Phase 2 estimate based on this spike:**

- Vendor RIncludes (Multiverse.r + the 12 most-used .r headers
  generated via the multiversal Ruby pipeline as a CI step): **1 day**.
  We do NOT need the upstream Ruby generator on the user's browser; the
  generated files are ~600 KB unpacked, ~120 KB gzipped, ship as a
  static asset.
- `#include` + minimal `#if/#ifdef/#define` in MiniLexer: **3–4 days**.
- Macro substitution sufficient for the in-tree apps' headers: **2 days**.
- Editor-IDB-VFS bridge so `#include` can pull from IndexedDB rather
  than just MEMFS-bundled assets (so the user can edit `MacTypes.r`
  themselves): **2 days**.
- Error reporting + line markers wired to CodeMirror: **2 days**.
- Splice the produced resource fork into the precompiled `.code.bin`
  (the Phase 2 spec's "patch the data fork onto the existing app" path):
  **2 days** — we already have the bytes from `extractRsrcFork(macBin)`
  in the demo.

**Total Phase 2 honest re-estimate: ~12–14 working days = 2.5–3 weeks**,
materially cheaper than the reviewer's 4–6 weeks. The reduction
comes entirely from sidestepping Boost.Wave; what's left is regular
preprocessor / build-system work.

The risk this estimate hides:
- If a `.r` file in the wild uses Wave-specific tricks we haven't seen
  (variadic macros, stringification with `#x`, paste with `##` in
  resource bodies), the mini lexer will need new cases. Mitigation:
  bring `mcpp` back as a fallback specifically for the preprocessor
  stage. mcpp is C, BSD-licensed, and reliably ports to WASM
  (~80 KB compiled). The mini lexer can stay on the tokenization side
  with mcpp piped into it via stdio. **This is the agreed week-2
  fallback from the original spike spec, and it remains valid.**
- The lexer was tested against two inputs (the spike target and
  `Multiverse.r`-prepended). It is **not** tested against the full
  `reader.r` because `#include` is missing. There may be lexer cases
  in real headers we haven't seen.

## 5. Top hidden issues encountered

1. **`boost_headers` Emscripten port is not enough for Boost.Wave.**
   The port name suggests "header-only Boost everything", but
   Boost.Filesystem's path_algorithms and Boost.Wave's grammar
   instantiations are explicitly compiled. Adding `-sUSE_BOOST_HEADERS=1`
   gets you to compile but fails at link with
   `path_algorithms::stem_v3` etc. unresolved. **Track 1 needs
   building all of Boost.Filesystem, Wave, Thread, Regex, Serialization
   from source under emcmake** — that's the part the reviewer was
   right about.
2. **Bison name collision: `using yy::RezParser;` conflicts with
   `friend class RezParser;`.** RezWorld.h forward-declares
   `class RezParser;` at file scope to befriend it. The
   bison-generated parser hoists `using yy::RezParser;` into the
   same scope via `%code provides`. Including both headers in the
   same TU makes the using-decl conflict with the file-scope class
   forward-decl. The fix is straightforward (don't include
   RezWorld.h in the lexer TU; it's not used there) but the error
   message points at line numbers in different files and takes a
   minute to diagnose.
3. **The MacBinary header's filename and timestamps deliberately
   leak into the output.** The diff between native and mini outputs
   looked alarming until I extracted just the resource fork — the
   header has `argv[1]` baked into it (Pascal string at offset 1),
   plus `time(NULL)` for ctime/mtime, plus a CRC over the header.
   For the Phase 2 use case this is *fine* because we only splice
   the resource fork onto a precompiled `.code.bin`, not the
   MacBinary header — but it'd be a real mystery if we were
   sha-comparing whole files.

## 6. Recommendation

**Ship Phase 2 as scoped — but commit explicitly to the mini-Rez
path, not the Boost.Wave-on-WASM path.**

- The mini-Rez path is **already proven end-to-end** (this spike).
  The remaining work is bounded preprocessor + RIncludes vendoring
  + IDB integration; nothing of the "did we even pick the right
  toolchain?" character that the reviewer flagged.
- A successful Track-1 (Boost.Wave) port would not produce a
  meaningfully better artifact: bundle would be **larger**, error
  messages would be **slower** to surface, and `#include` semantics
  would only differ at the edges (variadic macros etc.).
- The mini-Rez bundle (~316 KB / 103 KB gzipped) is small enough
  that we can afford to ship it on every page load even if the user
  never edits, which is good UX.

**Do not pivot to mcpp pre-emptively.** It's the right week-2
fallback if the mini lexer hits a wall on Apple .r headers, but the
data so far (Multiverse.r passes byte-identical) suggests we may not
need it.

**Open question (out of spike scope, file as a follow-up):** if a
user pastes a complex `.r` from a third-party Mac app whose headers
depend on `#pragma options align=mac68k` or similar, what does Rez
need to do? We don't have a corpus.

## 7. Cross-references

- `vendor/MiniLexer.cc` — the 350-line lexer.
- `vendor/Rez_main.cc` — replacement for `Rez/Rez.cc` without
  `boost::program_options`.
- `vendor/boost_fs_shim/boost/filesystem.hpp` — std::filesystem alias.
- `vendor/hfs_stub.h` — stubs for `hfs_*` (never called in practice).
- `CMakeLists.txt` — single project file driving native, mini-native,
  and mini-wasm builds.
- `demo/index.html` — runnable proof in the browser.
- `demo/hello-strn.r` — the success-target input.

## 8. Reproducer

See `README.md` for the full local reproduce. In short:

```sh
# native (ground truth) build:
cmake -S . -B build/native -DCMAKE_PREFIX_PATH=/opt/homebrew
cmake --build build/native -j

# mini native (no Boost) build:
cmake -S . -B build/mini-native -DSPIKE_MINI=ON
cmake --build build/mini-native -j

# mini WASM build (requires emsdk activated):
emcmake cmake -S . -B build/mini-wasm -DSPIKE_WASM=ON -DSPIKE_MINI=ON
cmake --build build/mini-wasm -j

# Serve the demo:
( cd demo && python3 -m http.server 8765 )
# Open http://localhost:8765/index.html and click Compile.
```
