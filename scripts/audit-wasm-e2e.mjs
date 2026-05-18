#!/usr/bin/env node
/*
 * audit-wasm-e2e.mjs — combined .c + .r local-build audit.
 *
 * Runs audit-wasm-samples (the .c side: cc1 → as → ld → elf2mac) and
 * audit-wasm-rez (the .r side: preprocessor → wasm-rez) and prints a
 * combined pass/fail line per sample. Use this before pushing a
 * playground change to catch bugs the in-browser pipeline would hit
 * — no browser tab, no deploy, ~5-15 seconds per full run depending
 * on machine + sample count.
 *
 * Usage:
 *   node scripts/audit-wasm-e2e.mjs            # every wasm-* sample
 *   node scripts/audit-wasm-e2e.mjs <name>     # just one
 *
 * Exit codes:
 *   0  every sample passed BOTH the .c audit and the .r audit
 *   1  ≥1 sample failed on at least one side
 *
 * Implementation: subprocess-orchestrates the two existing audit
 * scripts (passing the filter through), parses their stdout for the
 * per-sample lines, then prints the combined table. Subprocess so
 * each audit's wasm-tool init runs once cleanly; ~150ms of overhead
 * total, dwarfed by compile time.
 *
 * The companion piece — splice + extract-resource-fork on the result
 * — lives in scripts/splice-bin.mjs. Run that on a specific sample
 * if you need to confirm a particular resource lands in the final
 * .bin (see docs/DEBUGGING-VENDORED-APPS.md for the recipe).
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const APP_DIR = resolve(REPO, "src/app");

const filter = process.argv[2];

const allSamples = readdirSync(APP_DIR)
  .filter((d) => d.startsWith("wasm-") && statSync(join(APP_DIR, d)).isDirectory())
  .filter((d) => !filter || d === filter)
  .sort();

if (allSamples.length === 0) {
  console.error(
    filter
      ? `[audit-e2e] no wasm-* sample matched filter '${filter}'.`
      : `[audit-e2e] no wasm-* samples found under ${APP_DIR}.`,
  );
  process.exit(2);
}

/**
 * Spawn one of the audit scripts and parse its per-sample lines. The
 * audit scripts emit either:
 *   "  ✓  wasm-name              12.3 KB  100ms"      (pass)
 *   "  ✗  wasm-name              [stage] reason"      (fail)
 *   "  ·  wasm-name              no .r file — skipped" (rez-only skip)
 * We collect each into a Map keyed by sample name.
 */
function runAudit(label, scriptName) {
  const args = [join(REPO, "scripts", scriptName)];
  if (filter) args.push(filter);
  const res = spawnSync("node", args, { encoding: "utf8" });
  const lines = (res.stdout || "").split("\n");
  const out = new Map();
  for (const line of lines) {
    // Match status glyph (✓ ✗ ·) + sample name. The name field is
    // padded; we strip trailing spaces.
    const m = line.match(/^\s*([✓✗·])\s+(wasm-\S+)\s+(.*)$/u);
    if (!m) continue;
    const [, glyph, name, rest] = m;
    out.set(name, {
      pass: glyph === "✓",
      skipped: glyph === "·",
      detail: rest.trim(),
    });
  }
  return { label, exit: res.status ?? 1, results: out, stderr: res.stderr };
}

console.log(
  `[audit-e2e] ${allSamples.length} wasm-* sample(s)${filter ? ` (filter: ${filter})` : ""} — running .c + .r audits…`,
);
console.log("");

const cAudit = runAudit(".c", "audit-wasm-samples.mjs");
const rAudit = runAudit(".r", "audit-wasm-rez.mjs");

// Per-sample combined table. Widths chosen so output reads cleanly on
// an 80-col terminal even with the worst-case "wasm-*" name we ship.
const NAMECOL = 22;
let failed = 0;
for (const name of allSamples) {
  const c = cAudit.results.get(name);
  const r = rAudit.results.get(name);
  const cStr = c
    ? c.pass
      ? "✓"
      : "✗"
    : "?";
  const rStr = r
    ? r.skipped
      ? "—"
      : r.pass
        ? "✓"
        : "✗"
    : "?";
  const overall =
    c?.pass && (r?.pass || r?.skipped) ? "✓" : "✗";
  if (overall !== "✓") failed++;
  const cDetail = c?.pass ? c.detail : c?.detail ?? "(no .c result)";
  const rDetail = r?.skipped
    ? "no .r"
    : r?.pass
      ? r.detail
      : r?.detail ?? "(no .r result)";
  console.log(
    `  ${overall}  ${name.padEnd(NAMECOL)} c=${cStr} ${cDetail.padEnd(18)}  r=${rStr} ${rDetail}`,
  );
}

console.log("");
if (failed === 0) {
  console.log(`[audit-e2e] all ${allSamples.length} sample(s) compiled (.c + .r).`);
  process.exit(0);
}
console.log(`[audit-e2e] ${failed} of ${allSamples.length} sample(s) FAILED.`);
console.log(`            re-run a single sample with full details via:`);
console.log(`              node scripts/audit-wasm-samples.mjs <name>`);
console.log(`              node scripts/audit-wasm-rez.mjs <name>`);
process.exit(1);
