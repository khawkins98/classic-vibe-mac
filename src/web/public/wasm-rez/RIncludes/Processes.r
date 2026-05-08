/*
 * Processes.r — playground stub for in-browser WASM-Rez.
 *
 * The upstream Apple/multiversal RIncludes ship one .r header per Toolbox
 * subsystem. The playground bundles the consolidated Multiverse.r umbrella
 * (all type defs in one file) and provides these five named stubs so that
 * existing source files written against the on-disk Retro68 install
 * (#include "Processes.r", "Menus.r", etc.) compile unchanged.
 *
 * If you need a type def that isn't in Multiverse.r, add it there directly
 * and re-vendor — the playground's TS-side preprocessor only knows about
 * files in this directory.
 */
#ifndef _PROCESSES_R_
#define _PROCESSES_R_
#include "Multiverse.r"
#endif
