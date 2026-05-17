/**
 * Type declarations for compilePipeline.mjs. Keep in lockstep with
 * the `runCompilePipeline` JSDoc on the .mjs side.
 */

import type { OptLevel } from "./compileArgs.mjs";

export interface PipelineTool {
  Module: {
    FS: {
      writeFile(path: string, data: string | Uint8Array): void;
      readFile(path: string): Uint8Array;
      unlink(path: string): void;
      mkdir(path: string): void;
      analyzePath?(path: string): { exists: boolean };
    };
    callMain(args: string[]): number;
  };
  /** Per-line stderr buffer. Runner drains between stages. */
  stderr: string[];
}

export interface PipelineSource {
  filename: string;
  content: string | Uint8Array;
}

export interface PipelineDeps {
  loadCc1(): Promise<PipelineTool>;
  loadAs(): Promise<PipelineTool>;
  loadLd(): Promise<PipelineTool>;
  loadElf2Mac(): Promise<PipelineTool>;
}

export interface PipelineStages {
  cc1Ms: number;
  asMs: number;
  ldMs: number;
  elf2macMs: number;
}

export interface PipelineResult {
  ok: boolean;
  bin?: Uint8Array;
  asm?: string;
  stages: PipelineStages;
  /** Raw stderr captured per stage call, each entry prefixed
   *  `[stage filename?]` for downstream splitting. */
  stderrPerStage: string[];
  failedStage?: "cc1" | "as" | "ld" | "elf2mac";
  failedFile?: string;
}

export function runCompilePipeline(
  input: {
    sources: PipelineSource[];
    primaryName?: string;
    optLevel?: OptLevel;
  },
  deps: PipelineDeps,
): Promise<PipelineResult>;
