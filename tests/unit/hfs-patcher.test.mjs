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
let skip = 0;
// test(name, fn) or test(name, opts, fn) where opts may carry { skip: bool }.
function test(name, optsOrFn, maybeFn) {
  const opts = typeof optsOrFn === "object" ? optsOrFn : {};
  const fn = typeof optsOrFn === "function" ? optsOrFn : maybeFn;
  if (opts.skip) {
    console.log(`  skip ${name}`);
    skip++;
    return;
  }
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

/**
 * Build a minimal valid MacBinary II APPL in-memory. Used in place of a
 * vendored .bin fixture — we don't need real CODE resources to exercise
 * parseMacBinary + the HFS patcher; we just need a structurally valid
 * MacBinary the patcher's parser will accept. parseMacBinary checks
 * length, header byte 0, filename length, and the rsrc-end bound — but
 * not the CRC — so a hand-rolled header works.
 *
 * Layout: 128-byte header + dataLen + pad to 128 + rsrcLen + pad to 128.
 */
function makeApplMacBinary({
  filename,
  type = 0x4150504c, // 'APPL'
  creator = 0x3f3f3f3f, // '????'
  rsrcLen = 64,
}) {
  const nameBytes = new TextEncoder().encode(filename);
  if (nameBytes.length > 63) throw new Error(`filename too long: ${filename}`);
  const dataLen = 0;
  const dataPad = 0;
  const rsrcPad = Math.ceil(rsrcLen / 128) * 128 - rsrcLen;
  const total = 128 + dataLen + dataPad + rsrcLen + rsrcPad;
  const bin = new Uint8Array(total);
  const dv = new DataView(bin.buffer);
  bin[1] = nameBytes.length;
  bin.set(nameBytes, 2);
  dv.setUint32(65, type, false);
  dv.setUint32(69, creator, false);
  dv.setUint32(83, dataLen, false);
  dv.setUint32(87, rsrcLen, false);
  // Fill rsrc fork with a recognisable pattern so any future round-trip
  // assertions on bytes can verify integrity. Not strictly needed today.
  const rsrcStart = 128 + dataLen + dataPad;
  for (let i = 0; i < rsrcLen; i++) bin[rsrcStart + i] = 0xa0 | (i & 0x0f);
  return bin;
}

// reader.code.bin is produced by Retro68 in the cross-compile job — not
// available on the bare unit-test runner. When it's missing, skip with
// a clear message; the test still runs in any environment where the
// Retro68 build has populated `src/web/public/precompiled/`.
import { existsSync } from "node:fs";
const codeBinAvailable = existsSync(READER_BIN);
if (!codeBinAvailable) {
  console.log(
    "  skip reader.code.bin not present (run via build.yml or `cmake --build build` locally); skipping precompile-dependent tests",
  );
}

const template = new Uint8Array(readFileSync(TEMPLATE_PATH));
const readerBin = codeBinAvailable
  ? new Uint8Array(readFileSync(READER_BIN))
  : new Uint8Array(0);

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

test("MacBinary parse matches hfsutils' view of reader.code.bin", { skip: !codeBinAvailable }, () => {
  const v = parseMacBinary(readerBin);
  // "????" creator is what reader.code.bin actually has (it's the data-fork
  // stub from Retro68; the user's Build pipeline overwrites the rsrc fork
  // with one that has a real APPL/CVMR resource map).
  assert.equal(v.type, 0x4150504c, "type APPL");
  assert.ok(v.dataLen >= 0);
  assert.ok(v.rsrcLen > 0, "code.bin should have a non-empty rsrc fork");
});

// ── Synthesised-APPL tests ──────────────────────────────────────────────
//
// These tests used to load `precompiled/hello-toolbox.bin` (a real
// Retro68-built MacBinary II APPL vendored from wasm-retro-cc). Since
// that splice-path / prebuilt-demo workflow was retired in #117 / #120,
// keeping a 12 KB .bin solely as a test fixture was redundant — the
// patcher only cares about MacBinary structure, not real CODE
// resources. The fixture is now built in-memory by makeApplMacBinary.

const syntheticAppl = makeApplMacBinary({
  filename: "hello_toolbox",
  rsrcLen: 64,
});

test("synthesised APPL: parseMacBinary returns APPL with non-empty resource fork", () => {
  const v = parseMacBinary(syntheticAppl);
  assert.equal(v.type, 0x4150504c, "type must be APPL");
  assert.ok(v.rsrcLen > 0, "resource fork must be non-empty");
  assert.ok(v.dataLen >= 0);
});

test("synthesised APPL: patchEmptyVolumeWithBinary produces expected-size disk image", () => {
  const patched = patchEmptyVolumeWithBinary({
    templateBytes: template,
    macBinary: syntheticAppl,
    filename: "hello_toolbox",
  });
  assert.equal(patched.length, template.length, "patched disk must be same size as template");
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
} else if (!codeBinAvailable) {
  console.log(
    "  skip reader.code.bin not present; skipping hfsutils round-trip",
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

// ── Synthesised APPL hfsutils round-trip ──────────────────────────────
// Skip only if hfsutils isn't installed; the synthesised binary is
// always available (built in-process).

if (hfsutilsAvailable) {
  test("synthesised APPL: patched disk mounts and shows file with APPL type", () => {
    const patched = patchEmptyVolumeWithBinary({
      templateBytes: template,
      macBinary: syntheticAppl,
      filename: "hello_toolbox",
    });
    const tmpPath = join(mkdtempSync(join(tmpdir(), "cvm-hfs-")), "ht.dsk");
    writeFileSync(tmpPath, Buffer.from(patched));
    const mount = spawnSync("hmount", [tmpPath]);
    assert.equal(mount.status, 0, `hmount failed: ${mount.stderr.toString()}`);
    try {
      const ls = spawnSync("hls", ["-la"]);
      assert.equal(ls.status, 0, `hls failed: ${ls.stderr.toString()}`);
      const out = ls.stdout.toString();
      assert.match(out, /\bhello_toolbox\b/, `hls didn't list 'hello_toolbox': ${out}`);
      assert.match(out, /APPL/, `hls didn't show APPL type: ${out}`);
      console.log(`     hls -la output:\n        ${out.split("\n").join("\n        ")}`);
    } finally {
      spawnSync("humount", [tmpPath]);
    }
  });

  test("extraFiles: README mounted alongside hello_toolbox with TEXT/ttxt", () => {
    // "info.txt" — 'i' (case-folded) > 'h' (case-folded), so the catalog
    // key order constraint is satisfied (records appended in ascending
    // order by parentID=2 + name).
    const readme = new TextEncoder().encode(
      "Hello from the wasm-retro-cc demo.\r" +
        "Open browser DevTools → Console to verify the binary's SHA-256.\r",
    );
    const patched = patchEmptyVolumeWithBinary({
      templateBytes: template,
      macBinary: syntheticAppl,
      filename: "hello_toolbox",
      extraFiles: [
        {
          filename: "info.txt",
          type: 0x54455854, // 'TEXT'
          creator: 0x74747874, // 'ttxt' (SimpleText / TeachText)
          dataFork: readme,
        },
      ],
    });
    const tmpPath = join(mkdtempSync(join(tmpdir(), "cvm-hfs-")), "extra.dsk");
    writeFileSync(tmpPath, Buffer.from(patched));
    const mount = spawnSync("hmount", [tmpPath]);
    assert.equal(mount.status, 0, `hmount failed: ${mount.stderr.toString()}`);
    try {
      const ls = spawnSync("hls", ["-la"]);
      assert.equal(ls.status, 0, `hls failed: ${ls.stderr.toString()}`);
      const out = ls.stdout.toString();
      assert.match(out, /\bhello_toolbox\b/, `hls didn't list 'hello_toolbox': ${out}`);
      assert.match(out, /\binfo\.txt\b/, `hls didn't list 'info.txt': ${out}`);
      assert.match(out, /TEXT\/ttxt/, `hls didn't show TEXT/ttxt type: ${out}`);
      assert.match(out, /APPL/, `hls didn't show APPL: ${out}`);
      console.log(`     hls -la output:\n        ${out.split("\n").join("\n        ")}`);

      // Round-trip the text file content through hcopy and check it
      // matches what we wrote — the data fork integrity check that
      // matters here is "does TeachText see the right bytes?".
      const copyDir = mkdtempSync(join(tmpdir(), "cvm-hfs-copy-"));
      const copyPath = join(copyDir, "info.txt");
      // -r = raw data fork (no MacBinary wrapping, no CR<->LF
      // translation).  Default mode does text-mode CR translation for
      // TEXT/ttxt files, which would munge the bytes we asserted.
      const copy = spawnSync("hcopy", ["-r", ":info.txt", copyPath]);
      assert.equal(
        copy.status,
        0,
        `hcopy data fork failed: ${copy.stderr.toString()}`,
      );
      const got = new Uint8Array(readFileSync(copyPath));
      assert.deepStrictEqual(
        Array.from(got),
        Array.from(readme),
        "info.txt data fork bytes didn't round-trip through HFS",
      );
    } finally {
      spawnSync("humount", [tmpPath]);
    }
  });
}

// ── Summary ─────────────────────────────────────────────────────────────

console.log(`\n  ${pass} passed, ${fail} failed, ${skip} skipped.`);
if (fail > 0) process.exit(1);
