#!/usr/bin/env bash
# build-wasm-rez.sh — rebuild the in-browser WASM-Rez compiler from source.
#
# Output: src/web/public/wasm-rez/wasm-rez.{js,wasm}
# Source: tools/wasm-rez/ (the production-promoted spike artefacts)
#
# Two execution modes:
#   1. Native emsdk in PATH (emcmake + emcc) — fastest local dev.
#   2. Docker (emscripten/emsdk image) — fallback when emsdk isn't installed.
#      Auto-selected if `emcmake` isn't on PATH and `docker` is.
#
# Why this exists at all: Phase 2 vendors prebuilt WASM artefacts (Track 1b
# from Issue #30) so CI doesn't depend on an emsdk runtime in the build job.
# But the source is the canonical artefact — every change to MiniLexer.cc /
# Rez_main.cc / the bundled retro68 sources should round-trip through this
# script and the resulting prebuilt blobs should be re-committed. The
# corresponding GitHub Actions step (currently a no-op verification stub) is
# in .github/workflows/build.yml.
#
# Usage:
#   ./scripts/build-wasm-rez.sh           # build into src/web/public/wasm-rez/
#   ./scripts/build-wasm-rez.sh --check   # build to a tempdir and compare hashes
#                                         # against the committed blobs
#
# Exit codes:
#   0  build succeeded (and matched committed hashes if --check)
#   1  build failed
#   2  --check: hashes differ
#   3  prerequisites missing (no emsdk + no docker)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${REPO_ROOT}/tools/wasm-rez"
OUT_DIR="${REPO_ROOT}/src/web/public/wasm-rez"
CHECK_MODE=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_MODE=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

# Resolve a build directory. In --check mode we use a tempdir so the on-disk
# artefacts stay pristine until we've verified the rebuild matches.
if [[ "$CHECK_MODE" -eq 1 ]]; then
  STAGE_DIR="$(mktemp -d -t wasm-rez-check-XXXXXX)"
  trap 'rm -rf "$STAGE_DIR"' EXIT
else
  STAGE_DIR="${TOOLS_DIR}/build/wasm"
  mkdir -p "$STAGE_DIR"
fi

run_native_build() {
  echo "[build-wasm-rez] using native emsdk: $(command -v emcc)"
  ( cd "$TOOLS_DIR" && emcmake cmake -S . -B "$STAGE_DIR" -DSPIKE_WASM=ON -DSPIKE_MINI=ON )
  cmake --build "$STAGE_DIR" -j
}

run_docker_build() {
  echo "[build-wasm-rez] using docker: emscripten/emsdk:3.1.51"
  docker run --rm \
    -v "$REPO_ROOT:/repo" \
    -w /repo/tools/wasm-rez \
    emscripten/emsdk:3.1.51 \
    bash -c "emcmake cmake -S . -B build/wasm-docker -DSPIKE_WASM=ON -DSPIKE_MINI=ON && cmake --build build/wasm-docker -j"
  STAGE_DIR="${TOOLS_DIR}/build/wasm-docker"
}

if command -v emcmake >/dev/null 2>&1; then
  run_native_build
elif command -v docker >/dev/null 2>&1; then
  run_docker_build
else
  echo "error: neither emsdk nor docker available — cannot build WASM-Rez" >&2
  echo "       install emsdk (https://emscripten.org/docs/getting_started/downloads.html)" >&2
  echo "       or Docker Desktop, then re-run." >&2
  exit 3
fi

# The CMake target name is 'mini-rez' (legacy from the spike). We rename to
# 'wasm-rez' on copy to keep the production naming consistent.
SRC_JS="${STAGE_DIR}/mini-rez.js"
SRC_WASM="${STAGE_DIR}/mini-rez.wasm"

if [[ ! -f "$SRC_JS" || ! -f "$SRC_WASM" ]]; then
  echo "error: build did not produce expected artefacts in $STAGE_DIR" >&2
  ls -la "$STAGE_DIR" >&2 || true
  exit 1
fi

if [[ "$CHECK_MODE" -eq 1 ]]; then
  expected_js=$(shasum -a 256 "${OUT_DIR}/wasm-rez.js" | awk '{print $1}')
  expected_wasm=$(shasum -a 256 "${OUT_DIR}/wasm-rez.wasm" | awk '{print $1}')
  actual_js=$(shasum -a 256 "$SRC_JS" | awk '{print $1}')
  actual_wasm=$(shasum -a 256 "$SRC_WASM" | awk '{print $1}')
  echo "expected wasm-rez.js   : $expected_js"
  echo "actual                 : $actual_js"
  echo "expected wasm-rez.wasm : $expected_wasm"
  echo "actual                 : $actual_wasm"
  if [[ "$expected_js" != "$actual_js" || "$expected_wasm" != "$actual_wasm" ]]; then
    echo "error: rebuild does not match committed blobs" >&2
    exit 2
  fi
  echo "ok: hashes match committed blobs"
  exit 0
fi

mkdir -p "$OUT_DIR"
cp "$SRC_JS" "${OUT_DIR}/wasm-rez.js"
cp "$SRC_WASM" "${OUT_DIR}/wasm-rez.wasm"

echo "[build-wasm-rez] wrote:"
ls -lh "${OUT_DIR}/wasm-rez.js" "${OUT_DIR}/wasm-rez.wasm"
echo "gzip estimate:"
gzip -9c "${OUT_DIR}/wasm-rez.wasm" | wc -c | awk '{ printf "  wasm.gz : %.1f KB\n", $1/1024 }'
