/**
 * vfs.ts — virtual filesystem for the in-browser WASM-Rez compile.
 *
 * Track 5 of Issue #30: when WASM-Rez wants to read a `.r` source file
 * (top-level user buffer) or a `#include`d header, the JS-side preprocessor
 * (preprocessor.ts) calls into a `Vfs` to resolve the file. Two backends
 * compose into one:
 *
 *   1. The user's IDB-stored project files (the canonical source of truth
 *      for what they've been editing in the playground). Read with
 *      `readFile()` from persistence.ts.
 *   2. The vendored RIncludes/ static-asset bundle under
 *      /wasm-rez/RIncludes/, fetched via plain `fetch()`. These are the
 *      Apple multiversal headers (Multiverse.r umbrella + 5 named
 *      stubs) — see src/web/public/wasm-rez/RIncludes/README.
 *
 * Name routing:
 *   - Any `#include` whose filename matches a name in `BUNDLED_RINCLUDES`
 *     (Multiverse.r, Menus.r, …) is routed to the RIncludes bundle.
 *   - Every other name is routed to the project's IDB bucket.
 *
 * The two buckets live in separate namespaces (`r:<name>` vs `p:<name>`)
 * so a project file that happens to be called `MacTypes.r` would NOT
 * shadow the system header — it'd live under `p:MacTypes.r` but lookups
 * for `MacTypes.r` always resolve to `r:MacTypes.r`. Per-project overrides
 * of the bundled headers are intentionally not supported today.
 *
 * If neither resolves, the preprocessor reports `cannot find #include
 * file 'X'`.
 *
 * The Vfs interface (defined in preprocessor.ts) is *synchronous*. We
 * resolve that mismatch by `prefetch`ing every file that might be touched
 * before invoking the preprocessor, so the synchronous reads hit a
 * pre-populated cache. Side benefit: the prefetch is ONE network round
 * trip per file across the whole compile, even when the same RInclude
 * is `#include`d transitively many times.
 */

import { readFile } from "./persistence";
import type { Vfs } from "./preprocessor";

/**
 * The set of files we ship under public/wasm-rez/RIncludes/. We keep this
 * declarative so prefetch can warm the cache even before we know exactly
 * which `#include`s a particular .r file is going to issue. (At ~7KB
 * total, it's fine to fetch them all upfront on the first compile.)
 *
 * Production note: extending this list is part of the contract — if you
 * add a new .r header to public/wasm-rez/RIncludes/, also add it here so
 * prefetch picks it up.
 */
const BUNDLED_RINCLUDES = [
  "Multiverse.r",
  "Processes.r",
  "Menus.r",
  "Windows.r",
  "Dialogs.r",
  "MacTypes.r",
] as const;

export interface CachedVfs extends Vfs {
  /**
   * Fetch every file the playground might reference for `projectId` so
   * the preprocessor's synchronous reads are guaranteed to hit. Safe to
   * call concurrently — the underlying cache deduplicates.
   */
  prefetch(projectId: string, projectFiles: readonly string[]): Promise<void>;
}

export function createVfs(baseUrl: string, _projectId: string): CachedVfs {
  const cache = new Map<string, string>();

  /**
   * Canonical name for a file. Format: `<bucket>:<name>` where bucket is
   * "p" for project (IDB-backed) or "r" for RIncludes (static asset).
   * The bucket prefix prevents an IDB project file from "shadowing"
   * an RInclude in the cycle-guard set, even when names happen to match.
   */
  const canonicalName = (name: string, _fromFile: string): string => {
    if (BUNDLED_RINCLUDES.includes(name as (typeof BUNDLED_RINCLUDES)[number])) {
      return `r:${name}`;
    }
    return `p:${name}`;
  };

  const read = (name: string, _fromFile: string): string | undefined => {
    return cache.get(canonicalName(name, _fromFile));
  };

  const prefetch = async (
    project: string,
    projectFiles: readonly string[],
  ): Promise<void> => {
    // 1. RInclude headers — fetched once, kept for the lifetime of the
    //    Vfs. The bucket prefix is "r:", separate from project files'
    //    "p:" — so the two namespaces never collide. (See header comment:
    //    project-file overrides of bundled headers are intentionally not
    //    supported today.)
    await Promise.all(
      BUNDLED_RINCLUDES.map(async (name) => {
        const key = `r:${name}`;
        if (cache.has(key)) return;
        try {
          const res = await fetch(`${baseUrl}wasm-rez/RIncludes/${name}`);
          if (!res.ok) return;
          cache.set(key, await res.text());
        } catch {
          // Network failure → cache miss → preprocessor error. The
          // playground UI surfaces it.
        }
      }),
    );
    // 2. Project files from IDB. Anyone of them might be #include'd by
    //    the top-level .r (cross-file edits). Empty/missing files just
    //    don't get added to the cache.
    await Promise.all(
      projectFiles.map(async (name) => {
        const key = `p:${name}`;
        const stored = await readFile(project, name);
        if (stored !== undefined) cache.set(key, stored);
      }),
    );
  };

  return { read, canonicalName, prefetch };
}
