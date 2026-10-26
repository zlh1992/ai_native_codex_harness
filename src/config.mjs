import path from 'node:path';
import { validateModel } from './models.mjs';
import { publicIngressConfig } from './public-ingress.mjs';
import { localModelUrl } from './private-projects.mjs';
import { fileURLToPath } from 'node:url';
import { invariant } from './errors.mjs';
import { outboundProxyMode } from './outbound-proxy.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SOURCE_DIR, '..');
export const OFFICIAL_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true' || String(value) === '1';
}

function integer(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function resolved(value, fallback) {
  const candidate = value || fallback;
  return path.isAbsolute(candidate) ? candidate : path.resolve(ROOT_DIR, candidate);
}

export function loadConfig(env = process.env) {
  const dataDir = resolved(env.DATA_DIR, '.data');
  const codexMaxConcurrentTurns = Math.min(40, integer(env.CODEX_MAX_CONCURRENT_TURNS, 40, 1));
  const portalMaxActiveRootTurns = Math.min(11, integer(env.PORTAL_MAX_ACTIVE_ROOT_TURNS, 11, 1));
  const codexModelProvider = String(env.CODEX_MODEL_PROVIDER || 'openai_http').trim();
  const chatgptCodexBaseUrl = String(env.CHATGPT_CODEX_BASE_URL || OFFICIAL_CODEX_BASE_URL).replace(/\/+$/u, '');
  invariant(codexModelProvider === 'openai_http', 500, 'CODEX_PROVIDER_NOT_ALLOWED',
    '普通项目和微信渠道必须使用本机 ChatGPT 官方 provider（openai_http）。');
  invariant(chatgptCodexBaseUrl === OFFICIAL_CODEX_BASE_URL, 500, 'CODEX_BASE_URL_NOT_ALLOWED',
    '普通项目和微信渠道必须使用 ChatGPT 官方 Codex 地址。');
  return Object.freeze({
    rootDir: ROOT_DIR,
    localQwenEnabled: bool(env.LOCAL_QWEN_ENABLED, false),
    localQwenBaseUrl: localModelUrl(env.LOCAL_QWEN_BASE_URL),
    // The adapter accepts the configured local OpenAI-compatible Qwen model.
    localQwenModel: String(env.LOCAL_QWEN_MODEL || 'Qwen3.8-Flash-Next-oQ5e-mtp'),
    localQwenContextWindow: integer(env.LOCAL_QWEN_CONTEXT_WINDOW, 262144, 4096),
    localQwenMaxTokens: integer(env.LOCAL_QWEN_MAX_TOKENS, 8192, 256),
    localQwenTimeoutMs: integer(env.LOCAL_QWEN_TIMEOUT_MS, 20 * 60 * 1000, 1000),
    localSearchTimeoutMs: integer(env.LOCAL_SEARCH_TIMEOUT_MS, 120000, 1000),
    localSessionsRoot: path.join(dataDir, 'local-sessions'),
    publicDir: path.join(ROOT_DIR, 'public'),
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 4310, 1),
    ...publicIngressConfig(env),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, true),
    sessionTtlSeconds: integer(env.SESSION_TTL_SECONDS, 12 * 60 * 60, 300),
    dataDir,
    databasePath: resolved(env.DATABASE_PATH, path.join(dataDir, 'harness.sqlite')),
    workspacesRoot: resolved(env.WORKSPACES_ROOT, path.join(dataDir, 'workspaces')),
    treesRoot: resolved(env.TREES_ROOT, path.join(dataDir, 'trees')),
    runtimeRoot: resolved(env.RUNTIME_ROOT, path.join(dataDir, 'runtime')),
    trashRoot: resolved(env.TRASH_ROOT, path.join(dataDir, 'trash')),
    memoryEnabled: bool(env.PORTAL_MEMORY_ENABLED, true),
    memoryIndexRoot: resolved(env.MEMORY_INDEX_ROOT, path.join(dataDir, 'memory-index')),
    memoryModelCacheRoot: resolved(env.MEMORY_MODEL_CACHE_ROOT, path.join(dataDir, 'memory-model-cache')),
    memoryPython: resolved(env.MEMORY_PYTHON, path.join(ROOT_DIR, '.tools', 'memory-venv', 'bin', 'python3')),
    memoryIndexWorker: resolved(env.MEMORY_INDEX_WORKER, path.join(ROOT_DIR, 'bin', 'memory-index-worker.py')),
    memoryEmbeddingModel: 'gpahal/bge-m3-onnx-int8',
    memoryEmbeddingRevision: '2b34e84df040034d4b9eabb62383a87c18955822',
    memoryRecallLimit: Math.min(8, integer(env.MEMORY_RECALL_LIMIT, 8, 1)),
    memoryRecallTimeoutMs: integer(env.MEMORY_RECALL_TIMEOUT_MS, 2_000, 250),
    memoryIndexTimeoutMs: integer(env.MEMORY_INDEX_TIMEOUT_MS, 120_000, 1_000),
    workGraphEnabled: bool(env.WORK_GRAPH_ENABLED, true),
    workGraphDispatchEnabled: bool(env.WORK_GRAPH_DISPATCH_ENABLED, true),
    workGraphAutoReviewEnabled: bool(env.WORK_GRAPH_AUTO_REVIEW_ENABLED, true),
    portalSkillsRoot: resolved(env.PORTAL_SKILLS_ROOT, path.join(ROOT_DIR, 'portal-skills')),
    portalAgentConfig: resolved(env.PORTAL_AGENT_CONFIG, path.join(ROOT_DIR, 'portal-agents', 'luna.toml')),
    codexBin: env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    codexCliVersion: '0.164.0-alpha.11.1',
    codexModel: validateModel(env.CODEX_MODEL || 'gpt-5.6-sol'),
    codexModelProvider,
    chatgptCodexBaseUrl,
    codexReasoningEffort: env.CODEX_REASONING_EFFORT || 'high',
    codexRequestTimeoutMs: integer(env.CODEX_REQUEST_TIMEOUT_MS, 20 * 60 * 1000, 10_000),
    codexMaxConcurrentTurns,
    portalMaxActiveRootTurns,
    portalMaxExecuteLeases: Math.min(portalMaxActiveRootTurns,
      integer(env.PORTAL_MAX_EXECUTE_LEASES, portalMaxActiveRootTurns, 1)),
    executionLeaseTtlMs: integer(env.EXECUTION_LEASE_TTL_MS, 30_000, 5_000),
    subagentModel: 'gpt-5.6-luna',
    maxSubagentsPerRoot: 3,
    defaultNetworkAccess: bool(env.DEFAULT_NETWORK_ACCESS, true),
    defaultMaxProjects: Math.min(100, integer(env.DEFAULT_MAX_PROJECTS, 100, 1)),
    defaultMaxStorageBytes: integer(env.DEFAULT_MAX_STORAGE_BYTES, 2 * 1024 * 1024 * 1024, 1024),
    defaultMaxConcurrentTurns: Math.min(codexMaxConcurrentTurns, integer(env.DEFAULT_MAX_CONCURRENT_TURNS, 40, 1)),
    commandTimeoutMs: integer(env.COMMAND_TIMEOUT_MS, 120_000, 1_000),
    commandPythonBin: env.COMMAND_PYTHON_BIN || '',
    commandGitBin: env.COMMAND_GIT_BIN || '',
    outboundProxy: outboundProxyMode(env.OUTBOUND_PROXY || 'system'),
    browserEnabled: bool(env.PORTAL_BROWSER_ENABLED, true),
    browserBin: env.PORTAL_BROWSER_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    browserMaxSessions: Math.min(2, integer(env.PORTAL_BROWSER_MAX_SESSIONS, 2, 1)),
    browserHandoffTimeoutMs: Math.min(600_000, integer(env.PORTAL_BROWSER_HANDOFF_TIMEOUT_MS, 600_000, 1000)),
    browserSessionsRoot: path.join(dataDir, 'browser-sessions'),
    commandMaxOutputBytes: integer(env.COMMAND_MAX_OUTPUT_BYTES, 1024 * 1024, 1024),
    fileMaxBytes: integer(env.FILE_MAX_BYTES, 10 * 1024 * 1024, 1024),
    taskDispatchEnabled: env.TASK_DISPATCH_ENABLED === 'true',
    weixinEnabled: env.WEIXIN_ENABLED === 'true',
    weixinPilotUserIds: String(env.WEIXIN_PILOT_USER_IDS || '').split(',').map(id => id.trim()).filter(Boolean),
    uploadMaxBytes: integer(env.UPLOAD_MAX_BYTES, 50 * 1024 * 1024, 1024),
    wechatChannelEnabled: bool(env.WECHAT_CHANNEL_ENABLED, false),
    wechatChannelProjectId: String(env.WECHAT_CHANNEL_PROJECT_ID || '').trim(),
    wechatChannelSenderId: String(env.WECHAT_CHANNEL_SENDER_ID || '').trim(),
    wechatChannelSecretFile: resolved(env.WECHAT_CHANNEL_SECRET_FILE, path.join(dataDir, 'wechat-channel.secret')),
    adminUsername: String(env.ADMIN_USERNAME || ''),
    adminPassword: String(env.ADMIN_PASSWORD || ''),
  });
}
