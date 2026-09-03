#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_dirs

SERVER_PID="$(launch_job_pid "$SERVER_LABEL")"
if launch_job_exists "$SERVER_LABEL" && [[ -n "$SERVER_PID" ]] && local_health; then
  echo "本地服务：运行中（PID ${SERVER_PID}）"
  echo "本地地址：http://127.0.0.1:$PORT"
else
  echo "本地服务：已停止"
fi

MODE="$(sed -n '1p' "$TUNNEL_MODE_FILE" 2>/dev/null || true)"
ADDRESS="$(sed -n '1p' "$PUBLIC_URL_FILE" 2>/dev/null || true)"
TUNNEL_PID="$(launch_job_pid "$TUNNEL_LABEL")"
if [[ "$MODE" == "tailscale" && -n "$ADDRESS" ]]; then
  echo "公网隧道：Tailscale Funnel"
  echo "公网地址：$ADDRESS"
elif launch_job_exists "$TUNNEL_LABEL" && [[ -n "$TUNNEL_PID" ]]; then
  echo "公网隧道：运行中（${MODE}，PID ${TUNNEL_PID}）"
  echo "公网地址：${ADDRESS:-正在生成}"
else
  echo "公网隧道：已停止"
fi
