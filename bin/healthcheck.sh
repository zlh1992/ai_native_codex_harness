#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Use the same environment and official-upstream preflight as the lifecycle scripts.
source "$ROOT_DIR/bin/_common.sh"
validate_codex_upstream
curl -fsS "http://${HOST:-127.0.0.1}:${PORT:-4310}/api/health"
printf '\n'
