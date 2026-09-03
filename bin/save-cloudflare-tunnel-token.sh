#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
TOKEN_FILE="${PUBLIC_TUNNEL_TOKEN_FILE:-.data/cloudflare-tunnel.token}"
[[ "$TOKEN_FILE" = /* ]] || TOKEN_FILE="$ROOT_DIR/$TOKEN_FILE"
mkdir -p "$(dirname "$TOKEN_FILE")"
read -r -s -p "Cloudflare named tunnel token: " TOKEN
printf '\n'
if [[ -z "$TOKEN" ]]; then echo "token 不能为空。" >&2; exit 2; fi
umask 077
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
echo "token 已保存到 ${TOKEN_FILE}（权限 600）。"
