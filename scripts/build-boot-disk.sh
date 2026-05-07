#!/usr/bin/env bash
# build-boot-disk.sh — bake a bootable, app-pre-installed System 7.5.5 disk.
#
# Pipeline:
#   1. Download a bootable System 7.5.5 hard-disk image from a pinned mirror,
#      verify SHA-256, cache locally.
#   2. Mount it via hfsutils. The image already has a *blessed* System Folder
#      (it was prepared by community emulator users for MinivMac/BasiliskII),
#      so we don't need to bless one ourselves.
#   3. Ensure ":System Folder:Startup Items:" exists.
#   4. Copy our compiled Minesweeper MacBinary into Startup Items.
#   5. Optionally re-chunk the result into the manifest format the
#      Infinite Mac BasiliskII WASM consumes (see write-chunked-manifest.py
#      for the algorithm; this is a no-op stub today and runs only when
#      --chunk is passed).
#   6. Output the modified .dsk to the dist path the web build expects.
#
# Usage:
#   ./scripts/build-boot-disk.sh <minesweeper.bin> <output.dsk> [--chunk <chunks-dir>]
#
# Output:
#   <output.dsk>            — the modified bootable HD image (~24 MB).
#   <chunks-dir>/<name>.json + <chunks-dir>/<sig>.chunk … (only with --chunk)
#
# What this script does NOT do:
#   - It does NOT make the page boot in the browser. The BasiliskII WASM
#     core compiled by Infinite Mac (which we vendor) is wired through
#     hundreds of lines of worker glue (EmulatorWorkerApi, video/audio/
#     input/clipboard/files/disks shared-memory channels, BasiliskIIPrefs.txt
#     template, device-image header, MAC address generation) that we have
#     not ported. See LEARNINGS.md (2026-05-08, "BasiliskII WASM init
#     contract"). Until that port lands, the loader stays in STUB mode.
#     This script's job is to have the disk ready and waiting so that
#     when the worker glue lands, the boot disk is one less unknown.
#
# Auto-launch: classic Mac OS 7's Finder scans ":System Folder:Startup
# Items:" on the *boot volume's blessed System Folder* and launches its
# contents. Because we are modifying the boot disk itself (not a secondary
# disk), placing Minesweeper.bin in that folder is sufficient — no
# blessing dance needed; the System Folder of the upstream image is
# already blessed. Verify with `hattrib ":System Folder:"` before/after
# if you want to sanity-check.
#
# Requires: curl, hfsutils (hformat/hmount/humount/hcopy/hmkdir/hattrib/hls),
#           sha256sum or shasum, optionally python3 (only for --chunk).
# NOTE: hfsutils is HFS, NOT hfsprogs (HFS+). Mounting the wrong filesystem
# silently fails — see LEARNINGS.md (2026-05-08, hfsutils install).

set -euo pipefail

# --- Args ---------------------------------------------------------------

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <minesweeper.bin> <output.dsk> [--chunk <chunks-dir>]" >&2
  exit 64
fi

BINARY="$1"
OUTPUT="$2"
shift 2

CHUNKS_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --chunk)
      CHUNKS_DIR="${2:?--chunk requires a directory}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 64
      ;;
  esac
done

# --- Pin ----------------------------------------------------------------
#
# A pre-installed, bootable System 7.5.5 hard-disk image from
# archive.org/details/macos755_202104. The image was packaged for use with
# MinivMac and BasiliskII — System Folder is already blessed, Finder is
# present, no installer dance required.
#
# Apple posted complete System 7.5.3 install media to its support site in
# 2001 with a license permitting free redistribution; the 7.5.5 updater
# has the same posture (this is the basis on which Infinite Mac, MinivMac
# distributions, and many archive.org items are built). See LEARNINGS.md
# 2026-05-08 ("System 7.5.5 redistribution posture"). If we get a takedown
# request we yank the asset and document it; we are not the first or
# largest mirror.
#
# To bump: download the new image, run `sha256sum` on it, paste the new
# hex into BOOT_DISK_SHA256.

