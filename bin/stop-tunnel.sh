#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_dirs

MODE="$(sed -n '1p' "$TUNNEL_MODE_FILE" 2>/dev/null || true)"
if [[ "$MODE" == "tailscale" ]]; then
  TAILSCALE_BIN="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"
  if [[ -x "$TAILSCALE_BIN" ]]; then TAILSCALE_BE_CLI=1 "$TAILSCALE_BIN" funnel --https=443 off >/dev/null; fi
  echo "公网隧道：已停止"
else
  if launch_job_exists "$TUNNEL_LABEL"; then
    launchctl remove "$TUNNEL_LABEL"
    wait_launch_job_gone "$TUNNEL_LABEL" || { echo "公网隧道未能及时退出。" >&2; exit 1; }
    rm -f "$TUNNEL_PID_FILE"
    echo "公网隧道：已停止"
  else
    stop_owned_pid "$TUNNEL_PID_FILE" "$ROOT_DIR/.tools/cloudflared" "公网隧道"
  fi
fi
rm -f "$TUNNEL_MODE_FILE" "$PUBLIC_URL_FILE"
