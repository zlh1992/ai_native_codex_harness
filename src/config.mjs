import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(SOURCE_DIR, '..');

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
  return Object.freeze({
    rootDir: ROOT_DIR,
    publicDir: path.join(ROOT_DIR, 'public'),
    host: env.HOST || '127.0.0.1',
    port: integer(env.PORT, 4310, 1),
    publicOrigin: String(env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, true),
    sessionTtlSeconds: integer(env.SESSION_TTL_SECONDS, 12 * 60 * 60, 300),
    dataDir,
    databasePath: resolved(env.DATABASE_PATH, path.join(dataDir, 'harness.sqlite')),
    workspacesRoot: resolved(env.WORKSPACES_ROOT, path.join(dataDir, 'workspaces')),
    treesRoot: resolved(env.TREES_ROOT, path.join(dataDir, 'trees')),
    runtimeRoot: resolved(env.RUNTIME_ROOT, path.join(dataDir, 'runtime')),
    trashRoot: resolved(env.TRASH_ROOT, path.join(dataDir, 'trash')),
    portalSkillsRoot: resolved(env.PORTAL_SKILLS_ROOT, path.join(ROOT_DIR, 'portal-skills')),
    portalAgentConfig: resolved(env.PORTAL_AGENT_CONFIG, path.join(ROOT_DIR, 'portal-agents', 'luna.toml')),
    codexBin: env.CODEX_BIN || '/Applications/ChatGPT.app/Contents/Resources/codex',
    codexCliVersion: '0.150.0-alpha.8',
    codexModel: env.CODEX_MODEL || 'gpt-5.6-sol',
    codexModelProvider: env.CODEX_MODEL_PROVIDER || 'openai_http',
    chatgptCodexBaseUrl: env.CHATGPT_CODEX_BASE_URL || 'https://chatgpt.com/backend-api/codex',
    codexReasoningEffort: env.CODEX_REASONING_EFFORT || 'high',
    codexRequestTimeoutMs: integer(env.CODEX_REQUEST_TIMEOUT_MS, 20 * 60 * 1000, 10_000),
    codexMaxConcurrentTurns,
    portalMaxActiveRootTurns: Math.min(11, integer(env.PORTAL_MAX_ACTIVE_ROOT_TURNS, 11, 1)),
    portalMaxExecuteLeases: Math.min(2, integer(env.PORTAL_MAX_EXECUTE_LEASES, 2, 1)),
    executionLeaseTtlMs: integer(env.EXECUTION_LEASE_TTL_MS, 30_000, 5_000),
    subagentModel: 'gpt-5.6-luna',
    maxSubagentsPerRoot: 3,
    defaultNetworkAccess: bool(env.DEFAULT_NETWORK_ACCESS, false),
    defaultMaxProjects: Math.min(100, integer(env.DEFAULT_MAX_PROJECTS, 100, 1)),
    defaultMaxStorageBytes: integer(env.DEFAULT_MAX_STORAGE_BYTES, 2 * 1024 * 1024 * 1024, 1024),
    defaultMaxConcurrentTurns: Math.min(codexMaxConcurrentTurns, integer(env.DEFAULT_MAX_CONCURRENT_TURNS, 40, 1)),
    commandTimeoutMs: integer(env.COMMAND_TIMEOUT_MS, 120_000, 1_000),
    commandMaxOutputBytes: integer(env.COMMAND_MAX_OUTPUT_BYTES, 1024 * 1024, 1024),
    fileMaxBytes: integer(env.FILE_MAX_BYTES, 10 * 1024 * 1024, 1024),
    uploadMaxBytes: integer(env.UPLOAD_MAX_BYTES, 50 * 1024 * 1024, 1024),
    adminUsername: String(env.ADMIN_USERNAME || ''),
    adminPassword: String(env.ADMIN_PASSWORD || ''),
  });
}
