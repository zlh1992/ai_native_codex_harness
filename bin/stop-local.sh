#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_dirs
if launch_job_exists "$SERVER_LABEL"; then
  launchctl remove "$SERVER_LABEL"
  wait_launch_job_gone "$SERVER_LABEL" || { echo "本地服务未能及时退出。" >&2; exit 1; }
  rm -f "$SERVER_PID_FILE"
  echo "本地服务：已停止"
else
  stop_owned_pid "$SERVER_PID_FILE" "$SERVER_MARKER" "本地服务"
fi
