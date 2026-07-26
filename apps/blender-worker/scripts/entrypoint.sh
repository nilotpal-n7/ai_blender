#!/usr/bin/env bash
# ─── Blender Worker Entrypoint ───────────────────────────────────────
#
# This script is the Docker entrypoint for the Blender worker container.
# It launches Blender in headless (background) mode and executes the
# Python worker loop that polls Redis for assembly/render jobs.
#
# Environment Variables:
#   BLENDER_BIN    Path to the Blender binary (default: /usr/local/blender/blender)
#   WORKER_SCRIPT  Path to the worker Python script (default: /app/src/worker.py)
#
# Usage:
#   docker run ai-blender-worker  (uses defaults)
#   BLENDER_BIN=/opt/blender/blender docker run ai-blender-worker
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

BLENDER_BIN="${BLENDER_BIN:-/usr/local/blender/blender}"
WORKER_SCRIPT="${WORKER_SCRIPT:-/app/src/worker.py}"

echo "═══════════════════════════════════════════════"
echo "  AI Blender — Headless Worker"
echo "  Blender: ${BLENDER_BIN}"
echo "  Script:  ${WORKER_SCRIPT}"
echo "═══════════════════════════════════════════════"

# Verify Blender binary exists
if [ ! -f "${BLENDER_BIN}" ]; then
    echo "ERROR: Blender binary not found at ${BLENDER_BIN}"
    exit 1
fi

# Print Blender version for logging
"${BLENDER_BIN}" --version 2>/dev/null || true

# Launch Blender in background mode with the worker script
exec "${BLENDER_BIN}" --background --python "${WORKER_SCRIPT}" -- "$@"