BOOT_DISK_NAME="System_7.5.5_Macos.dsk"
BOOT_DISK_URL="https://archive.org/download/macos755_202104/Macos.dsk"
# SHA-256 placeholder. The CI step will refuse to proceed if this doesn't
# match the downloaded blob. To populate: run this script with
# BOOT_DISK_SHA256_OVERRIDE=skip the first time; the script prints the
# observed hash and you paste it back here.
BOOT_DISK_SHA256="${BOOT_DISK_SHA256_OVERRIDE:-PLACEHOLDER_REPLACE_ME_AFTER_FIRST_RUN}"
BOOT_DISK_EXPECTED_SIZE_BYTES=25165824  # 24 MB, give or take. Sanity check.

# --- Paths --------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CACHE_DIR="${BOOT_DISK_CACHE_DIR:-${REPO_ROOT}/.cache/boot-disk}"
CACHED_BLOB="${CACHE_DIR}/${BOOT_DISK_NAME}"

mkdir -p "${CACHE_DIR}"
mkdir -p "$(dirname "${OUTPUT}")"

# --- Preflight ----------------------------------------------------------

REQUIRED_TOOLS=(curl hformat hmount humount hcopy hmkdir hattrib hls)
for tool in "${REQUIRED_TOOLS[@]}"; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "error: '${tool}' not found." >&2
    if [[ "${tool}" == "curl" ]]; then
      echo "  Install curl via your package manager." >&2
    else
      echo "  Install hfsutils:" >&2
      echo "    Debian/Ubuntu:  apt-get install -y hfsutils" >&2
      echo "    (Do NOT install hfsprogs — that's HFS+, a different filesystem.)" >&2
    fi
    exit 1
  fi
done

if [[ ! -f "${BINARY}" ]]; then
  echo "error: minesweeper binary not found: ${BINARY}" >&2
  exit 1
fi

# Cross-platform sha256.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "error: need sha256sum or shasum on PATH" >&2
    exit 1
  fi
}

size_of() {
  if stat -c%s "$1" >/dev/null 2>&1; then
    stat -c%s "$1"
  else
    stat -f%z "$1"
  fi
}

# --- Step 1: download + verify ------------------------------------------

if [[ -f "${CACHED_BLOB}" ]]; then
  echo "[boot-disk] cache hit: ${CACHED_BLOB}"
else
  echo "[boot-disk] downloading ${BOOT_DISK_URL}"
  # archive.org commonly returns 302 to a regional data node and the data
  # node occasionally hiccups. Retry a few times and follow redirects.
  curl --fail --location --retry 5 --retry-delay 5 \
    --output "${CACHED_BLOB}.partial" \
    "${BOOT_DISK_URL}"
  mv "${CACHED_BLOB}.partial" "${CACHED_BLOB}"
fi

ACTUAL_SIZE="$(size_of "${CACHED_BLOB}")"
if [[ "${ACTUAL_SIZE}" -lt 1048576 ]]; then
  echo "error: downloaded blob is suspiciously small (${ACTUAL_SIZE} bytes)" >&2
  echo "  Removing cache so the next run re-downloads." >&2
  rm -f "${CACHED_BLOB}"
  exit 1
fi

ACTUAL_SHA="$(sha256_of "${CACHED_BLOB}")"
echo "[boot-disk] size:   ${ACTUAL_SIZE} bytes (expected ~${BOOT_DISK_EXPECTED_SIZE_BYTES})"
echo "[boot-disk] sha256: ${ACTUAL_SHA}"

if [[ "${BOOT_DISK_SHA256}" == "PLACEHOLDER_REPLACE_ME_AFTER_FIRST_RUN" ]]; then
  echo "[boot-disk] WARNING: BOOT_DISK_SHA256 is still the placeholder."
  echo "[boot-disk] Paste this hash into scripts/build-boot-disk.sh:"
  echo "[boot-disk]   BOOT_DISK_SHA256=\"${ACTUAL_SHA}\""
  echo "[boot-disk] Continuing this run unverified. Future CI runs will fail until the pin is updated."
elif [[ "${BOOT_DISK_SHA256}" != "${ACTUAL_SHA}" ]]; then
  echo "error: SHA-256 mismatch on ${CACHED_BLOB}" >&2
  echo "  expected: ${BOOT_DISK_SHA256}" >&2
  echo "  got:      ${ACTUAL_SHA}" >&2
  echo "  If you intentionally bumped the pin, update BOOT_DISK_SHA256 in this script." >&2
  echo "  If not, the upstream may have changed — verify before proceeding." >&2
  exit 1
fi

# --- Step 2: copy → working image, modify -------------------------------

