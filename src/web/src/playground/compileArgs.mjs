/**
 * compileArgs.mjs — shared cc1/as/ld/Elf2Mac argv builders.
 *
 * Both the in-browser pipeline (cc1.ts → compileToBin) and the
 * Node-side CI audit (scripts/audit-wasm-samples.mjs) drive the same
 * wasm-cc1 toolchain. Until this module existed they each maintained
 * their own copy of the argv arrays for cc1/as/ld/Elf2Mac. When a
 * flag drifted between them — e.g. someone added `-mcpu=68030` to
 * one path and forgot the other — the audit could go green while
 * production failed (the inverse of the #267 sysroot-mount story).
 *
 * Plain .mjs so it loads from both:
 *   - Vite (cc1.ts imports as a TS-compatible JS module)
 *   - vanilla Node (audit script imports directly)
 *
 * Each function takes the per-invocation knobs (input paths, output
 * paths, optLevel) and returns the full argv array. The constants
 * inside (sysroot include paths, ld script, link-time archive
 * group, etc.) are the contract — change them HERE and both sides
 * pick it up.
 *
 * This is refactor #3 of the #267 post-mortem chain. A fuller
 * "isomorphic compile harness" (shared pipeline runner, not just
 * shared argv) is a larger separate effort discussed in the PR
 * description.
 */

/**
 * cc1 argv: compile a single .c file to .s (assembly).
 *
 * @param {Object} opts
 * @param {string} opts.source       Path inside MEMFS, e.g. `/tmp/foo.c`.
 * @param {string} opts.output       Path inside MEMFS, e.g. `/tmp/foo.s`.
 * @param {"O0"|"Os"|"O2"} [opts.optLevel="O0"]  Optimization level.
 * @returns {string[]}
 */
export function cc1Args(opts) {
  return [
    "-quiet",
    "-isystem", "/sysroot/gcc-include",
    "-isystem", "/sysroot/include",
    "-mcpu=68020",
    `-${opts.optLevel ?? "O0"}`,
    opts.source,
    "-o", opts.output,
  ];
}

/**
 * as argv: assemble .s -> .o.
 *
 * @param {Object} opts
 * @param {string} opts.source       Path inside MEMFS, e.g. `/tmp/foo.s`.
 * @param {string} opts.output       Path inside MEMFS, e.g. `/tmp/foo.o`.
 * @returns {string[]}
 */
export function asArgs(opts) {
  return ["-march=68020", opts.source, "-o", opts.output];
}

/**
 * ld argv: link a set of .o files against the Retro68 runtime archives,
 * producing the relocatable ELF that Elf2Mac consumes.
 *
 * @param {Object} opts
 * @param {string[]} opts.objects    Per-source .o paths inside MEMFS.
 * @param {string} opts.output       ELF output path, e.g. `/tmp/out.gdb`.
 * @returns {string[]}
 */
export function ldArgs(opts) {
  return [
    "-T", "/sysroot/ld/retro68-multiseg.ld",
    "-L", "/sysroot/lib",
    "--no-warn-rwx-segments",
    "--emit-relocs",
    "-o", opts.output,
    "/sysroot/lib/start.c.obj",
    ...opts.objects,
    "--start-group",
    "/sysroot/lib/libretrocrt.a",
    "/sysroot/lib/libInterface.a",
    "/sysroot/lib/libc.a",
    "/sysroot/lib/libm.a",
    "/sysroot/lib/libgcc.a",
    "--end-group",
  ];
}

/**
 * Elf2Mac argv: convert the linked ELF to a MacBinary II archive.
 *
 * @param {Object} opts
 * @param {string} opts.output       MacBinary output path, e.g. `/tmp/out.bin`.
 *                                   (The input is implicit — Elf2Mac reads
 *                                   `<output>.gdb` from the same directory.)
 * @returns {string[]}
 */
export function elf2macArgs(opts) {
  return ["--elf2mac", "-o", opts.output];
}
