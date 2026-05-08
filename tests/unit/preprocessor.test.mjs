/**
 * preprocessor.test.mjs — Node-side unit tests for preprocessor.ts.
 *
 * Track 4 of Issue #30: smoke coverage for the JS preprocessor against
 * (a) synthetic conditional-compilation cases, (b) the real reader.r and
 * macweather.r the playground actually compiles.
 *
 * The preprocessor is pure TypeScript (no DOM, no Emscripten), so these
 * tests run in plain Node with no browser harness. We compile through
 * tsc on the fly via tsx — tsx is not a dependency, so we hand-roll the
 * compile by importing the .ts file via a transpile shim.
 *
 * Run as: node tests/unit/preprocessor.test.mjs
 */

import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// On-the-fly transpile: drive tsc on the playground sources into a temp
// dir, then import the JS. Slower than the test runs but keeps test
// dependencies near-zero.
function transpilePlayground() {
  const out = mkdtempSync(join(tmpdir(), "cvm-pp-test-"));
  // Use the workspace's tsc; emit ESM so we can dynamic-import.
  const tscPath = join(REPO, "node_modules", ".bin", "tsc");
  // Compile only the files we actually need so we don't pull in the
  // editor.ts → CodeMirror chain.
  execSync(
    `${tscPath} src/web/src/playground/preprocessor.ts ` +
      `--target ES2020 --module ES2020 --moduleResolution node ` +
      `--esModuleInterop --skipLibCheck --strict ` +
      `--outDir ${out}`,
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  return out;
}

const outDir = transpilePlayground();
// tsc emits flat (no original path) when only one source file is passed
// as a positional argument and rootDir is the file's containing dir.
const { preprocess } = await import(join(outDir, "preprocessor.js"));

// ── Test infrastructure ─────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.message}`);
    fail++;
  }
}

function makeVfs(files) {
  return {
    read(name) {
      return files.get(name);
    },
    canonicalName(name) {
      return name;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

test("plain content passes through", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess("hello\nworld\n", "in.r", vfs);
  assert.equal(r.diagnostics.length, 0);
  assert.match(r.output, /hello/);
  assert.match(r.output, /world/);
});

test("strips C-style comments but preserves line count", () => {
  const vfs = makeVfs(new Map());
  const input = "a\n/* comment\nspans\nlines */\nb\n";
  const r = preprocess(input, "in.r", vfs);
  // The newline count of the output should match the input (or differ by
  // at most one trailing empty string from split). The point of the test
  // is that downstream Rez "error on line N" still maps to the same N
  // the user sees in their editor.
  const inLines = input.split("\n").length;
  const outLines = r.output.split("\n").length;
  assert.ok(
    Math.abs(outLines - inLines) <= 1,
    `line count drift too large: in=${inLines} out=${outLines}`,
  );
  assert.match(r.output, /a/);
  assert.match(r.output, /b/);
  assert.doesNotMatch(r.output, /comment/);
});

test("// comments stripped", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess("a // hello\nb\n", "in.r", vfs);
  assert.match(r.output, /a /);
  assert.doesNotMatch(r.output, /hello/);
});

test("// inside a string is preserved", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(`x = "//notacomment";\n`, "in.r", vfs);
  assert.match(r.output, /\/\/notacomment/);
});

test("#define + object-like substitution", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(
    "#define FOO 42\nresult = FOO + 1;\n",
    "in.r",
    vfs,
  );
  assert.equal(r.diagnostics.length, 0);
  assert.match(r.output, /result = 42 \+ 1/);
});

test("#define function-like with arg substitution", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(
    "#define ADD(a,b) ((a) + (b))\nx = ADD(2, 3);\n",
    "in.r",
    vfs,
  );
  assert.equal(r.diagnostics.length, 0);
  assert.match(r.output, /x = \(\(2\) \+ \(3\)\)/);
});

test("#ifdef/#endif honours macro table", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(
    "#define X\n#ifdef X\nyes\n#endif\n#ifdef Y\nno\n#endif\n",
    "in.r",
    vfs,
  );
  assert.match(r.output, /yes/);
  assert.doesNotMatch(r.output, /\bno\b/);
});

test("#if/#else honours expression", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(
    "#if 1+1 == 2\ntwo\n#else\nfour\n#endif\n",
    "in.r",
    vfs,
  );
  assert.match(r.output, /two/);
  assert.doesNotMatch(r.output, /four/);
});

