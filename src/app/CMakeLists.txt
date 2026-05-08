# Reader — classic Mac 68k HTML viewer built with the Retro68 toolchain.
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
#   Reader.bin    — MacBinary (both forks; this is the canonical artifact)
#   Reader.dsk    — mountable HFS disk image containing the app
#   Reader.APPL   — data fork only (often 0 bytes for resource-only apps)

cmake_minimum_required(VERSION 3.15)
project(Reader C)

# CREATOR "CVMR" stamps the MacBinary header (and therefore the .dsk and the
# baked boot-disk app) with our 4-char creator code. The Rez signature
# resource alone is NOT sufficient — Retro68's add_application defaults the
# .bin's Type/Creator to APPL/???? unless we override it here. With CVMR set
# both in the signature resource AND on the binary header, the Finder binds
# the app to its BNDL on first scan, and any TEXT/CVMR-tagged file
# double-click routes to Reader. See add_application.cmake (-t/-c flags
# passed to Rez when the wrapper builds the .bin).
add_application(Reader
    CREATOR CVMR
    reader.c
    html_parse.c
    reader.r
)

# Strip dead code and MacsBug function names to keep the binary small. Drop
# --mac-strip-macsbug if you need readable stack traces while debugging.
set_target_properties(Reader PROPERTIES COMPILE_OPTIONS -ffunction-sections)
if(CMAKE_SYSTEM_NAME MATCHES Retro68)
    set_target_properties(Reader PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections -Wl,--mac-strip-macsbug")
else()
    set_target_properties(Reader PROPERTIES
        LINK_FLAGS "-Wl,-gc-sections")
endif()
