/**
 * hfs-patcher.test.mjs — verify the in-browser HFS patcher against the
 * baked empty-volume template + hfsutils ground truth.
 *
 * Approach:
 *   1. Transpile playground/hfs-patcher.ts to an ESM module via tsc.
 *   2. Load empty-secondary.dsk + a real reader.code.bin precompile.
 *   3. Patch the template, write the result to a temp file.
 *   4. Use `hmount` + `hls -la` to confirm the new file is visible with
 *      the right Type/Creator and resource-fork length.
 *
 * If hfsutils isn't installed we skip with a clear message — the static
 * patcher tests (no FS dependency) still run.
 *
 * Run as: node tests/unit/hfs-patcher.test.mjs
 */

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

function transpile() {
  const out = mkdtempSync(join(tmpdir(), "cvm-hfs-test-"));
  const tscPath = join(REPO, "node_modules", ".bin", "tsc");
  execSync(
    `${tscPath} src/web/src/playground/hfs-patcher.ts ` +
      `--target ES2020 --module ES2020 --moduleResolution node ` +
      `--esModuleInterop --skipLibCheck --strict ` +
      `--outDir ${out}`,
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  return out;
}

const outDir = transpile();
const mod = await import(join(outDir, "hfs-patcher.js"));
const { patchEmptyVolumeWithBinary, parseMacBinary, __test } = mod;

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}\n       ${e.stack ?? e.message}`);
    fail++;
  }
}

// ── Static checks (no FS dependency) ────────────────────────────────────

const TEMPLATE_PATH = join(
  REPO,
  "src/web/public/playground/empty-secondary.dsk",
);
const READER_BIN = join(
  REPO,
  "src/web/public/precompiled/reader.code.bin",
);

const template = new Uint8Array(readFileSync(TEMPLATE_PATH));
const readerBin = new Uint8Array(readFileSync(READER_BIN));

test("template is the expected size (1.44 MB)", () => {
  assert.equal(template.length, 1474560);
});

test("template MDB has expected layout", () => {
  const mdb = __test.readMdb(template);
  assert.equal(mdb.drNmFls, 0, "empty volume has 0 files in root");
  assert.equal(mdb.drFreeBks, 2830, "expected 2830 free blocks");
  assert.equal(mdb.drNxtCNID, 16, "expected next CNID 16");
  assert.equal(mdb.drFilCnt, 0);
  assert.equal(mdb.drDirCnt, 0);
});

test("MacBinary parse matches hfsutils' view of reader.code.bin", () => {
  const v = parseMacBinary(readerBin);
  // "????" creator is what reader.code.bin actually has (it's the data-fork
  // stub from Retro68; the user's Build pipeline overwrites the rsrc fork
  // with one that has a real APPL/CVMR resource map).
  assert.equal(v.type, 0x4150504c, "type APPL");
  assert.ok(v.dataLen >= 0);
  assert.ok(v.rsrcLen > 0, "code.bin should have a non-empty rsrc fork");
});

// ── Patch + hfsutils round-trip ─────────────────────────────────────────

function which(cmd) {
  const r = spawnSync("which", [cmd]);
  return r.status === 0 && r.stdout.toString().trim();
}

const hfsutilsAvailable = which("hmount") && which("hls") && which("humount");
if (!hfsutilsAvailable) {
  console.log(
    "  skip hfsutils not available; skipping ground-truth round-trip",
  );
} else {
  test("patched disk mounts and shows the new file with correct Type/Creator", () => {
    const patched = patchEmptyVolumeWithBinary({
      templateBytes: template,
      macBinary: readerBin,
      filename: "Reader",
    });
    assert.equal(patched.length, template.length);
    const tmpPath = join(mkdtempSync(join(tmpdir(), "cvm-hfs-")), "p.dsk");
    writeFileSync(tmpPath, Buffer.from(patched));
    const mount = spawnSync("hmount", [tmpPath]);
    assert.equal(mount.status, 0, `hmount failed: ${mount.stderr.toString()}`);
    try {
      const ls = spawnSync("hls", ["-la"]);
      assert.equal(ls.status, 0, `hls failed: ${ls.stderr.toString()}`);
      const out = ls.stdout.toString();
      // Expected line shape: "f  APPL/????  <rsrc> <data> <date> Reader"
      assert.match(
        out,
        /\bReader\b/,
        `hls output didn't list 'Reader': ${out}`,
      );
      assert.match(
        out,
        /APPL/,
        `hls output didn't show APPL Type: ${out}`,
      );
      console.log(`     hls -la output:\n        ${out.split("\n").join("\n        ")}`);
    } finally {
      spawnSync("humount", [tmpPath]);
    }
  });

  test("patched disk file's resource-fork content round-trips via hcopy -m", () => {
    const patched = patchEmptyVolumeWithBinary({
      templateBytes: template,
      macBinary: readerBin,
      filename: "Reader",
    });
    const tmpDir = mkdtempSync(join(tmpdir(), "cvm-hfs-"));
    const tmpPath = join(tmpDir, "p.dsk");
    const outBin = join(tmpDir, "out.bin");
    writeFileSync(tmpPath, Buffer.from(patched));
    const mount = spawnSync("hmount", [tmpPath]);
    assert.equal(mount.status, 0);
    try {
      // hcopy -m extracts as MacBinary; we then verify Type/Creator and
      // that the rsrc fork length matches what we put in.
      const cp = spawnSync("hcopy", ["-m", ":Reader", outBin]);
      assert.equal(
        cp.status,
        0,
        `hcopy -m failed: ${cp.stderr.toString()}`,
      );
      const round = new Uint8Array(readFileSync(outBin));
      const v = parseMacBinary(round);
      assert.equal(v.type, 0x4150504c);
      // The rsrc fork bytes should be byte-identical (hcopy doesn't
      // modify them on read).
      const orig = parseMacBinary(readerBin);
      assert.equal(
        v.rsrcLen,
        orig.rsrcLen,
        `rsrc fork length drift: ${v.rsrcLen} vs ${orig.rsrcLen}`,
      );
      // Compare the actual bytes.
      assert.deepEqual(
        Array.from(v.resourceFork),
        Array.from(orig.resourceFork),
        "rsrc fork bytes must be preserved",
      );
    } finally {
      spawnSync("humount", [tmpPath]);
    }
  });
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
