/**
 * share-link.test.mjs — unit tests for src/web/src/shareLink.ts.
 *
 * Covers the URL round-trip (project / filename / gzip+base64url
 * content), the 8 KB truncation guard, and the "bad ?c= payload falls
 * back to project-only" behaviour. Runs in plain Node: CompressionStream,
 * Blob, Response, btoa/atob are all Node globals (>= 18).
 *
 * Run as: node --test tests/unit/share-link.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { transpileWeb } from "./_transpile.mjs";

const url = transpileWeb(["shareLink.ts"]);
const { parseShareUrl, buildShareUrl } = await import(url("shareLink.ts"));

const BASE = "https://example.test/playground/";

function searchOf(u) {
  return new URL(u).search;
}

test("parseShareUrl returns null without a project param", async () => {
  assert.equal(await parseShareUrl(""), null);
  assert.equal(await parseShareUrl("?f=snake.c"), null);
});

test("project + filename only (no content)", async () => {
  const { url: u, truncated } = await buildShareUrl("snake", "snake.c", undefined, BASE);
  assert.equal(truncated, false);
  assert.equal(u, `${BASE}?p=snake&f=snake.c`);
  assert.deepEqual(await parseShareUrl(searchOf(u)), {
    projectId: "snake",
    filename: "snake.c",
  });
});

test("filename is optional", async () => {
  const { url: u } = await buildShareUrl("reader", undefined, undefined, BASE);
  assert.equal(u, `${BASE}?p=reader`);
  const parsed = await parseShareUrl(searchOf(u));
  assert.equal(parsed.projectId, "reader");
  assert.equal(parsed.filename, undefined);
});

test("content round-trips, including non-ASCII and URL-hostile chars", async () => {
  const content =
    '#include <Quickdraw.h>\n/* café ☕ — “quotes” & a+b=c/d?e */\nint main(void) { return 0; }\n';
  const { url: u, truncated } = await buildShareUrl("snake", "snake.c", content, BASE);
  assert.equal(truncated, false);
  const c = new URL(u).searchParams.get("c");
  assert.ok(c, "expected a c= param");
  assert.match(c, /^[A-Za-z0-9_-]+$/, "c= must be base64url with no padding");
  const parsed = await parseShareUrl(searchOf(u));
  assert.deepEqual(parsed, { projectId: "snake", filename: "snake.c", content });
});

test("compressible content well over 8 KB raw still fits", async () => {
  const content = "DrawString(\"\\pHello\");\n".repeat(1000); // ~24 KB raw
  const { url: u, truncated } = await buildShareUrl("p", "f.c", content, BASE);
  assert.equal(truncated, false);
  assert.ok(u.length <= 8000);
  assert.equal((await parseShareUrl(searchOf(u))).content, content);
});

test("incompressible content over the cap drops c= and flags truncated", async () => {
  // Pseudo-random printable bytes defeat gzip.
  let seed = 12345;
  let content = "";
  for (let i = 0; i < 12000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    content += String.fromCharCode(33 + (seed % 94));
  }
  const { url: u, truncated } = await buildShareUrl("p", "f.c", content, BASE);
  assert.equal(truncated, true);
  assert.equal(u, `${BASE}?p=p&f=f.c`);
});

test("corrupt c= payload falls back to project + filename", async () => {
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const parsed = await parseShareUrl("?p=snake&f=snake.c&c=%%%not-base64%%%");
    assert.deepEqual(parsed, { projectId: "snake", filename: "snake.c" });
  } finally {
    console.warn = origWarn;
  }
});

test("uncompressed (legacy-browser) payload still decodes", async () => {
  // An encoder without CompressionStream emits raw UTF-8 as base64url.
  const text = "int x = 1;\n";
  const legacy = Buffer.from(text, "utf8").toString("base64url");
  const parsed = await parseShareUrl(`?p=snake&c=${legacy}`);
  assert.equal(parsed.content, text);
});
