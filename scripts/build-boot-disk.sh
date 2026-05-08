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
#   4. Copy our compiled app MacBinary into Startup Items.
#   5. Optionally re-chunk the result into the manifest format the
#      Infinite Mac BasiliskII WASM consumes (see write-chunked-manifest.py
#      for the algorithm; this is a no-op stub today and runs only when
#      --chunk is passed).
#   6. Output the modified .dsk to the dist path the web build expects.
#
# Usage:
#   ./scripts/build-boot-disk.sh <app.bin>[,<app2.bin>,...] <output.dsk> [--chunk <chunks-dir>]
#
# The first argument is a COMMA-SEPARATED list of MacBinary paths — one per
# app. Each app gets installed into both :System Folder:Startup Items: (so
# it auto-launches on boot) AND :Applications: (so the user can re-launch
# from the desktop after closing).
#
# For backwards compat, a single .bin path with no commas works too.
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
# disk), placing the app's .bin in that folder is sufficient — no
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
  echo "Usage: $0 <app.bin>[,<app2.bin>,...] <output.dsk> [--chunk <chunks-dir>] [--shared-dir <dir>]" >&2
  exit 64
fi

BINARY_ARG="$1"
OUTPUT="$2"
shift 2

# Split comma-separated app list. Each entry must point to a real .bin.
IFS=',' read -ra BINARIES <<< "${BINARY_ARG}"

CHUNKS_DIR=""
SHARED_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --chunk)
      CHUNKS_DIR="${2:?--chunk requires a directory}"
      shift 2
      ;;
    --shared-dir)
      SHARED_DIR="${2:?--shared-dir requires a directory}"
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
BOOT_DISK_SHA256="${BOOT_DISK_SHA256_OVERRIDE:-9126e47cda694f90b8366e920dc19c172e53e470a06e1ac48cc3f1d5d1888bb7}"
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

for b in "${BINARIES[@]}"; do
  if [[ ! -f "${b}" ]]; then
    echo "error: app binary not found: ${b}" >&2
    exit 1
  fi
done

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
# pin a wrong image this is where it'd blow up. hfsutils paths are
# Mac-style — the volume root is "" (or ":"), NOT "/". Passing "/"
# yields "no such file or directory".
if ! hls -a 2>/dev/null | grep -q "System Folder"; then
  echo "error: mounted volume has no 'System Folder' at the root." >&2
  echo "  Listing for diagnosis:" >&2
  hls -a >&2 || true
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

# Make sure :Applications: exists too. The user can re-launch any of our
# apps from the desktop after they've quit the auto-launched copy. (System 7
# launches the app from Startup Items on boot; once it quits, the Finder
# loses track of it unless the user double-clicks again — having a copy in
# :Applications: makes that easy.)
if ! hls -a 2>/dev/null | grep -q "^Applications$"; then
  echo "[boot-disk] creating :Applications:"
  hmkdir ":Applications" || true
fi

