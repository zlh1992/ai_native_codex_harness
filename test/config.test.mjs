import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('concurrency defaults to 40 and is hard-capped at 40', () => {
  const config = loadConfig({});
  assert.equal(config.codexMaxConcurrentTurns, 40);
  assert.equal(config.defaultMaxProjects, 100);
  assert.match(config.treesRoot, /\.data\/trees$/);
  assert.match(config.runtimeRoot, /\.data\/runtime$/);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '200' }).codexMaxConcurrentTurns, 40);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '12', DEFAULT_MAX_CONCURRENT_TURNS: '30' }).defaultMaxConcurrentTurns, 12);
});
