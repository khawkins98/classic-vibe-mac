#!/usr/bin/env bash
# bake-empty-secondary.sh
#
# Rebuilds src/web/public/playground/empty-secondary.dsk — the empty HFS
# volume template the in-browser playground patches with a freshly-
# compiled MacBinary on Build & Run (Phase 3 hot-load, Issue #21/#27).
#
# We commit the output (1.4 MB, gitignored exception) rather than baking
# in CI to keep the deploy a single static-asset push. Re-run this only
# if the template needs changes — different volume name, different size,
# different format options.
#
# Layout the in-browser patcher (src/web/src/playground/hfs-patcher.ts)
# expects:
#   - 1.44 MB image, 512-byte allocation blocks
#   - HFS volume named "Apps"
#   - Empty volume — no files, no folders
#   - Volume bitmap at byte 1536 (drVBMSt=3 → 3*512)
#   - Catalog B-tree starting at allocation block 22 (byte 0x3400)
#   - Single leaf node 1 with two records (root-dir thread + dir)
# The patcher asserts these layout invariants in its tests, so a
# reformat that changes them will fail loudly before producing
# a corrupt disk.
#
# Requires: hfsutils (apt install hfsutils on Ubuntu/Debian, brew
# install hfsutils on macOS). DO NOT use hfsprogs — that is HFS+ and
# is a different filesystem (LEARNINGS.md "HFS vs HFS+").

set -euo pipefail

OUT="${1:-src/web/public/playground/empty-secondary.dsk}"
SIZE_KB=1440  # 1.44 MB classic floppy size; comfortably bigger than any one app
VOLNAME="Apps"

for tool in hformat; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' not found. Install hfsutils." >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
dd if=/dev/zero of="$OUT" bs=1024 count=$SIZE_KB status=none
hformat -l "$VOLNAME" "$OUT" >/dev/null

echo "Baked $OUT (volume: $VOLNAME, $((SIZE_KB * 1024)) bytes)"
