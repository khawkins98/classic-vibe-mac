/**
 * Type declarations for compileArgs.mjs — the .mjs file is plain JS
 * (loadable from both Node and Vite) but TypeScript needs typings to
 * type-check the cc1.ts call sites. Keep this in lockstep with the
 * shape of each function in compileArgs.mjs.
 */

export type OptLevel = "O0" | "Os" | "O2";

export function cc1Args(opts: {
  source: string;
  output: string;
  optLevel?: OptLevel;
}): string[];

export function asArgs(opts: {
  source: string;
  output: string;
}): string[];

export function ldArgs(opts: {
  objects: string[];
  output: string;
}): string[];

export function elf2macArgs(opts: {
  output: string;
}): string[];
