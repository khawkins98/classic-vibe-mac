#!/usr/bin/env bash
# fetch-emulator.sh — pull BasiliskII WASM artifacts from Infinite Mac.
#
# Why this exists:
#   Infinite Mac (https://github.com/mihaip/infinite-mac) ships its compiled
#   emulator cores committed in-tree at src/emulator/worker/emscripten/, NOT
#   via GitHub Releases or a documented CDN. We pin a specific commit SHA
#   below and download just the BasiliskII pieces we need into
#   src/web/public/emulator/ so Vite serves them as static assets at
#   /emulator/* in the built site.
#
#   The script is idempotent: re-running it will re-verify hashes and skip
#   downloads when files are already in place. CI calls it before
#   `vite build`; developers run it once locally after cloning.
#
# How to bump the pin:
#   1. Visit https://github.com/mihaip/infinite-mac/commits/main
#   2. Pick a recent stable-looking commit. (Anything that doesn't change the
#      BasiliskII Emscripten build flags is low risk for us — we only consume
#      the .wasm/.js, not the surrounding worker glue.)
#   3. Update INFINITE_MAC_SHA below.
#   4. Run this script. It will print a "hash mismatch" error for each file
#      that changed; copy the new SHA-256 values into the FILES array.
#
# Licensing:
#   Infinite Mac itself is Apache-2.0. The underlying BasiliskII / macemu
#   sources are GPL-2.0 (mihaip/macemu, BasiliskII/COPYING). Redistributing
#   the compiled .wasm therefore inherits GPL-2.0 obligations: we must offer
#   the corresponding source on request. We vendor LICENSE files for both
#   layers next to the binaries; LEARNINGS.md tracks the open question of
#   how to satisfy the "offer source" obligation for a forked template.

set -euo pipefail

# --- Pin --------------------------------------------------------------------

# Pinned to mihaip/infinite-mac main @ 2026-04-27 ("Update to current Snow
# upstream"). Bump as described in the header comment.
INFINITE_MAC_SHA="30112da0db5d04ff5764d77ae757e73111a6ef12"

# --- Paths ------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${REPO_ROOT}/src/web/public/emulator"

mkdir -p "${DEST_DIR}"

# --- Files to fetch ---------------------------------------------------------
#
# Format per line: <upstream-path>|<expected-size>|<expected-sha256>
#
# Sizes and SHAs as observed from the GitHub blob API at the pinned commit:
#   gh api repos/mihaip/infinite-mac/contents/src/emulator/worker/emscripten?ref=$SHA
# (size matches; sha256 is computed once via this script's first run and then
# locked in here. To re-baseline after a pin bump, set EXPECT_SHA=skip and
# read the printed actual hashes back in.)

FILES=(
  "src/emulator/worker/emscripten/BasiliskII.js|156114|4fd750e202686a7b7c3bd0055dbe33d21dd6b3ce2639da8da814ef1036d1c66b"
  "src/emulator/worker/emscripten/BasiliskII.wasm|1713564|0be9b5ba1179b65d9d1bd30b3cc35ee56daf6713ba1353048c03229f641680bb"
)

# Apache-2.0 license file from the upstream Infinite Mac repo (covers the
# build harness / glue around the emulator).
LICENSE_FILES=(
  "LICENSE|11324|LICENSE-infinite-mac"
)

UPSTREAM_RAW_BASE="https://raw.githubusercontent.com/mihaip/infinite-mac/${INFINITE_MAC_SHA}"

# --- Helpers ----------------------------------------------------------------

sha256_of() {
  # Cross-platform sha256: prefer shasum (BSD/macOS), fall back to sha256sum.
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "ERROR: need either shasum or sha256sum on PATH" >&2
    exit 1
  fi
}

