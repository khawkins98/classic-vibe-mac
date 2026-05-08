/**
 * shared-poller.test.mjs — Unit tests for the toMacRoman encoder in shared-poller.ts.
 *
 * Exercises the MacRoman transcoder that converts UTF-8 HTML body text to
 * the byte encoding the Mac expects when Reader reads the result file.
 *
 * Run as: node tests/unit/shared-poller.test.mjs
 */

import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// Transpile shared-poller.ts via esbuild (same approach as preprocessor.test.mjs).
const js = execSync(
  `npx esbuild --bundle=false --format=esm --platform=node ` +
  `${join(REPO, "src/web/src/shared-poller.ts")}`,
  { encoding: "utf-8" }
);
// Wrap in a data URL so we can import it as a module without writing a tmp file.
const mod = await import(`data:text/javascript,${encodeURIComponent(js)}`);
const { toMacRoman } = mod;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

// ASCII passthrough — bytes 0x00-0x7F must map 1:1.
test("ASCII text passes through unchanged", () => {
  const bytes = toMacRoman("Hello, World!");
  assert.deepEqual(Array.from(bytes), [72,101,108,108,111,44,32,87,111,114,108,100,33]);
});

// Smart quotes normalised → ASCII before encode.
test("smart left double quote → 0x22", () => {
  const bytes = toMacRoman("\u201CHello");
  assert.equal(bytes[0], 0x22); // '"'
});

test("smart right single quote → 0x27", () => {
  const bytes = toMacRoman("\u2019s");
  assert.equal(bytes[0], 0x27); // "'"
});

test("en-dash → hyphen (0x2D)", () => {
  const bytes = toMacRoman("\u2013");
  assert.equal(bytes[0], 0x2D);
});

test("em-dash → hyphen (0x2D)", () => {
  const bytes = toMacRoman("\u2014");
  assert.equal(bytes[0], 0x2D);
});

test("ellipsis → three dots", () => {
  const bytes = toMacRoman("\u2026");
  assert.deepEqual(Array.from(bytes), [0x2E, 0x2E, 0x2E]);
});

test("non-breaking space → regular space (0x20)", () => {
  const bytes = toMacRoman("\u00A0");
  assert.equal(bytes[0], 0x20);
});

// MacRoman-specific character — ä = 0x8A in MacRoman.
test("ä (U+00E4) maps to MacRoman 0x8A", () => {
  const bytes = toMacRoman("\u00E4");
  assert.equal(bytes[0], 0x8A);
});

// Unknown codepoint → '?' (0x3F).
test("unknown codepoint → question mark (0x3F)", () => {
  const bytes = toMacRoman("\u4E2D"); // CJK character — not in MacRoman
  assert.equal(bytes[0], 0x3F);
});

// Length check — output length must be >= input ASCII length.
test("output length matches input for ASCII", () => {
  const s = "The quick brown fox";
  const bytes = toMacRoman(s);
  assert.equal(bytes.length, s.length);
});

// BOM stripped.
test("BOM is stripped (zero output bytes)", () => {
  const bytes = toMacRoman("\uFEFF");
  assert.equal(bytes.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
