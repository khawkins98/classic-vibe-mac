# Spike build: Rez compiled standalone, with two flavours:
#   - native (default)   : ground-truth build with Boost.Wave from Homebrew.
#   - wasm-mini (-DSPIKE_WASM=ON) : drops Boost.Wave entirely. Uses our own
#     MiniLexer.cc instead of RezLexer.cc + RezLexerNextToken.cc.
#
# The mini build also drops Boost.{filesystem,thread,regex,program_options}
# by replacing their use with std::filesystem / std::regex / a hand-rolled
# arg parser. See the `mini-rez` target below.
cmake_minimum_required(VERSION 3.16)
project(rez-spike CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(POLICY CMP0167)
    cmake_policy(SET CMP0167 NEW)
endif()

option(SPIKE_WASM "Build for WebAssembly via Emscripten" OFF)
option(SPIKE_MINI "Build the mini variant (no Boost.Wave / no Boost compiled libs)" OFF)

set(REZ_SRC ${CMAKE_CURRENT_SOURCE_DIR}/vendor/retro68)

# Bison-generated parser
find_program(BISON_EXE bison
    HINTS /opt/homebrew/opt/bison/bin /usr/local/opt/bison/bin)
if(NOT BISON_EXE)
    message(FATAL_ERROR "bison >= 3.0.2 not found")
endif()

set(BISON_OUT_DIR ${CMAKE_CURRENT_BINARY_DIR}/bison)
file(MAKE_DIRECTORY ${BISON_OUT_DIR})
set(REZ_PARSER_CC ${BISON_OUT_DIR}/RezParser.generated.cc)
set(REZ_PARSER_HH ${BISON_OUT_DIR}/RezParser.generated.hh)

add_custom_command(
    OUTPUT ${REZ_PARSER_CC} ${REZ_PARSER_HH}
           ${BISON_OUT_DIR}/location.hh
           ${BISON_OUT_DIR}/position.hh
           ${BISON_OUT_DIR}/stack.hh
    COMMAND ${BISON_EXE} -o ${REZ_PARSER_CC} ${REZ_SRC}/Rez/RezParser.yy
    DEPENDS ${REZ_SRC}/Rez/RezParser.yy
    WORKING_DIRECTORY ${BISON_OUT_DIR}
    COMMENT "bison: RezParser"
)

# --- HFS shim header ---------------------------------------------------------
file(WRITE ${CMAKE_CURRENT_BINARY_DIR}/hfs_shim/hfs.h
     "#include \"${CMAKE_CURRENT_SOURCE_DIR}/vendor/hfs_stub.h\"\n")

# --- Common Rez sources ------------------------------------------------------
set(RESOURCEFILES_SRC
    ${REZ_SRC}/ResourceFiles/BinaryIO.cc
    ${REZ_SRC}/ResourceFiles/ResourceFile.cc
    ${REZ_SRC}/ResourceFiles/ResourceFork.cc
    ${REZ_SRC}/ResourceFiles/ResType.cc
)

set(REZ_CORE_SRC
    ${REZ_SRC}/Rez/RezWorld.cc
    ${REZ_SRC}/Rez/ResourceDefinitions.cc
    ${REZ_SRC}/Rez/Expression.cc
    ${REZ_SRC}/Rez/ResourceCompiler.cc
    ${REZ_SRC}/Rez/Diagnostic.cc
    ${REZ_PARSER_CC}
)

# --- Native (Boost.Wave) build ----------------------------------------------
if(NOT SPIKE_MINI)
    set(Boost_NO_BOOST_CMAKE ON)
    find_package(Boost 1.71 REQUIRED COMPONENTS
        wave filesystem thread regex program_options)

    add_executable(rez
        ${REZ_SRC}/Rez/Rez.cc
        ${REZ_SRC}/Rez/RezLexer.cc
        ${REZ_SRC}/Rez/RezLexerNextToken.cc
        ${REZ_CORE_SRC}
        ${RESOURCEFILES_SRC}
    )

    target_include_directories(rez BEFORE PRIVATE
        ${CMAKE_CURRENT_BINARY_DIR}/hfs_shim
        ${REZ_SRC}/Rez
        ${REZ_SRC}/ResourceFiles
        ${BISON_OUT_DIR}
        ${Boost_INCLUDE_DIRS}
    )

    target_link_libraries(rez PRIVATE
        Boost::wave Boost::filesystem Boost::thread
        Boost::regex Boost::program_options
    )
endif()

# --- Mini build (no Boost.Wave) ---------------------------------------------
if(SPIKE_MINI)
    add_executable(mini-rez
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor/MiniLexer.cc
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor/Rez_main.cc
        ${REZ_CORE_SRC}
        ${RESOURCEFILES_SRC}
    )

    target_include_directories(mini-rez BEFORE PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor/boost_fs_shim     # boost::filesystem -> std::filesystem
        ${CMAKE_CURRENT_BINARY_DIR}/hfs_shim
        ${REZ_SRC}/Rez
        ${REZ_SRC}/ResourceFiles
        ${BISON_OUT_DIR}
    )

    if(NOT SPIKE_WASM)
        # Native mini build needs std::filesystem from libstdc++/libc++.
        # No Boost.Filesystem at all — our shim does the conversion.
    endif()

    if(SPIKE_WASM)
        target_compile_options(mini-rez PRIVATE -O2)
        set(EM_FLAGS
            "-O2"
            "-sALLOW_MEMORY_GROWTH=1"
            "-sMODULARIZE=1"
            "-sEXPORT_ES6=0"
            "-sEXPORT_NAME=createRezModule"
            "-sFORCE_FILESYSTEM=1"
            "-sEXPORTED_RUNTIME_METHODS=['FS','callMain','ENV']"
            "-sINVOKE_RUN=0"
            "-sEXIT_RUNTIME=1"
            "-sNO_DISABLE_EXCEPTION_CATCHING"
        )
        string(REPLACE ";" " " EM_FLAGS_STR "${EM_FLAGS}")
        set_target_properties(mini-rez PROPERTIES
            SUFFIX ".js"
            LINK_FLAGS "${EM_FLAGS_STR}"
        )
    endif()
endif()