size_of() {
  # Cross-platform stat -c %s
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

fetch_one() {
  local upstream_path="$1"
  local expected_size="$2"
  local expected_sha="$3"
  local dest_name
  dest_name="$(basename "${upstream_path}")"
  local dest_path="${DEST_DIR}/${dest_name}"

  # Idempotency: if file exists with matching size+hash, skip.
  if [[ -f "${dest_path}" ]]; then
    local cur_size cur_sha
    cur_size="$(size_of "${dest_path}")"
    cur_sha="$(sha256_of "${dest_path}")"
    if [[ "${cur_size}" == "${expected_size}" && "${cur_sha}" == "${expected_sha}" ]]; then
      echo "  [ok]   ${dest_name} (cached, ${cur_size} bytes)"
      return 0
    fi
    if [[ "${EXPECT_SHA:-}" == "skip" && "${cur_size}" == "${expected_size}" ]]; then
      echo "  [skip] ${dest_name} (size match, hash check skipped)"
      echo "         actual sha256: ${cur_sha}"
      return 0
    fi
  fi

  echo "  [get]  ${dest_name}  <-  ${upstream_path}"
  curl --fail --show-error --silent --location \
    -o "${dest_path}" \
    "${UPSTREAM_RAW_BASE}/${upstream_path}"

  local cur_size cur_sha
  cur_size="$(size_of "${dest_path}")"
  cur_sha="$(sha256_of "${dest_path}")"

  if [[ "${cur_size}" != "${expected_size}" ]]; then
    echo "ERROR: size mismatch for ${dest_name}: expected ${expected_size}, got ${cur_size}" >&2
    exit 1
  fi

  if [[ "${EXPECT_SHA:-}" == "skip" ]]; then
    echo "         actual sha256: ${cur_sha}  (set this in FILES[] to lock in)"
    return 0
  fi

  if [[ "${cur_sha}" != "${expected_sha}" ]]; then
    echo "ERROR: sha256 mismatch for ${dest_name}" >&2
    echo "  expected: ${expected_sha}" >&2
    echo "  got:      ${cur_sha}" >&2
    echo "  If you just bumped INFINITE_MAC_SHA, re-run with EXPECT_SHA=skip" >&2
    echo "  to print the new hashes, then paste them into FILES[] in this script." >&2
    exit 1
  fi
}

fetch_license() {
  local upstream_path="$1"
  local expected_size="$2"
  local dest_name="$3"
  local dest_path="${DEST_DIR}/${dest_name}"

  if [[ -f "${dest_path}" ]]; then
    local cur_size
    cur_size="$(size_of "${dest_path}")"
    if [[ "${cur_size}" == "${expected_size}" ]]; then
      echo "  [ok]   ${dest_name} (cached)"
      return 0
    fi
  fi

  echo "  [get]  ${dest_name}  <-  ${upstream_path}"
  curl --fail --show-error --silent --location \
    -o "${dest_path}" \
    "${UPSTREAM_RAW_BASE}/${upstream_path}"
}

# --- Run --------------------------------------------------------------------

echo "Fetching BasiliskII WASM artifacts from mihaip/infinite-mac@${INFINITE_MAC_SHA:0:7}"
echo "  destination: ${DEST_DIR}"
echo ""

echo "[1/3] Emulator binaries"
for entry in "${FILES[@]}"; do
  IFS='|' read -r path size sha <<<"${entry}"
  fetch_one "${path}" "${size}" "${sha}"
done
echo ""

echo "[2/3] Upstream license files"
for entry in "${LICENSE_FILES[@]}"; do
  IFS='|' read -r path size dest <<<"${entry}"
  fetch_license "${path}" "${size}" "${dest}"
done
echo ""

# Write a NOTICE file explaining what's vendored. Apache-2.0 §4(d) requires
# preserving any NOTICE the upstream provides; mihaip/infinite-mac doesn't
# ship one at the repo root, so we author a minimal NOTICE here that
# attributes the upstream and acknowledges the GPL-2.0 BasiliskII core that
# the .wasm was compiled from.
NOTICE_PATH="${DEST_DIR}/NOTICE"
cat >"${NOTICE_PATH}" <<EOF
classic-vibe-mac vendored emulator artifacts
============================================

The files BasiliskII.js and BasiliskII.wasm in this directory were
downloaded verbatim from:

  https://github.com/mihaip/infinite-mac
  commit ${INFINITE_MAC_SHA}
  path:  src/emulator/worker/emscripten/

The Infinite Mac project is licensed under Apache-2.0 (see
LICENSE-infinite-mac). The compiled BasiliskII core itself is derived from
mihaip/macemu (https://github.com/mihaip/macemu), which is GPL-2.0:

  https://github.com/mihaip/macemu/blob/master/BasiliskII/COPYING

Because the .wasm is a derivative work of the GPL-2.0 BasiliskII source,
redistribution of these binaries inherits GPL-2.0 obligations including
the requirement to offer corresponding source on request. The source is
the upstream macemu submodule referenced from Infinite Mac at the pinned
commit above.

These files are not modified relative to their upstream form. They are
re-fetched at build time by scripts/fetch-emulator.sh; they are not
committed to the classic-vibe-mac git history.
EOF

echo "[3/3] Wrote NOTICE  ->  ${NOTICE_PATH}"
echo ""
echo "Done. Vite will serve these from /emulator/* in the built site."
