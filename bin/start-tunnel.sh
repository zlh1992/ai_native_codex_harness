#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
ensure_runtime_dirs

if ! local_health; then
  echo "本地服务尚未就绪，请先运行 ./bin/start-local.sh。" >&2
  exit 1
fi

MODE="${PUBLIC_TUNNEL_MODE:-quick}"
TUNNEL_PID=""
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-.tools/cloudflared}"
[[ "$CLOUDFLARED_BIN" = /* ]] || CLOUDFLARED_BIN="$ROOT_DIR/$CLOUDFLARED_BIN"
LOCAL_CLOUDFLARED="$ROOT_DIR/.tools/cloudflared"

if [[ "$MODE" != "tailscale" ]]; then
  if [[ "$CLOUDFLARED_BIN" != "$LOCAL_CLOUDFLARED" ]]; then
    echo "拒绝使用项目外的 cloudflared：$CLOUDFLARED_BIN" >&2
    echo "请运行 ./bin/install-mac.sh 安装本项目独立副本。" >&2
    exit 2
  fi
  [[ -x "$CLOUDFLARED_BIN" ]] || { echo "缺少 ${LOCAL_CLOUDFLARED}，请运行 ./bin/install-mac.sh。" >&2; exit 2; }
fi

if launch_job_exists "$TUNNEL_LABEL"; then
  TUNNEL_PID="$(launch_job_pid "$TUNNEL_LABEL")"
  if [[ -n "$TUNNEL_PID" ]]; then
    ADDRESS="$(sed -n '1p' "$PUBLIC_URL_FILE" 2>/dev/null || true)"
    echo "公网隧道已运行：${ADDRESS:-地址正在生成}（PID ${TUNNEL_PID}）"
    exit 0
  fi
  remove_launch_job "$TUNNEL_LABEL"
fi
if TUNNEL_PID="$(read_pid "$TUNNEL_PID_FILE" 2>/dev/null)" && process_matches "$TUNNEL_PID" "$LOCAL_CLOUDFLARED"; then
  echo "发现旧版未纳管的本项目隧道 PID $TUNNEL_PID，请先运行 ./bin/stop-tunnel.sh。" >&2
  exit 1
fi
[[ -e "$TUNNEL_PID_FILE" ]] && rm -f "$TUNNEL_PID_FILE"
rm -f "$PUBLIC_URL_FILE" "$TUNNEL_MODE_FILE"
: > "$TUNNEL_LOG"

case "$MODE" in
  quick)
    launchctl submit -l "$TUNNEL_LABEL" -o "$TUNNEL_LOG" -e "$TUNNEL_LOG" -- "$CLOUDFLARED_BIN" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT"
    printf 'quick\n' > "$TUNNEL_MODE_FILE"
    chmod 600 "$TUNNEL_MODE_FILE"
    ADDRESS=""
    for _ in {1..45}; do
      launch_job_exists "$TUNNEL_LABEL" || { tail -n 40 "$TUNNEL_LOG" >&2; rm -f "$TUNNEL_PID_FILE" "$TUNNEL_MODE_FILE"; exit 1; }
      ADDRESS="$(sed -nE 's/.*(https:\/\/[A-Za-z0-9-]+\.trycloudflare\.com).*/\1/p' "$TUNNEL_LOG" | head -n 1)"
      [[ -n "$ADDRESS" ]] && break
      sleep 1
    done
    if [[ -z "$ADDRESS" ]]; then
      remove_launch_job "$TUNNEL_LABEL" || true
      rm -f "$TUNNEL_MODE_FILE"
      echo "隧道未能生成公网地址。" >&2
      exit 1
    fi
    ;;
  named)
    TOKEN_FILE="${PUBLIC_TUNNEL_TOKEN_FILE:-.data/cloudflare-tunnel.token}"
    [[ "$TOKEN_FILE" = /* ]] || TOKEN_FILE="$ROOT_DIR/$TOKEN_FILE"
    [[ -s "$TOKEN_FILE" ]] || { echo "隧道 token 文件不存在：$TOKEN_FILE" >&2; exit 2; }
    [[ "${PUBLIC_URL:-}" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || { echo "named 模式必须设置 PUBLIC_URL=https://你的域名" >&2; exit 2; }
    ADDRESS="${PUBLIC_URL%/}"
    launchctl submit -l "$TUNNEL_LABEL" -o "$TUNNEL_LOG" -e "$TUNNEL_LOG" -- "$CLOUDFLARED_BIN" tunnel --no-autoupdate --protocol "${CLOUDFLARED_PROTOCOL:-auto}" run --token-file "$TOKEN_FILE"
    printf 'named\n' > "$TUNNEL_MODE_FILE"
    chmod 600 "$TUNNEL_MODE_FILE"
    ;;
  tailscale)
    TAILSCALE_BIN="${TAILSCALE_BIN:-/usr/local/bin/tailscale}"
    [[ -x "$TAILSCALE_BIN" ]] || { echo "找不到 Tailscale CLI：$TAILSCALE_BIN" >&2; exit 2; }
    TAILSCALE_BE_CLI=1 "$TAILSCALE_BIN" funnel --bg --yes --https=443 "http://127.0.0.1:$PORT"
    ADDRESS="$(TAILSCALE_BE_CLI=1 "$TAILSCALE_BIN" status --json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const n=JSON.parse(s).Self.DNSName||"";process.stdout.write(n?`https://${n.replace(/\.$/,"")}`:"")})')"
    [[ -n "$ADDRESS" ]] || { echo "无法取得 Tailscale 公网地址。" >&2; exit 1; }
    printf 'tailscale\n' > "$TUNNEL_MODE_FILE"
    chmod 600 "$TUNNEL_MODE_FILE"
    ;;
  *) echo "PUBLIC_TUNNEL_MODE 只能是 quick、named 或 tailscale。" >&2; exit 2 ;;
esac

printf '%s\n' "$ADDRESS" > "$PUBLIC_URL_FILE"
chmod 600 "$PUBLIC_URL_FILE"
if [[ "$MODE" != "tailscale" ]]; then
  TUNNEL_PID="$(launch_job_pid "$TUNNEL_LABEL")"
  printf '%s\n' "$TUNNEL_PID" > "$TUNNEL_PID_FILE"
  chmod 600 "$TUNNEL_PID_FILE"
fi

public_health() {
  curl -fsS --max-time 5 "$ADDRESS/api/health" >/dev/null 2>&1 && return 0
  local hostname ip
  hostname="${ADDRESS#https://}"
  hostname="${hostname%%/*}"
  ip="$(dig +time=3 +tries=1 +short A @1.1.1.1 "$hostname" 2>/dev/null | head -n 1 || true)"
  if [[ -z "$ip" ]]; then
    ip="$(dig +time=3 +tries=1 +short A @8.8.8.8 "$hostname" 2>/dev/null | head -n 1 || true)"
  fi
  [[ -n "$ip" ]] || return 1
  curl -fsS --max-time 5 --resolve "$hostname:443:$ip" "$ADDRESS/api/health" >/dev/null 2>&1
}

for _ in {1..45}; do
  public_health && break
  sleep 1
done
if ! public_health; then
  if [[ -n "$TUNNEL_PID" ]]; then
    remove_launch_job "$TUNNEL_LABEL" || true
  fi
  rm -f "$TUNNEL_MODE_FILE" "$PUBLIC_URL_FILE"
  echo "隧道进程已启动，但公网健康检查尚未通过：$ADDRESS" >&2
  exit 1
fi
echo "公网隧道已启动：${ADDRESS}${TUNNEL_PID:+（PID ${TUNNEL_PID}）}"
[[ "$MODE" == "quick" ]] && echo "Quick Tunnel 重启后会生成新地址。"
