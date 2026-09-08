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
mkdir -p .tools .data/memory-index .data/memory-model-cache
chmod 700 .tools .data .data/memory-index .data/memory-model-cache

MEMORY_PYTHON=""
for candidate in python3.12 python3.11 python3.10 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3,10))'; then
    MEMORY_PYTHON="$(command -v "$candidate")"
    break
  fi
done
if [[ -z "$MEMORY_PYTHON" ]] && command -v brew >/dev/null 2>&1; then
  echo "安装 Portal 记忆索引所需的 Python 3.12……"
  brew install python@3.12
  MEMORY_PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
fi
if [[ -z "$MEMORY_PYTHON" ]]; then
  echo "需要 Python >= 3.10 以安装本地 memsearch 记忆索引。" >&2
  exit 2
fi
echo "安装锁定的 memsearch 0.4.19 与本地 ONNX 依赖……"
"$MEMORY_PYTHON" -m venv .tools/memory-venv
.tools/memory-venv/bin/python3 -m pip install --disable-pip-version-check -r requirements-memory.txt
if [[ "${MEMORY_MODEL_WARMUP:-1}" == "1" ]]; then
  echo "下载并固定本地双语记忆模型（首次约 558 MB）……"
  MEMORY_MODEL_CACHE_ROOT="$ROOT_DIR/.data/memory-model-cache" \
  .tools/memory-venv/bin/python3 - <<'PY'
import os
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="gpahal/bge-m3-onnx-int8",
    revision="2b34e84df040034d4b9eabb62383a87c18955822",
    cache_dir=os.environ["MEMORY_MODEL_CACHE_ROOT"],
)
PY
fi

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
mkdir -p .data/workspaces .data/memory-index .data/memory-model-cache .logs .tools
chmod 700 .data .data/workspaces .data/memory-index .data/memory-model-cache .logs .tools

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
