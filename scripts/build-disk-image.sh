#!/usr/bin/env bash
# build-disk-image.sh
#
# Creates an HFS-formatted .dsk image containing the compiled classic Mac app,
# placed inside a top-level "Startup Items" folder on the volume. The resulting
# disk is intended to be mounted as a *secondary* drive in Basilisk II alongside
# a System 7.5.5 boot disk supplied by Infinite Mac's CDN.
#
# Usage:
#   ./scripts/build-disk-image.sh <path-to-mac-binary> <output.dsk>
#
# Input:
#   <path-to-mac-binary>   A MacBinary (.bin) file produced by Retro68. MacBinary
#                          is required so the resource fork survives the trip
#                          through a non-Mac filesystem; hcopy -m decodes it back
#                          into a real two-fork HFS file on the volume.
#
# Output:
#   <output.dsk>           A 1.4 MB HFS disk image containing:
#                            <Volume>:Startup Items:<AppName>
#
# Requires: hfsutils (apt install hfsutils on Ubuntu/Debian).
# Note: the Ubuntu package "hfsprogs" is for HFS+ and is NOT what we want.
#
# IMPORTANT — Startup Items caveat:
#   In classic Mac OS, the Finder only auto-launches items in the *active blessed*
#   System Folder's "Startup Items" on the boot volume. A "Startup Items" folder
#   on a secondary mounted disk is just a regular folder and will NOT auto-launch.
#   We still place the app in a "Startup Items" folder here so that, in a future
#   iteration, this disk can be made bootable (or its contents merged into the
#   boot disk's System Folder before launch). Until then, the web layer must
#   either (a) script the launch via Basilisk II, or (b) inject the app into the
#   boot disk's System Folder. See LEARNINGS.md for the full explanation.

set -euo pipefail

BINARY="${1:?Usage: $0 <binary> <output.dsk>}"
OUTPUT="${2:?Usage: $0 <binary> <output.dsk>}"

VOLUME_NAME="MyApp"
DISK_SIZE_BYTES=$((1440 * 1024))  # 1.4 MB — classic floppy size, plenty for one app

# --- Preflight ---------------------------------------------------------------

for tool in hformat hmount humount hcopy hmkdir; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' not found. Install hfsutils:" >&2
    echo "  Debian/Ubuntu:  sudo apt-get install -y hfsutils" >&2
    echo "  (Do NOT install 'hfsprogs' — that is for HFS+, a different filesystem.)" >&2
    exit 1
  fi
done

if [[ ! -f "$BINARY" ]]; then
  echo "error: binary not found: $BINARY" >&2
  exit 1
fi

# --- Build -------------------------------------------------------------------

# Fresh image — overwrite if it exists.
rm -f "$OUTPUT"

# Allocate an empty file of the target size, then format it as HFS in place.
# hformat treats the file as a raw block device.
dd if=/dev/zero of="$OUTPUT" bs=1024 count=$((DISK_SIZE_BYTES / 1024)) status=none

# -l sets the volume label. "-f" picks partition 0 (the whole image, no map).
hformat -l "$VOLUME_NAME" "$OUTPUT" >/dev/null

# hmount stores the "currently mounted" volume in ~/.hcwd. humount on exit.
hmount "$OUTPUT" >/dev/null
trap 'humount "$OUTPUT" >/dev/null 2>&1 || true' EXIT

# Create the Startup Items folder at the volume root.
hmkdir ":Startup Items"

# Copy the MacBinary file into Startup Items. -m decodes MacBinary so both forks
# land on the HFS volume as a single proper Mac file (not a .bin blob).
hcopy -m "$BINARY" ":Startup Items:"

echo "Built $OUTPUT (volume: $VOLUME_NAME, ${DISK_SIZE_BYTES} bytes)"
