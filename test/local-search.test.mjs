import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TokenUsageLedger } from '../src/token-usage.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { CodexSearchService } from '../src/codex-search-service.mjs';

test('dedicated search launches isolated Luna-low with only one query and no inherited configuration', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-search-auth-test-'));
  fs.writeFileSync(path.join(root, 'auth.json'), '{"synthetic":true}', { mode: 0o600 });
  const previous = process.env.CODEX_HOME;
  const oldSecret = process.env.PORTAL_TEST_SECRET;
  process.env.CODEX_HOME = root; process.env.PORTAL_TEST_SECRET = 'synthetic-must-not-pass';
  const service = new CodexSearchService(loadConfig({ CODEX_BIN: path.resolve('test/fixtures/fake-codex-search.mjs'), LOCAL_SEARCH_TIMEOUT_MS: '10000' }));
  const sql = new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE users(id TEXT,role TEXT,display_name TEXT,username TEXT)");
  const ledger = new TokenUsageLedger(sql);
  const metering = { ledger, user: { id: 'boss', role: 'admin' }, runId: 'parent' };
  try {
    const result = await service.search('public test query', undefined, metering);
    assert.match(result.text, /https:\/\/example.com/); assert.equal(result.model, 'gpt-5.6-luna'); assert.equal(result.effort, 'low');
    assert.equal(service.clients.size, 0);
    const summary = await service.summarize('[{"index":0,"name":"workspace_exec","output":"synthetic"}]', undefined, metering);
    assert.equal(JSON.parse(summary.text)[0].summary, '测试命令完成');
    assert.equal(summary.model, 'gpt-5.6-luna'); assert.equal(summary.effort, 'low');
    assert.equal(service.clients.size, 0);
  assert.equal(ledger.dashboard().totals.bossGpt.totalTokens, 120);
    assert.equal(ledger.dashboard().totals.bossGpt.incompleteCalls, 0);
    assert.deepEqual(ledger.dashboard().kinds.map(k=>k.kind).sort(), ['search','summary']);
  } finally {
    sql.close();
    service.stop(); if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous;
    if (oldSecret === undefined) delete process.env.PORTAL_TEST_SECRET; else process.env.PORTAL_TEST_SECRET = oldSecret;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