# Copy each MacBinary in. Every app goes into :Applications: (so users
# can re-launch from the desktop). For Startup Items (auto-launch), only
# the LAST app in the list is installed — System 7's Finder launches
# Startup Items concurrently, but the last-launched app ends up in
# front, and our chrome only shows the foreground window cleanly. The
# CI workflow orders the comma-separated list so the most-interesting
# demo (MacWeather, with live data) ends up frontmost.
#
# hcopy -m decodes MacBinary back into a real two-fork Mac file (data
# fork + resource fork + Finder Type/Creator), which is what System 7's
# Finder needs to recognise it as launchable.
LAST_INDEX=$(( ${#BINARIES[@]} - 1 ))
for i in "${!BINARIES[@]}"; do
  BINARY="${BINARIES[$i]}"
  APP_NAME_NOEXT="$(basename "${BINARY}" .bin)"
  if [[ $i -eq $LAST_INDEX ]]; then
    echo "[boot-disk] installing ${APP_NAME_NOEXT} (Startup Items + Applications)"
    hcopy -m "${BINARY}" ":System Folder:Startup Items:"
  else
    echo "[boot-disk] installing ${APP_NAME_NOEXT} (Applications only)"
  fi
  hcopy -m "${BINARY}" ":Applications:"

  # Verify the copy landed and looks Mac-shaped (Type/Creator codes).
  # Format of `hls -l` per its man page:
  #   <type-flag>  <TYPE>/<CREATOR>  <rsrc-bytes>  <data-bytes>  <date>  <name>
  # So column 3 is the resource-fork length, column 4 is the data-fork
  # length. An APPL with rsrc==0 is a paperweight: no SIZE resource means
  # the Process Manager has no memory partition info and the launch path
  # bombs on an unimplemented-trap dialog before main() even runs.
  if [[ $i -eq $LAST_INDEX ]]; then
    VERIFY_DIR=":System Folder:Startup Items:"
  else
    VERIFY_DIR=":Applications:"
  fi
  HLS_OUT="$(hls -l "${VERIFY_DIR}")"
  APP_LINE="$(printf '%s\n' "${HLS_OUT}" | awk -v n="${APP_NAME_NOEXT}" '$NF==n')"
  if [[ -z "${APP_LINE}" ]]; then
    echo "FATAL: copied app '${APP_NAME_NOEXT}' not found in ${VERIFY_DIR} listing." >&2
    echo "${HLS_OUT}" >&2
    exit 1
  fi

  # Columns: 1=type-flag, 2=TYPE/CREATOR, 3=rsrc, 4=data, 5..=date, last=name.
  APP_TYPE="$(printf '%s' "${APP_LINE}" | awk '{print $2}')"
  APP_RSRC="$(printf '%s' "${APP_LINE}" | awk '{print $3}')"
  APP_DATA="$(printf '%s' "${APP_LINE}" | awk '{print $4}')"
  echo "[boot-disk]   ${APP_NAME_NOEXT}: type/creator=${APP_TYPE}, rsrc=${APP_RSRC}, data=${APP_DATA}"

  if [[ "${APP_RSRC}" == "0" ]]; then
    echo "FATAL: resource fork is empty after hcopy -m for ${APP_NAME_NOEXT}." >&2
    echo "  This means the SIZE/CODE/etc resources didn't make it onto the boot disk;" >&2
    echo "  the Process Manager will bomb on launch with 'unimplemented trap'." >&2
    echo "  Check the input MacBinary header at bytes 0x57..0x5A (rsrc length, big-endian):" >&2
    if command -v xxd >/dev/null 2>&1; then
      xxd -s 87 -l 4 "${BINARY}" >&2 || true
    fi
    exit 1
  fi
  case "${APP_TYPE}" in
    APPL/*) : ;;  # APPL is what we want; creator may be ???? if app didn't register.
    *) echo "FATAL: ${APP_NAME_NOEXT}: copied file has type ${APP_TYPE}, expected APPL/<creator>." >&2; exit 1 ;;
  esac
done

echo "[boot-disk] :System Folder:Startup Items: final contents:"
hls -l ":System Folder:Startup Items:"
echo "[boot-disk] :Applications: final contents:"
hls -l ":Applications:" || true

# --- Step 2.5: bake the :Shared: folder into the boot volume ------------
#
# Reader (src/app/reader.c) opens HTML by Pascal-string path
# `:Shared:<name>` via HOpen(vRefNum=0, dirID=0, ...). The leading colon
# makes that a relative path; classic Mac OS resolves it against the
# application's working directory (set by Process Manager to the
# directory containing the app — i.e. :System Folder:Startup Items:
# in our case) — so the `Shared` folder must sit alongside Reader.
# We additionally copy the folder to the boot volume root so older
# launch paths (or a future CWD change) still resolve.
#
# Why not BasiliskII's `extfs /Shared/` mount? extfs *does* expose the
# Emscripten /Shared/ tree as a Mac volume, but the volume name is
# hard-coded to "Unix" in upstream macemu's STR_EXTFS_VOLUME_NAME
# (BasiliskII/src/Unix/user_strings_unix.cpp) — the volume mounts as
# `Unix:`, not `Shared:`. Reader's hard-coded `:Shared:` prefix can never
# match. Rather than carry a private fork of macemu just to rename the
# volume, we ship the HTML on the HFS boot disk where Reader already
# expects it. extfs is still wired in the worker for future
# Uploads/Downloads use, but Reader no longer depends on it.
#
# See LEARNINGS.md (2026-05-08, "extfs volume name is 'Unix' not 'Shared'").

# Default the shared dir to repo's src/web/public/shared if the caller
# didn't specify and that location exists. Lets local + CI invocations
# stay short.
if [[ -z "${SHARED_DIR}" ]]; then
  CANDIDATE="${REPO_ROOT}/src/web/public/shared"
  if [[ -d "${CANDIDATE}" ]]; then
    SHARED_DIR="${CANDIDATE}"
  fi
fi

if [[ -n "${SHARED_DIR}" && -d "${SHARED_DIR}" ]]; then
  # MacWeather: bake an initial weather.json into :Shared: so MacWeather has
  # something to display on first boot, before (or in lieu of) the JS poller
  # writing live data into the extfs `Unix:` volume. Sample JSON file that
  # mirrors the open-meteo response shape MacWeather parses — same shape the
  # JS poller writes at runtime.
  WEATHER_FIXTURE="${SHARED_DIR}/weather.json"
  if [[ ! -f "${WEATHER_FIXTURE}" ]]; then
    cat > "${WEATHER_FIXTURE}" <<'WEATHER_JSON'
{"current":{"time":"2026-05-08T12:00","temperature_2m":62,"apparent_temperature":58,"weather_code":2,"wind_speed_10m":7,"wind_direction_10m":290,"relative_humidity_2m":58},"daily":{"time":["2026-05-08","2026-05-09","2026-05-10","2026-05-11"],"temperature_2m_max":[68,71,65,72],"temperature_2m_min":[48,50,46,49],"weather_code":[2,1,61,0]}}
WEATHER_JSON
    echo "[boot-disk] wrote sample fixture ${WEATHER_FIXTURE}"
  fi

  HTML_FILES=("${SHARED_DIR}"/*.html)
  if [[ -e "${HTML_FILES[0]}" ]]; then
    echo "[boot-disk] baking :Shared: folder from ${SHARED_DIR}"

    # Create the folder at the boot volume root and inside Startup Items.
    # `hmkdir` errors if the dir already exists — swallow that one case.
    for parent in ":" ":System Folder:Startup Items:"; do
      if ! hls -a "${parent}" 2>/dev/null | grep -q "^Shared$"; then
        hmkdir "${parent}Shared" || true
      fi
    done

    # hcopy without -m sends the file as a single data fork. HTML files
    # have no resource fork by nature, so this is correct: the Mac sees
    # them with empty .finf metadata and reads them as binary streams,
    # which matches what Reader's FSRead loop wants.
    #
    # After each copy we hattrib the file with type=TEXT and creator=CVMR.
    # Without this the Finder treats the file as ????/???? and bombs out
    # with "Could not find the application program that created the
    # document …" on double-click, even though Reader is right there in
    # Startup Items. CVMR is Reader's signature (see src/app/reader.r);
    # TEXT is a generic Mac type that SimpleText/TeachText also recognise,
    # so the file isn't a Reader-only paperweight if Reader is missing.
    # The Finder's BNDL scan binds TEXT/CVMR -> Reader on first launch.
    for f in "${HTML_FILES[@]}"; do
      base="$(basename "${f}")"
      echo "[boot-disk]   :Shared:${base}  (and :System Folder:Startup Items:Shared:${base})"
      hcopy "${f}" ":Shared:${base}"
      hcopy "${f}" ":System Folder:Startup Items:Shared:${base}"
      # hattrib -t TYPE -c CREATOR sets the Finder Info bytes. Errors here
      # are non-fatal — the file is still readable, just unbound — but log
      # them loudly so a CI regression surfaces.
      hattrib -t TEXT -c CVMR ":Shared:${base}" \
        || echo "[boot-disk] WARN: hattrib failed on :Shared:${base}"
      hattrib -t TEXT -c CVMR ":System Folder:Startup Items:Shared:${base}" \
        || echo "[boot-disk] WARN: hattrib failed on :System Folder:Startup Items:Shared:${base}"
    done

    # weather.json: similar copy + tag with TEXT/CVMW so MacWeather owns
    # the file type. The fallback path inside MacWeather opens
    # :Shared:weather.json, so we copy it both at the volume root (where
    # MacWeather's HOpen with vRefNum=0 + path :Shared:... resolves
    # against the Process Manager-set working directory) and into the
    # Startup Items Shared subfolder (the actual :Shared: that resolves
    # when launched from there). Same pattern as the HTML files for
    # Reader.
    if [[ -f "${WEATHER_FIXTURE}" ]]; then
      echo "[boot-disk]   :Shared:weather.json"
      hcopy "${WEATHER_FIXTURE}" ":Shared:weather.json"
      hcopy "${WEATHER_FIXTURE}" ":System Folder:Startup Items:Shared:weather.json"
      hattrib -t TEXT -c CVMW ":Shared:weather.json" \
        || echo "[boot-disk] WARN: hattrib failed on :Shared:weather.json"
      hattrib -t TEXT -c CVMW ":System Folder:Startup Items:Shared:weather.json" \
        || echo "[boot-disk] WARN: hattrib failed on :System Folder:Startup Items:Shared:weather.json"
    fi

    echo "[boot-disk] :Shared: contents:"
    hls -l ":Shared:" || true
  else
    echo "[boot-disk] note: no *.html under ${SHARED_DIR}; skipping :Shared: bake"
  fi
else
  echo "[boot-disk] note: --shared-dir not set and no default; skipping :Shared: bake"
fi

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
