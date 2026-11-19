#!/usr/bin/env bash

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$COMMON_DIR/.." && pwd)"
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4310}"
DATA_DIR_ABS="${DATA_DIR:-.data}"
[[ "$DATA_DIR_ABS" = /* ]] || DATA_DIR_ABS="$ROOT_DIR/$DATA_DIR_ABS"
LOG_DIR="${CODEX_HARNESS_LOG_DIR:-$HOME/Library/Logs/CodexHarnessRemote}"
SERVER_PID_FILE="$DATA_DIR_ABS/server.pid"
TUNNEL_PID_FILE="$DATA_DIR_ABS/tunnel.pid"
TUNNEL_MODE_FILE="$DATA_DIR_ABS/tunnel.mode"
PUBLIC_URL_FILE="$DATA_DIR_ABS/public-url"
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/public-tunnel.log"
SERVER_MARKER="$ROOT_DIR/src/server.mjs"
SERVER_LABEL="com.codex-harness-remote.server"
TUNNEL_LABEL="com.codex-harness-remote.tunnel"
HARNESS_PROCESS_MODE="${HARNESS_PROCESS_MODE:-launchd}"
CODEX_MODEL_PROVIDER="${CODEX_MODEL_PROVIDER:-openai_http}"
CHATGPT_CODEX_BASE_URL="${CHATGPT_CODEX_BASE_URL:-https://chatgpt.com/backend-api/codex}"
# 私有 CODEX_HOME：本项目的 app-server 固定在 0.150.0-alpha.8，会按自身 client_version 重写
# models_cache.json。若与桌面 Codex 共用 ~/.codex，会抹掉桌面正在使用的模型元数据，
# 因此默认落在项目数据目录内；上游登录凭据仍通过符号链接复用，保持单上游登录。
CODEX_HOME="${CODEX_HOME:-$DATA_DIR_ABS/codex-home}"
export CODEX_HOME
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" && -x "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node" ]]; then
  NODE_BIN="/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
fi

validate_codex_upstream() {
  local expected="https://chatgpt.com/backend-api/codex"
  if [[ "$CODEX_MODEL_PROVIDER" != "openai_http" ]]; then
    echo "拒绝启动：普通项目和微信渠道必须使用本机 ChatGPT 官方 provider（openai_http）。" >&2
    return 2
  fi
  if [[ "${CHATGPT_CODEX_BASE_URL%/}" != "$expected" ]]; then
    echo "拒绝启动：CHATGPT_CODEX_BASE_URL 必须为 ChatGPT 官方地址，当前配置不受支持。" >&2
    return 2
  fi
}

validate_codex_home() {
  # 拒绝与桌面 Codex 共用家目录：本项目 pin 的 CLI 会按自身 client_version 覆写
  # models_cache.json，共用会把桌面正在使用的模型元数据抹掉（桌面退回 fallback 元数据、
  # 上下文窗口偏小、提前自动压缩），因此这一共用必须在启动前 fail closed。
  local mine="${CODEX_HOME%/}" shared="${HOME%/}/.codex"
  if [[ -n "$mine" && -e "$mine" && -e "$shared" ]]; then
    mine="$(cd "$mine" && pwd -P)"
    shared="$(cd "$shared" && pwd -P)"
  fi
  if [[ -n "$mine" && "$mine" == "$shared" ]]; then
    echo "拒绝启动：CODEX_HOME 不能与桌面 Codex 共用 ${HOME%/}/.codex，请使用项目私有目录（默认 \$DATA_DIR/codex-home）。" >&2
    return 2
  fi
}

codex_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok&&x.codex===true&&x.codexState==="ready"?0:1)}catch{process.exit(1)}})'
}

ensure_runtime_dirs() {
  mkdir -p "$DATA_DIR_ABS" "$LOG_DIR" "$ROOT_DIR/.tools" "$CODEX_HOME"
  chmod 700 "$DATA_DIR_ABS" "$LOG_DIR" "$ROOT_DIR/.tools" "$CODEX_HOME"
  # 复用老板本机 ChatGPT 登录：符号链接而非副本，避免两份 refresh token 互相踢出。
  local credential
  for credential in auth.json installation_id; do
    if [[ ! -e "$CODEX_HOME/$credential" && -e "$HOME/.codex/$credential" ]]; then
      ln -s "$HOME/.codex/$credential" "$CODEX_HOME/$credential"
    fi
  done
}

read_pid() {
  local file="$1" value=""
  [[ -f "$file" ]] && IFS= read -r value < "$file"
  [[ "$value" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$value"
}

process_matches() {
  local pid="$1" marker="$2" command=""
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$marker"* ]]
}

launch_job_exists() {
  if [[ -f "$DATA_DIR_ABS/$1.process.json" ]]; then
    python3 "$COMMON_DIR/background-process.py" status "$DATA_DIR_ABS/$1.process.json" >/dev/null 2>&1 && return 0
  fi
  launchctl list "$1" >/dev/null 2>&1
}

launch_job_pid() {
  local details=""
  if [[ -f "$DATA_DIR_ABS/$1.process.json" ]]; then
    python3 "$COMMON_DIR/background-process.py" status "$DATA_DIR_ABS/$1.process.json" 2>/dev/null && return 0
  fi
  details="$(launchctl list "$1" 2>/dev/null || true)"
  printf '%s\n' "$details" | sed -nE 's/^[[:space:]]*"PID" = ([0-9]+);/\1/p' | head -n 1
}

remove_launch_job() {
  local label="$1"
  if [[ -f "$DATA_DIR_ABS/$label.process.json" ]]; then
    python3 "$COMMON_DIR/background-process.py" stop "$DATA_DIR_ABS/$label.process.json" || return 1
  fi
  if launchctl list "$label" >/dev/null 2>&1; then launchctl remove "$label"; fi
}

start_managed_job() {
  local label="$1" log="$2"
  shift 2
  case "$HARNESS_PROCESS_MODE" in
    detached)
      python3 "$COMMON_DIR/background-process.py" start "$DATA_DIR_ABS/$label.process.json" "$ROOT_DIR" "$log" "$@" >/dev/null
      ;;
    launchd)
      launchctl submit -l "$label" -o "$log" -e "$log" -- "$@"
      ;;
    *) echo "HARNESS_PROCESS_MODE 只能是 launchd 或 detached。" >&2; return 2 ;;
  esac
}

wait_launch_job_gone() {
  local label="$1"
  for _ in {1..50}; do
    launch_job_exists "$label" || return 0
    sleep 0.1
  done
  return 1
}

local_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok&&(x.codex||(x.localQwen?.enabled&&x.localQwen.state==="ready"))?0:1)}catch{process.exit(1)}})'
}

local_web_health() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok?0:1)}catch{process.exit(1)}})'
}

local_codex_failed() {
  curl -fsS --max-time 5 "http://127.0.0.1:$PORT/api/health" 2>/dev/null \
    | "$NODE_BIN" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const x=JSON.parse(s);process.exit(x.ok&&x.codexState==="failed"&&!(x.localQwen?.enabled&&["starting","ready"].includes(x.localQwen.state))?0:1)}catch{process.exit(1)}})'
}

stop_owned_pid() {
  local file="$1" marker="$2" label="$3" pid=""
  if ! pid="$(read_pid "$file")"; then
    [[ -e "$file" ]] && rm -f "$file"
    echo "${label}：未运行"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    echo "${label}：已停止（已清理失效 PID ${pid}）"
    return 0
  fi
  if ! process_matches "$pid" "$marker"; then
    echo "拒绝停止 PID ${pid}：它不属于本项目的 ${label}。" >&2
    return 1
  fi
  kill "$pid"
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi
  rm -f "$file"
  echo "${label}：已停止"
}

print_portal_addresses() {
  local portal_base="${1%/}"
  local boss_base="$portal_base" employee_base="$portal_base"
  if [[ "${2:-}" == "named" ]]; then
    boss_base="${BOSS_PUBLIC_ORIGIN:-$portal_base}"
    employee_base="${EMPLOYEE_PUBLIC_ORIGIN:-$portal_base}"
  fi
  echo "老板登录：${boss_base%/}/boss/login"
  echo "员工登录：${employee_base%/}/employee"
}
