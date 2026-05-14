#!/usr/bin/env bash
#
# tools/test-demo.sh — automated boot-tester for prebuilt demos.
# Implements the debug-loop tool spec'd in #71.
#
# Drives a single prebuilt demo through the playground, captures the
# `[prebuilt-demo]` console log + a screenshot of the emulator after a
# configurable boot wait.  Useful when iterating on vendored binaries
# without wanting to manually hard-refresh + click + screenshot for
# each cycle.
#
# Usage:
#   tools/test-demo.sh <demo-id> [--site=pages|preview] [--boot-wait=SECS]
#
# Examples:
#   tools/test-demo.sh hello-bare                      # uses deployed Pages
#   tools/test-demo.sh hello-toolbox --site=preview    # builds + serves locally
#   tools/test-demo.sh hello-initgraf --boot-wait=45   # longer wait on cold cache
#
# Output (under tests/e2e/screenshots/):
#   <demo-id>-<ISO timestamp>.png    — viewport screenshot of the emulator
#   <demo-id>-<ISO timestamp>.json   — { console logs, SHA prefix, paths }
#
# Exit status: 0 if the harness reached the screenshot step (success means
# "we got a captured signal" — NOT "the demo ran correctly").  Non-zero
# only if Playwright itself errors (page didn't load, button missing).

set -euo pipefail

DEMO_ID="${1:-}"
if [ -z "${DEMO_ID}" ]; then
  echo "usage: $0 <demo-id> [--site=pages|preview] [--boot-wait=SECS]" >&2
  echo "  demo-id: one of hello-bare | hello-toolbox | hello-initgraf" >&2
  exit 2
fi
shift

SITE="pages"
BOOT_WAIT="30"
for arg in "$@"; do
  case "${arg}" in
    --site=*)      SITE="${arg#--site=}" ;;
    --boot-wait=*) BOOT_WAIT="${arg#--boot-wait=}" ;;
    *) echo "unknown arg: ${arg}" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "[test-demo] demo-id   = ${DEMO_ID}"
echo "[test-demo] site      = ${SITE}"
echo "[test-demo] boot-wait = ${BOOT_WAIT}s"

case "${SITE}" in
  pages)
    BASE_URL="https://khawkins98.github.io/classic-vibe-mac/"
    echo "[test-demo] using deployed Pages: ${BASE_URL}"
    ;;
  preview)
    # Build the site, then start `vite preview` on a non-default port to
    # avoid clashing with a stray `npm run dev` from another shell.
    echo "[test-demo] building site ..."
    (cd src/web && npm run build > /tmp/test-demo-build.log 2>&1) || {
      echo "[test-demo] build FAILED — see /tmp/test-demo-build.log" >&2
      exit 1
    }
    echo "[test-demo] starting vite preview on :4173 ..."
    (cd src/web && npx vite preview --port 4173 --strictPort \
       > /tmp/test-demo-preview.log 2>&1) &
    PREVIEW_PID=$!
    trap 'kill ${PREVIEW_PID} 2>/dev/null || true' EXIT
    # Wait for preview server to respond
    for i in $(seq 1 30); do
      if curl -sf http://localhost:4173/ > /dev/null 2>&1; then
        echo "[test-demo] preview server ready"
        break
      fi
      sleep 1
      if [ "${i}" = "30" ]; then
        echo "[test-demo] preview server didn't start in 30s" >&2
        cat /tmp/test-demo-preview.log >&2
        exit 1
      fi
    done
    BASE_URL="http://localhost:4173/"
    ;;
  *)
    echo "unknown --site=${SITE}; use pages or preview" >&2
    exit 2
    ;;
esac

mkdir -p tests/e2e/screenshots

# Hand off to Playwright using the dedicated debug-loop config.
echo "[test-demo] running Playwright ..."
DEMO_ID="${DEMO_ID}" \
BOOT_WAIT="${BOOT_WAIT}" \
BASE_URL="${BASE_URL}" \
OUT_DIR="tests/e2e/screenshots" \
  npx playwright test \
    --config=playwright.test-demo.config.ts \
    --reporter=list

# Surface the most-recent artefacts so the caller knows where to look.
echo
echo "[test-demo] latest artefacts:"
ls -t tests/e2e/screenshots/${DEMO_ID}-*.png 2>/dev/null | head -1 | sed "s/^/  png:  /"
ls -t tests/e2e/screenshots/${DEMO_ID}-*.json 2>/dev/null | head -1 | sed "s/^/  json: /"
