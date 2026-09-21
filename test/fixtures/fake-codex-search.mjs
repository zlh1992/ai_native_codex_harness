#!/usr/bin/env node
// Synthetic search-only upstream; assertions are part of the local release tests.
import readline from 'node:readline';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
assert.equal(process.env.CODEX_HOME, process.cwd());
assert.equal(process.env.PORTAL_TEST_SECRET, undefined);
assert.match(process.cwd(), /portal-search-/);
const summary = process.argv.includes('web_search="disabled"');
assert.ok(summary || process.argv.includes('web_search="live"'));
if (summary) assert.ok(process.argv.some((v, i) => v === '--disable' && process.argv[i + 1] === 'web_search'));
assert.ok(process.argv.includes('agents.enabled=false'));
assert.ok(process.argv.includes('memories.use_memories=false'));
assert.equal(fs.existsSync(path.join(process.cwd(), 'config.toml')), false);
const send = packet => process.stdout.write(`${JSON.stringify(packet)}\n`);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { method, id, params } = JSON.parse(line);
  if (method === 'initialize') send({ id, result: { userAgent: 'codex/0.150.0-alpha.8 test' } });
  if (method === 'config/read') send({ id, result: { config: { features: { memories: false }, memories: { generate_memories: false, use_memories: false }, web_search: summary ? 'disabled' : 'live' } } });
  if (method === 'thread/start') {
    assert.equal(params.ephemeral, true); assert.equal(params.model, 'gpt-5.6-luna'); assert.deepEqual(params.dynamicTools, []);
    assert.equal(params.config.web_search, summary ? 'disabled' : 'live'); assert.equal(params.cwd, process.cwd());
    send({ id, result: { thread: { id: `search-test-${process.pid}` } } });
  }
  if (method === 'turn/start') {
    assert.equal(params.model, 'gpt-5.6-luna'); assert.equal(params.effort, 'low');
    assert.deepEqual(params.input, [{ type: 'text', text: summary ? '[{"index":0,"name":"workspace_exec","output":"synthetic"}]' : 'public test query', text_elements: [] }]);
    send({ id, result: { turn: { id: `search-turn-${process.pid}` } } });
    send({ method: 'thread/tokenUsage/updated', params: { threadId: `search-test-${process.pid}`, turnId: `search-turn-${process.pid}`, tokenUsage: { total: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, last: { inputTokens: 50, outputTokens: 10, totalTokens: 60 } } } });
    if (!summary) send({ method: 'item/completed', params: { threadId: `search-test-${process.pid}`, item: { type: 'webSearch', id: 'web-one' } } });
    send({ method: 'item/completed', params: { threadId: `search-test-${process.pid}`, item: { type: 'agentMessage', text: summary ? '[{"index":0,"summary":"测试命令完成"}]' : 'Synthetic public source https://example.com/' } } });
    send({ method: 'turn/completed', params: { threadId: `search-test-${process.pid}`, turn: { id: `search-turn-${process.pid}`, status: 'completed' } } });
  }
});
