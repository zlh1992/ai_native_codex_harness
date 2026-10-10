#!/bin/bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$PROJECT_DIR/bin/services.sh" status
