# `spike/wasm-rez` — research spike for Epic #21 Phase 2

This directory is a **time-boxed research spike**. It exists to answer one
question: can Retro68's Rez resource compiler be ported to WebAssembly
cleanly enough to use in-browser as the build pipeline for the playground
described in Epic #21?

The spike is filed against `spike/wasm-rez` and intentionally **isolated**
from the rest of the repo:

- Nothing outside `spike/wasm-rez/` is modified.
- The PR is `do-not-merge` — it's a vehicle for the writeup
  (`SPIKE-RESULTS.md`) and a runnable demo, not for landing code.
- Build artefacts go to `build/`, which is gitignored.

The TL;DR result is in `SPIKE-RESULTS.md`. **Yes, it works** — a `.r` file
with one `STR#` resource compiles in the browser to a resource fork that
is byte-identical to native Retro68 Rez. Bundle is ~103 KB gzipped.

## Layout

```
spike/wasm-rez/
├─ CMakeLists.txt           single project: native + mini-native + mini-wasm
├─ SPIKE-RESULTS.md         the writeup
├─ README.md                this file
├─ vendor/
│  ├─ retro68/              Retro68 source tree (clone, see "Reproduce" below)
│  ├─ MiniLexer.cc          replaces RezLexer.cc — drops Boost.Wave dependency
│  ├─ Rez_main.cc           replaces Rez.cc — drops boost::program_options
│  ├─ hfs_stub.h            no-op libhfs stand-in (Format::diskimage isn't used)
│  └─ boost_fs_shim/        boost::filesystem -> std::filesystem aliases
└─ demo/
   ├─ index.html            runnable proof: textarea -> WASM-Rez -> hex dump
   ├─ hello-strn.r          the success-target input (one STR# resource)
   ├─ mini-rez.js           WASM glue (built artefact, gitignored)
   └─ mini-rez.wasm         WASM module   (built artefact, gitignored)
```

## Reproduce locally

Prerequisites: macOS with Homebrew (or Linux equivalent).

```sh
# 1. Toolchain
brew install boost bison cmake          # native build needs all three
git clone --depth 1 https://github.com/emscripten-core/emsdk.git /tmp/emsdk
( cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest )
source /tmp/emsdk/emsdk_env.sh

# 2. Vendor Retro68 (~150k files; once)
cd spike/wasm-rez/vendor
git clone --depth 1 https://github.com/autc04/Retro68.git retro68
( cd retro68 && git submodule update --init --depth 1 multiversal )

# 3. Build native (ground truth) — Boost.Wave path
cmake -S . -B build/native -DCMAKE_PREFIX_PATH=/opt/homebrew
cmake --build build/native -j

# 4. Build mini native — no Boost.Wave, sanity-check the lexer rewrite
cmake -S . -B build/mini-native -DSPIKE_MINI=ON
cmake --build build/mini-native -j

# 5. Build mini WASM — the deliverable
emcmake cmake -S . -B build/mini-wasm -DSPIKE_WASM=ON -DSPIKE_MINI=ON
cmake --build build/mini-wasm -j
cp build/mini-wasm/mini-rez.{js,wasm} demo/

# 6. Verify byte-equivalence on the spike target
build/native/rez            demo/hello-strn.r -o /tmp/native.bin
build/mini-native/mini-rez  demo/hello-strn.r -o /tmp/mini.bin
# (resource forks should match — see SPIKE-RESULTS.md §2 for the script)

# 7. Drive the WASM module headlessly via Node
( cd build/mini-wasm && node wasm-bench.js )

# 8. Serve the demo and run it manually
( cd demo && python3 -m http.server 8765 )
# Open http://localhost:8765/index.html and click "Compile".
```

## Time-box

Work occurred on 2026-05-08, agent-time, single session. Total wall-clock
was a few hours rather than the 7-day budget; the abort criteria for the
spike never triggered because Track 2 landed clean.

## Don't

- **Don't merge this PR.** It's a vehicle for the writeup.
- **Don't depend on these artefacts from `main`.** The CMakeLists vendors
  tweaks specific to the spike (e.g. ResourceFile.cc compiled with a
  std::filesystem shim, libhfs stubbed). Phase 2 implementation will
  rewrite these as a proper, tested integration.
- **Don't try to extend the lexer here** — a real Phase 2 implementation
  needs `#include`, `#define`, `#if`, and a proper test harness. See
  `SPIKE-RESULTS.md` §4 for the gap list and §6 for the recommendation.

## CI

Intentionally none. The spike's only check is the manual reproduce above.
Adding a CI job that runs Boost+emsdk on every PR would balloon `main`'s
build time. If Phase 2 lands the mini-Rez path, that work will bring its
own focused CI in `feat/playground-phase2`.
