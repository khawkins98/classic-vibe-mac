/**
 * Regression test for the wasm-rez C-stack overflow that limited any
 * single resource to ~1340 `$"…"` hex literals.
 *
 * Root cause: RezParser.yy's `string_expression` is left-recursive,
 * building an N-deep left-leaning BinaryExpr(CONCAT) AST for N hex
 * literals in one resource. The evaluator recurses through that tree,
 * one C stack frame per node. Emscripten's default `STACK_SIZE` is
 * 64KB → ~1340 frames before overflow. Cliff observed at the boundary
 * where Glypha III's PICTs trip it (1340-1572 literals per resource).
 *
 * Fix: bump STACK_SIZE in tools/wasm-rez/CMakeLists.txt to 8MB
 * (virtual address space, no physical cost until used).
 *
 * This test generates a synthetic input with 2000 literals in one
 * resource — comfortably past the old cliff, well under any plausible
 * real input — and asserts wasm-rez compiles it without crashing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

function runStress(inputPath) {
  return spawnSync(
    "node",
    [join(REPO, "scripts/stress-wasm-rez.mjs"), inputPath],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

function genBigResource(lineCount) {
  let s = `data 'PICT' (128, "synthetic-stress") {\n`;
  for (let i = 0; i < lineCount; i++) {
    s += `    $"AABBCCDDEEFF0011"\n`;
  }
  s += `};\n`;
  return s;
}

test("wasm-rez handles 2000 hex literals in a single resource (#286 regression)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "wasm-rez-stress-"));
  try {
    const inputPath = join(tmp, "stress.r");
    writeFileSync(inputPath, genBigResource(2000));
    const result = runStress(inputPath);
    const combined = (result.stdout || "") + (result.stderr || "");
    assert.equal(
      result.status,
      0,
      `wasm-rez crashed on 2000-literal resource (would have OOM'd at 64KB stack).\n` +
        `stdout/stderr:\n${combined}`,
    );
    assert.match(combined, /outcome: SUCCESS/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

/**
 * Real-world coverage: Glypha III's vendored 2.7 MB .r is the largest
 * input wasm-rez sees in this repo. Compiling it end-to-end here means
 * CI catches any future stack-bump regression *or* any change to the
 * vendored Glypha .r that introduces a resource too big to parse.
 *
 * The synthetic test above proves the stack ceiling. This one proves
 * the actual file we ship still fits under it.
 */
test("wasm-rez compiles the vendored Glypha .r (#256)", () => {
  const glyphaR = join(REPO, "src/app/wasm-glypha3/glypha3.r");
  if (!existsSync(glyphaR)) {
    // If the file is ever moved/renamed this test should fail loudly,
    // not silently skip — the assertion below makes that explicit.
    assert.fail(`expected vendored .r at ${glyphaR}`);
  }
  const result = runStress(glyphaR);
  const combined = (result.stdout || "") + (result.stderr || "");
  assert.equal(
    result.status,
    0,
    `wasm-rez failed on vendored Glypha .r.\nstdout/stderr:\n${combined}`,
  );
  assert.match(combined, /outcome: SUCCESS/);
});
