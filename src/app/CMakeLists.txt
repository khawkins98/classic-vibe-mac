# classic-vibe-mac — top-level Mac-app build.
#
# Aggregates each app under src/app/<name>/. Every app has its own
# CMakeLists.txt and is built independently by Retro68's add_application().
# Adding a new app is one add_subdirectory() call below.
#
# Local build (requires Retro68 installed; see https://github.com/autc04/Retro68):
#
#   cmake -S src/app -B build \
#     -DCMAKE_TOOLCHAIN_FILE=/path/to/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake
#   cmake --build build --parallel
#
# Or, using the official Docker image (matches CI exactly):
#
#   docker run --rm -v "$PWD":/work -w /work ghcr.io/autc04/retro68:latest \
#     bash -c "cmake -S src/app -B build \
#       -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
#       && cmake --build build --parallel"
#
# Outputs: none. The precompiled-app path retired 2026-05-17 (#276):
#   - Reader / MacWeather / HelloMac retired in Phase 1A (#277)
#   - PixelPad / MarkdownViewer retired in Phase 1B (this commit)
#
# Every app the playground ships now compiles in-browser via wasm-cc1
# (src/app/wasm-*/). The CMake aggregator is kept as scaffolding for
# any future host-native build, but the add_subdirectory() list is
# empty; CI still configures+builds this tree so it doesn't rot.

cmake_minimum_required(VERSION 3.15)
project(classic_vibe_mac C)

# No subdirectories — see comment above. New Mac apps go under
# src/app/wasm-<name>/ (sample-shelf entry in playground/types.ts).
