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
# Outputs:
#   build/pixelpad/PixelPad.{bin,dsk,APPL}
#   build/markdownviewer/MarkdownViewer.{bin,dsk,APPL}
#
# The .bin files are MacBinary (both forks) and feed scripts/build-boot-disk.sh.
#
# Reader / MacWeather / HelloMac were removed 2026-05-17 (#276) — they
# were the original "auto-launches on Mac boot" demo apps from before
# in-browser compilation existed. With the in-browser playground now
# the canonical path for getting apps onto the Mac, the legacy CMake
# build serves only the boot-disk preinstall (PixelPad, MarkdownViewer)
# — and even that is on borrowed time once the deferred-boot UX lands.

cmake_minimum_required(VERSION 3.15)
project(classic_vibe_mac C)

add_subdirectory(pixelpad)
add_subdirectory(markdownviewer)
