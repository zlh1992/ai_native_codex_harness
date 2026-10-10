#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "$0")" && pwd)/_common.sh"
cd "$ROOT_DIR"
BRIDGE_DIR="${WECHAT_BRIDGE_DIR:-$(dirname "$ROOT_DIR")/wx_codex_self}"
ACTION="${1:-status}"
[[ -f "$BRIDGE_DIR/scripts/wechat_codex.sh" ]] || { echo "找不到微信 relay 管理脚本，请设置 WECHAT_BRIDGE_DIR。" >&2; exit 2; }
relay() { bash "$BRIDGE_DIR/scripts/wechat_codex.sh" "$1"; }
wechat_ready() {
  curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:18767/status | "$NODE_BIN" -e '
    let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(["running","waiting_for_wechat_scan"].includes(x.phase)?0:1)}catch{process.exit(1)}})'
}
case "$ACTION" in
  start)
    validate_codex_upstream
    bash "$ROOT_DIR/bin/start-public.sh"
    relay start
    for attempt in {1..30}; do
      if wechat_ready 2>/dev/null; then
        echo "整套服务已启动。微信绑定页：http://127.0.0.1:18767/"
        relay status
        exit 0
      fi
      sleep 1
    done
    echo "Portal/公网已启动，但微信服务未就绪。" >&2
    exit 1
    ;;
  stop)
    result=0
    relay stop || result=1
    bash "$ROOT_DIR/bin/stop-tunnel.sh" || result=1
    bash "$ROOT_DIR/bin/stop-local.sh" || result=1
    exit "$result"
    ;;
  restart)
    bash "$0" stop
    exec bash "$0" start
    ;;
  status)
    bash "$ROOT_DIR/bin/status.sh"
    relay status
    ;;
  health)
    validate_codex_upstream
    codex_health || { echo "Portal 官方 Codex 引擎未就绪。" >&2; exit 1; }
    bash "$ROOT_DIR/bin/healthcheck.sh"
    relay health
    wechat_ready
    ;;
  reset-wechat-qr)
    bash "$0" start
    exec bash "$BRIDGE_DIR/reset-qr.command"
    ;;
  *) echo "用法：services.sh start|stop|restart|status|health|reset-wechat-qr" >&2; exit 2 ;;
esac
