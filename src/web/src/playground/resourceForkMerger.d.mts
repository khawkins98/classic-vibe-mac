/**
 * Type declarations for resourceForkMerger.mjs. Keep in lockstep
 * with the JSDoc on the .mjs side.
 */

export interface DecodedResource {
  type: string;
  id: number;
  name: string | null;
  attrs: number;
  data: Uint8Array;
}

export function mergeResourceForks(forks: Uint8Array[]): Uint8Array;
export function decodeResourceFork(fork: Uint8Array): DecodedResource[];
export function encodeResourceFork(resources: DecodedResource[]): Uint8Array;
