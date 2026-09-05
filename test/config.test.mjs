import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('concurrency defaults to 40 and is hard-capped at 40', () => {
  const config = loadConfig({});
  assert.equal(config.codexMaxConcurrentTurns, 40);
  assert.equal(config.portalMaxActiveRootTurns, 11);
  assert.equal(config.portalMaxExecuteLeases, 2);
  assert.equal(config.maxSubagentsPerRoot, 3);
  assert.equal(config.subagentModel, 'gpt-5.6-luna');
  assert.equal(config.codexCliVersion, '0.150.0-alpha.8');
  assert.match(config.portalAgentConfig, /portal-agents\/luna\.toml$/);
  assert.equal(config.defaultMaxProjects, 100);
  assert.match(config.treesRoot, /\.data\/trees$/);
  assert.match(config.runtimeRoot, /\.data\/runtime$/);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '200' }).codexMaxConcurrentTurns, 40);
  assert.equal(loadConfig({ PORTAL_MAX_ACTIVE_ROOT_TURNS: '99' }).portalMaxActiveRootTurns, 11);
  assert.equal(loadConfig({ PORTAL_MAX_EXECUTE_LEASES: '9' }).portalMaxExecuteLeases, 2);
  assert.equal(loadConfig({ DEFAULT_MAX_PROJECTS: '999' }).defaultMaxProjects, 100);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '12', DEFAULT_MAX_CONCURRENT_TURNS: '30' }).defaultMaxConcurrentTurns, 12);
});
