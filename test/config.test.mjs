import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('concurrency defaults to 40 and is hard-capped at 40', () => {
  assert.equal(loadConfig({}).codexMaxConcurrentTurns, 40);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '200' }).codexMaxConcurrentTurns, 40);
  assert.equal(loadConfig({ CODEX_MAX_CONCURRENT_TURNS: '12', DEFAULT_MAX_CONCURRENT_TURNS: '30' }).defaultMaxConcurrentTurns, 12);
});
