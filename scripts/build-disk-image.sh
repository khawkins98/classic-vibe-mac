#!/usr/bin/env bash
# build-disk-image.sh
# Creates an HFS disk image containing the compiled Mac app in Startup Items.
# Usage: ./scripts/build-disk-image.sh <path-to-binary> <output.dsk>
#
# Requires: hfsutils (apt install hfsutils)

set -euo pipefail

BINARY="${1:?Usage: $0 <binary> <output.dsk>}"
OUTPUT="${2:?Usage: $0 <binary> <output.dsk>}"

echo "TODO: implement HFS disk image creation" >&2
echo "  binary: $BINARY" >&2
echo "  output: $OUTPUT" >&2
exit 1
