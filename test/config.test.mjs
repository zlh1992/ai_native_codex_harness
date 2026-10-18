import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('concurrency defaults to 40 and is hard-capped at 40', () => {
  const config = loadConfig({});
  assert.equal(config.codexModelProvider, 'openai_http');
  assert.equal(config.codexModel, 'gpt-6-luna');
  assert.equal(config.chatgptCodexBaseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.equal(config.codexMaxConcurrentTurns, 40);
  assert.equal(config.portalMaxActiveRootTurns, 11);
  assert.equal(config.portalMaxExecuteLeases, 11);
  assert.equal(config.maxSubagentsPerRoot, 3);
  assert.equal(config.subagentModel, 'gpt-5.6-luna');
  assert.equal(config.codexCliVersion, '0.150.0-alpha.8');
  assert.match(config.portalAgentConfig, /portal-agents\/luna\.toml$/);
  assert.equal(config.defaultMaxProjects, 100);
  assert.equal(config.localQwenModel, 'Qwen3.8-Flash-Next-oQ5e-mtp');
  assert.equal(config.localQwenContextWindow, 262144);
  assert.match(config.treesRoot, /\.data\/trees$/);
  assert.match(config.runtimeRoot, /\.data\/runtime$/);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '200' }).codexMaxConcurrentTurns, 40);
  assert.equal(loadConfig({ PORTAL_MAX_ACTIVE_ROOT_TURNS: '99' }).portalMaxActiveRootTurns, 11);
  assert.equal(loadConfig({ PORTAL_MAX_EXECUTE_LEASES: '9' }).portalMaxExecuteLeases, 9);
  assert.equal(loadConfig({ PORTAL_MAX_ACTIVE_ROOT_TURNS: '4', PORTAL_MAX_EXECUTE_LEASES: '9' }).portalMaxExecuteLeases, 4);
  assert.equal(loadConfig({ DEFAULT_MAX_PROJECTS: '999' }).defaultMaxProjects, 100);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '12', DEFAULT_MAX_CONCURRENT_TURNS: '30' }).defaultMaxConcurrentTurns, 12);
});

test('ordinary Codex upstream is fixed to the local ChatGPT official login', () => {
  assert.throws(() => loadConfig({ CHATGPT_CODEX_BASE_URL: 'https://example.invalid/codex' }), { code: 'CODEX_BASE_URL_NOT_ALLOWED' });
  assert.throws(() => loadConfig({ CODEX_MODEL_PROVIDER: 'third_party' }), { code: 'CODEX_PROVIDER_NOT_ALLOWED' });
});
