#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
read -r -p "超级管理员用户名 [superadmin]: " ADMIN_NAME
ADMIN_NAME="${ADMIN_NAME:-superadmin}"
exec node src/cli.mjs create-admin "--username=$ADMIN_NAME"
