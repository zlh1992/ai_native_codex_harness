#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "需要 Node.js 22.13 或更高版本。建议先运行: brew install node" >&2
  exit 2
fi
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<13))process.exit(1)' || {
  echo "当前 Node.js 版本过低: $(node --version)，需要 >= 22.13。" >&2
  exit 2
}

if ! command -v npm >/dev/null 2>&1; then
  echo "未找到 npm；请安装包含 npm 的 Node.js 22.13 或更高版本。" >&2
  exit 2
fi
echo "安装锁定的 Node.js 运行依赖……"
npm ci --omit=dev --ignore-scripts

CODEX_CANDIDATE="${CODEX_BIN:-/Applications/ChatGPT.app/Contents/Resources/codex}"
if [[ ! -x "$CODEX_CANDIDATE" ]]; then
  if command -v codex >/dev/null 2>&1; then CODEX_CANDIDATE="$(command -v codex)";
  else echo "未找到 Codex。请安装 ChatGPT/Codex，并先完成 codex login。" >&2; exit 2; fi
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "已创建 $ROOT_DIR/.env"
fi
mkdir -p .data/workspaces .logs .tools
chmod 700 .data .data/workspaces .logs .tools

LOCAL_CLOUDFLARED="$ROOT_DIR/.tools/cloudflared"
if [[ ! -x "$LOCAL_CLOUDFLARED" ]]; then
  if command -v cloudflared >/dev/null 2>&1; then
    install -m 755 "$(command -v cloudflared)" "$LOCAL_CLOUDFLARED"
  elif command -v brew >/dev/null 2>&1; then
    echo "安装 cloudflared，并复制成本项目的独立运行副本……"
    brew install cloudflared
    install -m 755 "$(command -v cloudflared)" "$LOCAL_CLOUDFLARED"
  else
    echo "未找到 cloudflared 或 Homebrew。请先安装 Homebrew，然后重新运行本脚本。" >&2
    exit 2
  fi
fi
"$LOCAL_CLOUDFLARED" --version

echo "检查 Codex 登录状态："
"$CODEX_CANDIDATE" login status 2>&1 || true
echo
echo "安装完成。下一步："
echo "  ./bin/create-super-admin.sh"
echo "  ./bin/start-public.sh"