test("#elif chain picks the first true branch", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(
    "#define X 2\n#if X == 1\none\n#elif X == 2\ntwo\n#elif X == 3\nthree\n#else\nother\n#endif\n",
    "in.r",
    vfs,
  );
  assert.match(r.output, /two/);
  assert.doesNotMatch(r.output, /one/);
  assert.doesNotMatch(r.output, /three/);
});

test("#include resolves through VFS", () => {
  const vfs = makeVfs(new Map([["other.r", "from-other\n"]]));
  const r = preprocess(`#include "other.r"\nfrom-main\n`, "in.r", vfs);
  assert.equal(r.diagnostics.length, 0);
  assert.match(r.output, /from-other/);
  assert.match(r.output, /from-main/);
});

test("#include guard pattern", () => {
  // Include the same file twice — the second include's body should be
  // omitted thanks to the standard #ifndef guard.
  const headerBody =
    "#ifndef _H_\n#define _H_\nguarded-body\n#endif\n";
  const vfs = makeVfs(new Map([["h.r", headerBody]]));
  const r = preprocess(
    `#include "h.r"\n#include "h.r"\n`,
    "in.r",
    vfs,
  );
  // Should appear exactly once in the output.
  const matches = r.output.match(/guarded-body/g) ?? [];
  assert.equal(matches.length, 1, `expected 1 match, got ${matches.length}`);
});

test("#error surfaces a diagnostic", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(`#error this is bad\n`, "in.r", vfs);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].severity, "error");
  assert.match(r.diagnostics[0].message, /this is bad/);
});

test("missing #include surfaces a diagnostic", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(`#include "nope.r"\n`, "in.r", vfs);
  assert.equal(r.diagnostics.length, 1);
  assert.equal(r.diagnostics[0].severity, "error");
});

test("predefined macros honoured", () => {
  const vfs = makeVfs(new Map());
  const r = preprocess(`x = TRUE;\n`, "in.r", vfs, { TRUE: "1" });
  assert.match(r.output, /x = 1/);
});

test("real reader.r preprocesses against bundled RIncludes", () => {
  const readerR = readFileSync(
    join(REPO, "src", "app", "reader", "reader.r"),
    "utf8",
  );
  const RINC = join(REPO, "src", "web", "public", "wasm-rez", "RIncludes");
  const headers = new Map();
  for (const f of ["Multiverse.r", "Processes.r", "Menus.r", "Windows.r", "Dialogs.r", "MacTypes.r"]) {
    headers.set(f, readFileSync(join(RINC, f), "utf8"));
  }
  const vfs = makeVfs(headers);
  const r = preprocess(readerR, "reader.r", vfs, {
    Rez: "1",
    DeRez: "0",
    true: "1",
    false: "0",
    TRUE: "1",
    FALSE: "0",
  });
  // We expect zero error-severity diagnostics. Warnings are tolerable.
  const errs = r.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(
    errs,
    [],
    `unexpected errors: ${errs.map((e) => `${e.file}:${e.line}: ${e.message}`).join("; ")}`,
  );
  // The output should contain the type definitions from Multiverse.r —
  // 'STR ', 'MENU', 'WIND', etc.
  assert.match(r.output, /type 'STR#'/);
  assert.match(r.output, /type 'MENU'/);
  assert.match(r.output, /type 'WIND'/);
  // And the user's resource definitions.
  assert.match(r.output, /resource 'WIND' \(128\)/);
});

test("real macweather.r preprocesses", () => {
  const src = readFileSync(
    join(REPO, "src", "app", "macweather", "macweather.r"),
    "utf8",
  );
  const RINC = join(REPO, "src", "web", "public", "wasm-rez", "RIncludes");
  const headers = new Map();
  for (const f of ["Multiverse.r", "Processes.r", "Menus.r", "Windows.r", "Dialogs.r", "MacTypes.r"]) {
    headers.set(f, readFileSync(join(RINC, f), "utf8"));
  }
  const vfs = makeVfs(headers);
  const r = preprocess(src, "macweather.r", vfs, {
    Rez: "1",
    DeRez: "0",
    true: "1",
    false: "0",
    TRUE: "1",
    FALSE: "0",
  });
  const errs = r.diagnostics.filter((d) => d.severity === "error");
  assert.deepEqual(
    errs,
    [],
    `unexpected errors: ${errs.map((e) => `${e.file}:${e.line}: ${e.message}`).join("; ")}`,
  );
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
