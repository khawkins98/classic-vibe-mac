/**
 * error-explainer.test.mjs — unit tests for errorExplainer.ts (issue #334).
 *
 * errorExplainer.ts is a pure pattern table (no DOM), so we transpile it
 * with the workspace tsc into a temp dir and import the emitted JS —
 * same approach as preprocessor.test.mjs.
 *
 * Run as: node --test tests/unit/error-explainer.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const outDir = mkdtempSync(join(tmpdir(), "cvm-explain-test-"));
execSync(
  `${join(REPO, "node_modules", ".bin", "tsc")} src/web/src/playground/errorExplainer.ts ` +
    `--target ES2020 --module ES2020 --moduleResolution bundler ` +
    `--esModuleInterop --skipLibCheck --strict --outDir ${outDir}`,
  { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
);
const { explainError } = await import(join(outDir, "errorExplainer.js"));

function idOf(msg) {
  return explainError(msg)?.id ?? null;
}

test("implicit declaration of a known Toolbox call names the header", () => {
  const r = explainError("implicit declaration of function 'DrawString' [-Wimplicit-function-declaration]");
  assert.equal(r.id, "implicit-decl-toolbox");
  assert.match(r.hint, /#include <Quickdraw\.h>/);
});

test("implicit declaration with GCC curly quotes", () => {
  const r = explainError("implicit declaration of function ‘NewWindow’");
  assert.match(r.hint, /MacWindows\.h/);
});

test("implicit declaration of an unknown function gets generic hint", () => {
  const r = explainError("implicit declaration of function 'myHelper'");
  assert.equal(r.id, "implicit-decl-toolbox");
  assert.match(r.hint, /myHelper/);
  assert.doesNotMatch(r.hint, /#include </);
});

test("undeclared identifier", () => {
  assert.equal(idOf("'inContent' undeclared (first use in this function)"), "undeclared-identifier");
});

test("unknown Mac type", () => {
  const r = explainError("unknown type name 'WindowPtr'");
  assert.equal(r.id, "unknown-type");
  assert.match(r.hint, /MacTypes\.h/);
});

test("missing header file", () => {
  assert.equal(idOf("Windows.h: No such file or directory"), "missing-header");
});

test("expected ';'", () => {
  assert.equal(idOf("expected ';' before 'return'"), "expected-semicolon");
  assert.equal(idOf("expected ‘;’ before ‘}’ token"), "expected-semicolon");
});

test("expected declaration at end of input", () => {
  assert.equal(idOf("expected declaration or statement at end of input"), "expected-brace-eof");
});

test("expected ')'", () => {
  assert.equal(idOf("expected ')' before ';' token"), "expected-paren");
});

test("\\p escape misuse", () => {
  assert.equal(idOf("unknown escape sequence: '\\p'"), "pascal-string");
});

test("C string passed where Pascal string expected", () => {
  assert.equal(
    idOf("passing argument 1 of 'DrawString' from incompatible pointer type; expected 'ConstStr255Param' but argument is of type 'char *'"),
    "pascal-vs-c-string",
  );
});

test("Handle / Ptr mismatch", () => {
  const r = explainError("assignment from incompatible pointer type");
  assert.equal(r.id, "incompatible-handle-ptr");
  assert.match(r.hint, /Handle/);
  assert.equal(idOf("initialization makes pointer from integer without a cast"), "incompatible-handle-ptr");
});

test("argument count", () => {
  assert.equal(idOf("too few arguments to function 'MoveTo'"), "too-few-args");
});

test("undefined reference at link time", () => {
  const r = explainError("main.o: in function `main': undefined reference to `DoThing'");
  assert.equal(r.id, "undefined-reference");
  assert.match(r.hint, /DoThing/);
});

test("multiple definition / redefinition", () => {
  assert.equal(idOf("multiple definition of `gCount'"), "multiple-definition");
  assert.equal(idOf("redefinition of 'DrawAll'"), "multiple-definition");
});

test("missing resource", () => {
  assert.equal(idOf("resource 'WIND' (128) not found"), "missing-resource");
});

test("full file:line:col prefix still matches", () => {
  assert.equal(idOf("hello.c:12:5: error: expected ';' before 'x'"), "expected-semicolon");
});

test("unrecognised or empty message returns null", () => {
  assert.equal(explainError("something entirely novel happened"), null);
  assert.equal(explainError(""), null);
});
