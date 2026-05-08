# tools/wasm-rez

The in-browser WASM-Rez compiler. Promoted from `spike/wasm-rez/` after the
research spike landed green (see `spike/wasm-rez/SPIKE-RESULTS.md` on the
`spike/wasm-rez` branch and Issue #21 / Issue #30 for the production
requirements).

## What this is

A WebAssembly build of Retro68's `Rez` (the resource compiler), with the
Boost.Wave dependency replaced by a hand-rolled mini-lexer (`MiniLexer.cc`)
so the artefact is compact (~316 KB raw / ~103 KB gzipped) and links
without any compiled Boost libraries.

The target use case is the in-browser playground (`src/web/src/playground/`),
where a visitor can edit a `.r` file and see a freshly-compiled resource
fork without leaving the page.

## Layout

```
tools/wasm-rez/
├── CMakeLists.txt           — single-file build for native + WASM
├── vendor/
│   ├── MiniLexer.cc         — Boost.Wave-replacement lexer (350 lines)
│   ├── Rez_main.cc          — replaces Rez/Rez.cc (no boost::program_options)
│   ├── hfs_stub.h           — empty libhfs stubs (we never write disk images)
│   ├── boost_fs_shim/       — std::filesystem alias for boost::filesystem
│   └── retro68/             — trimmed copy of autc04/Retro68
│       ├── Rez/             — bison grammar + RezWorld + everything ABOVE the lexer
│       ├── ResourceFiles/   — ResourceFile.cc, BinaryIO, MacBinary writer
│       ├── multiversal/     — Apple .r header source (Ruby generator + YAML defs)
│       └── COPYING          — upstream license notice
```

## Building

The recommended path is `scripts/build-wasm-rez.sh` from the repo root,
which handles native-emsdk and Docker fallback automatically.

```sh
# from repo root:
./scripts/build-wasm-rez.sh
# → src/web/public/wasm-rez/wasm-rez.{js,wasm}

# verify a rebuild matches the committed blobs (CI gate):
./scripts/build-wasm-rez.sh --check
```

Manual build for debugging (requires emsdk activated in your shell):

```sh
cd tools/wasm-rez
emcmake cmake -S . -B build/wasm -DSPIKE_WASM=ON -DSPIKE_MINI=ON
cmake --build build/wasm -j
# → build/wasm/mini-rez.{js,wasm}
```

A native (non-WASM) build is also supported for host-cc unit tests:

```sh
cd tools/wasm-rez
cmake -S . -B build/native -DSPIKE_MINI=ON
cmake --build build/native -j
# → build/native/mini-rez (CLI: ./build/native/mini-rez input.r -o out.bin)
```

## Why we vendor prebuilt artefacts

Phase 2 ships under Track 1b of Issue #30: prebuilt `wasm-rez.{js,wasm}`
live in `src/web/public/wasm-rez/`, committed to git. This keeps the CI
build step free of an emsdk dependency and keeps the agent loop fast.

Tradeoff: the source tree under `tools/wasm-rez/vendor/` is the canonical
artefact. Any change to MiniLexer.cc or Rez_main.cc must be re-built via
`scripts/build-wasm-rez.sh` and the regenerated blobs re-committed before
the change ships. The `--check` flag in CI catches forgotten rebuilds.

## Preprocessor architecture

The spike's MiniLexer skips lines starting with `#`. Production needs
`#include`, `#define`, `#if`/`#ifdef`/`#else`/`#endif`, and macro
substitution to compile real Apple `.r` files.

Phase 2 implements this **on the JS side**, not in MiniLexer:
`src/web/src/playground/preprocessor.ts` runs a TypeScript C-like
preprocessor over the source before handing it to the WASM. It pulls
includes from a virtual filesystem (RIncludes static assets +
IndexedDB-backed user files) and emits a single flattened source string.

Why this architecture instead of extending MiniLexer.cc:

1. The WASM artefact stays stable. We don't need to rebuild every time
   we improve preprocessor coverage.
2. The IDB-VFS bridge is naturally a JS concern; doing it through
   Emscripten's FS would mean a bidirectional async-file callback that's
   awkward to plumb.
3. Error reporting can use the host-side line/column directly, including
   include-stack frames.
4. Future-proofing: if MiniLexer ever needs to be replaced with mcpp,
   the JS preprocessor stays as the orchestration layer.

If a `.r` file uses a Wave-specific construct that the JS preprocessor
can't handle (variadic macros, `__VA_ARGS__`, stringification with `#`,
token-paste with `##`), the documented week-2 fallback is to vendor mcpp
as an additional WASM blob. As of Phase 2 this hasn't been needed.
