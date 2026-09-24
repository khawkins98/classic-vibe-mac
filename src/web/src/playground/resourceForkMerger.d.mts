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

export interface DecodedResourceFork {
  /** Resource-map attributes word (map+22). */
  mapAttrs: number;
  resources: DecodedResource[];
}

export interface MergeOptions {
  /**
   * Which occurrence of a duplicate `(type, id)` survives: "first"
   * (default) keeps the earliest fork's, "last" keeps the latest's.
   */
  onConflict?: "first" | "last";
}

export interface EncodeOptions {
  /** Resource-map attributes word to write at map+22. Default 0. */
  mapAttrs?: number;
}

export function mergeResourceForks(
  forks: Uint8Array[],
  options?: MergeOptions,
): Uint8Array;
export function decodeResourceFork(fork: Uint8Array): DecodedResource[];
export function decodeResourceForkMap(fork: Uint8Array): DecodedResourceFork;
export function encodeResourceFork(
  resources: DecodedResource[],
  options?: EncodeOptions,
): Uint8Array;
