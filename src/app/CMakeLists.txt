# Minesweeper — classic Mac 68k application built with the Retro68 toolchain.
#
# Local build (requires Retro68 installed; see https://github.com/autc04/Retro68):
#
#   cmake -S . -B build \
#     -DCMAKE_TOOLCHAIN_FILE=/path/to/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake
#   cmake --build build
#
# Or, using the official Docker image (matches CI exactly):
#
#   docker run --rm -v "$PWD":/work -w /work ghcr.io/autc04/retro68:latest \
#     bash -c "cmake -S . -B build \
#       -DCMAKE_TOOLCHAIN_FILE=/Retro68-build/toolchain/m68k-apple-macos/cmake/retro68.toolchain.cmake \
#       && cmake --build build"
#
# Outputs in build/:
#   Minesweeper.bin   — MacBinary (both forks; this is the canonical artifact)
#   Minesweeper.dsk   — mountable HFS disk image containing the app
#   Minesweeper.APPL  — data fork only (often 0 bytes for resource-only apps)

cmake_minimum_required(VERSION 3.15)
project(Minesweeper C)

add_application(Minesweeper
    minesweeper.c
)

# Strip dead code and MacsBug function names to keep the binary small. Drop
# --mac-strip-macsbug if you need readable stack traces while debugging.
set_target_properties(Minesweeper PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(Minesweeper PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(Minesweeper PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
