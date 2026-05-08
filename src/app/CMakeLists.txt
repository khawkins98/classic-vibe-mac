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
#   build/reader/Reader.{bin,dsk,APPL}
#   build/macweather/MacWeather.{bin,dsk,APPL}
#   build/hello-mac/HelloMac.{bin,dsk,APPL}
#
# The .bin files are MacBinary (both forks) and feed scripts/build-boot-disk.sh.

cmake_minimum_required(VERSION 3.15)
project(classic_vibe_mac C)

add_subdirectory(reader)
add_subdirectory(macweather)
add_subdirectory(hello-mac)
