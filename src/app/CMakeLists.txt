# Retro68 CMake build for Minesweeper
cmake_minimum_required(VERSION 3.15)
project(Minesweeper C)

# TODO: configure Retro68 toolchain
# cmake -DCMAKE_TOOLCHAIN_FILE=<retro68>/toolchain/m68k-apple-macos.cmake ..

add_application(Minesweeper
    minesweeper.c
)