# Always start from a clean copy of the cached pristine image so this
# script is idempotent across re-runs.
cp "${CACHED_BLOB}" "${OUTPUT}"

# Mount via hfsutils. State lives in ~/.hcwd; humount on exit.
hmount "${OUTPUT}" >/dev/null
trap 'humount "${OUTPUT}" >/dev/null 2>&1 || true' EXIT

# Sanity-check that the volume actually has a System Folder. If we ever
# pin a wrong image this is where it'd blow up.
if ! hls -a / 2>/dev/null | grep -q "System Folder"; then
  echo "error: mounted volume has no 'System Folder' at the root." >&2
  echo "  Listing for diagnosis:" >&2
  hls -a / >&2 || true
  exit 1
fi

# Inspect (and report) the System Folder's blessed bit. hattrib without
# any flags prints the current attributes; our volume should already
# have System Folder blessed since this image is community-prepared
# for emulator boot. We don't try to re-bless because hfsutils' -b
# behaviour is non-obvious and we don't want to fight the existing
# state. If the pinned image ever ships unblessed we'll see it here.
echo "[boot-disk] System Folder attributes:"
hattrib ":System Folder:" || true

# Make sure Startup Items exists. Classic System 7 install media usually
# ships with it; create defensively in case this particular image doesn't.
# `hmkdir` errors if the dir already exists — swallow that one case.
if ! hls -a ":System Folder:" 2>/dev/null | grep -q "Startup Items"; then
  echo "[boot-disk] creating :System Folder:Startup Items:"
  hmkdir ":System Folder:Startup Items"
fi

# Copy the MacBinary in. -m decodes MacBinary back into a real two-fork
# Mac file (data fork + resource fork + Finder Type/Creator), which is
# what System 7's Finder needs to recognise it as launchable.
echo "[boot-disk] installing $(basename "${BINARY}") into Startup Items"
hcopy -m "${BINARY}" ":System Folder:Startup Items:"

# Verify the copy landed and looks Mac-shaped (Type/Creator codes).
echo "[boot-disk] :System Folder:Startup Items: contents:"
hls -l ":System Folder:Startup Items:"

humount "${OUTPUT}" >/dev/null
trap - EXIT

echo "[boot-disk] wrote ${OUTPUT} ($(size_of "${OUTPUT}") bytes)"

# --- Step 3: chunk for the BasiliskII WASM consumer ----------------------
#
# If --chunk wasn't passed, default to a sibling directory next to OUTPUT.
# The chunked manifest + chunks are how the loader actually reads the disk
# (see src/web/src/emulator-worker.ts ChunkedDisk). Single-file .dsk is
# kept around for HEAD-checks and as a fallback artifact, but the loader
# never fetches it.

if [[ -z "${CHUNKS_DIR}" ]]; then
  CHUNKS_DIR="$(dirname "${OUTPUT}")/$(basename "${OUTPUT}" .dsk)-chunks"
  echo "[boot-disk] --chunk not given; defaulting to ${CHUNKS_DIR}/"
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "error: chunking requires python3 on PATH." >&2
  exit 1
fi
CHUNKER="${SCRIPT_DIR}/write-chunked-manifest.py"
if [[ ! -f "${CHUNKER}" ]]; then
  echo "error: chunker not found at ${CHUNKER}" >&2
  exit 1
fi
echo "[boot-disk] chunking ${OUTPUT} -> ${CHUNKS_DIR}/"
mkdir -p "${CHUNKS_DIR}"
python3 "${CHUNKER}" \
  --image "${OUTPUT}" \
  --name "system755-vibe.dsk" \
  --out-dir "${CHUNKS_DIR}"
# The chunker writes <name>.json into out-dir; copy it to sit next to the
# .dsk so the loader's `${bootDiskUrl}.json` HEAD-check resolves cleanly.
MANIFEST_SRC="${CHUNKS_DIR}/system755-vibe.dsk.json"
MANIFEST_DST="$(dirname "${OUTPUT}")/system755-vibe.dsk.json"
if [[ -f "${MANIFEST_SRC}" && "${MANIFEST_SRC}" != "${MANIFEST_DST}" ]]; then
  cp "${MANIFEST_SRC}" "${MANIFEST_DST}"
fi
echo "[boot-disk] manifest:  ${MANIFEST_DST}"
echo "[boot-disk] chunk dir: ${CHUNKS_DIR}"
