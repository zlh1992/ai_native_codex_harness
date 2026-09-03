#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_dirs

if [[ "$HOST" != "127.0.0.1" && "$HOST" != "localhost" && "$HOST" != "::1" ]]; then
  echo "拒绝非回环监听 HOST=${HOST}；请通过 HTTPS 隧道公开服务。" >&2
  exit 2
fi

if launch_job_exists "$SERVER_LABEL"; then
  SERVER_PID="$(launch_job_pid "$SERVER_LABEL")"
  if local_health; then
    echo "本地服务已运行：http://127.0.0.1:${PORT}（PID ${SERVER_PID}）"
    exit 0
  fi
  remove_launch_job "$SERVER_LABEL"
fi

if SERVER_PID="$(read_pid "$SERVER_PID_FILE" 2>/dev/null)" && process_matches "$SERVER_PID" "$SERVER_MARKER"; then
  echo "发现旧版未纳管的本项目服务 PID $SERVER_PID，请先运行 ./bin/stop-local.sh。" >&2
  exit 1
fi
[[ -e "$SERVER_PID_FILE" ]] && rm -f "$SERVER_PID_FILE"

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "端口 $PORT 已被一个未纳管的服务占用，拒绝重复启动。" >&2
  exit 1
fi

printf '\n[%s] starting local server\n' "$(date -u +%FT%TZ)" >> "$SERVER_LOG"
NODE_BIN="$(command -v node)"
launchctl submit -l "$SERVER_LABEL" -o "$SERVER_LOG" -e "$SERVER_LOG" -- "$NODE_BIN" "$SERVER_MARKER"

for _ in {1..60}; do
  if ! launch_job_exists "$SERVER_LABEL"; then
    tail -n 40 "$SERVER_LOG" >&2
    exit 1
  fi
  if local_health; then
    SERVER_PID="$(launch_job_pid "$SERVER_LABEL")"
    printf '%s\n' "$SERVER_PID" > "$SERVER_PID_FILE"
    chmod 600 "$SERVER_PID_FILE"
    echo "本地服务已启动：http://127.0.0.1:${PORT}（PID ${SERVER_PID}）"
    exit 0
  fi
  sleep 1
done

echo "本地服务未在 60 秒内就绪。" >&2
remove_launch_job "$SERVER_LABEL" || true
rm -f "$SERVER_PID_FILE"
tail -n 40 "$SERVER_LOG" >&2
exit 1
