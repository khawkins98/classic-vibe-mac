/**
 * _transpile.mjs — shared helper for unit tests that exercise pure-logic
 * TypeScript modules under src/web/src.
 *
 * Same approach as preprocessor.test.mjs / hfs-patcher.test.mjs: drive
 * the workspace tsc into a temp dir and dynamic-import the emitted ESM.
 * `--rootDir src/web/src` keeps the output layout predictable
 * (src/web/src/foo.ts → <out>/foo.js, playground/x.ts → <out>/playground/x.js).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Transpile the given files (paths relative to src/web/src) and return
 *  a function mapping a relative .ts path to an importable file URL. */
export function transpileWeb(relFiles) {
  const out = mkdtempSync(join(tmpdir(), "cvm-web-test-"));
  const tscPath = join(REPO, "node_modules", ".bin", "tsc");
  const files = relFiles.map((f) => join("src/web/src", f)).join(" ");
  execSync(
    `${tscPath} ${files} ` +
      `--target ES2022 --module ES2020 --moduleResolution bundler ` +
      `--esModuleInterop --skipLibCheck --strict --lib ES2022,DOM ` +
      `--rootDir src/web/src --outDir ${out}`,
    { cwd: REPO, stdio: ["ignore", "inherit", "inherit"] },
  );
  return (rel) => pathToFileURL(join(out, rel.replace(/\.ts$/, ".js"))).href;
}
