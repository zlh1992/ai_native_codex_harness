import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { loadConfig } from '../src/config.mjs';
import { HarnessDatabase } from '../src/db.mjs';
import { ToolDetailsService, redactToolText } from '../src/tool-details.mjs';
import { ToolDetailsPanel, toolDetailHtml } from '../public/tool-details.js';

function fixture(t, projectType = 'standard', summarize = async () => { throw new Error('synthetic offline'); }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-tool-test-'));
  const config = loadConfig({ DATA_DIR: root });
  const db = new HarnessDatabase(config);
  const user = db.createUser({ username: 'toolboss', displayName: 'Boss', role: 'admin', passwordHash: 'synthetic', maxProjects: 10, maxStorageBytes: 1e8, maxConcurrentTurns: 4 });
  const project = db.createProject({ userId: user.id, name: 'Tools', slug: 'tools', projectType });
  const chat = db.createChat({ userId: user.id, projectId: project.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'Tools' });
  const run = db.createTurnRun({ chat, project, userId: user.id, mode: 'execute' });
  const service = new ToolDetailsService({ db, config, summarize });
  t.after(() => { service.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const capture = (event, data) => service.capture(run.id, chat.id, event, data);
  return { service, capture, db, config, run, chat, user, project };
}

test('tool snapshots retain input/output, nonzero exits fail, duplicate completion and journal separation', t => {
  const f = fixture(t);
  f.capture('tool_started', { callId: 'a', name: 'workspace_exec', arguments: { command: 'echo synthetic', cwd: '.' } });
  assert.equal(f.service.list(f.chat.id, f.run.id).items[0].status, 'running');
  f.capture('tool_completed', { callId: 'a', name: 'workspace_exec', result: { exitCode: 7, output: 'synthetic error' } });
  f.capture('tool_completed', { callId: 'a', result: { exitCode: 0 } });
  const item = f.service.list(f.chat.id, f.run.id).items[0];
  assert.equal(item.status, 'failed'); assert.equal(item.exitCode, 7); assert.match(item.input, /echo synthetic/); assert.match(item.output, /synthetic error/);
  assert.deepEqual(f.db.listTurnEvents(f.chat.id), []);
  assert.equal(f.service.list('other', f.run.id).items.length, 0);
  f.capture('tool_completed', { callId: 'signal', name: 'workspace_exec', result: { exitCode: null, signal: 'SIGTERM' } });
  assert.equal(f.service.list(f.chat.id, f.run.id).items.find(i => i.callId === 'signal').status, 'failed');
});

test('async summary batches same run and does not block capture; fallback survives failure', async t => {
  let resolve, seen;
  const f = fixture(t, 'standard', text => { seen = JSON.parse(text); return new Promise(r => { resolve = r; }); });
  for (let i = 0; i < 2; i++) {
    f.capture('tool_started', { callId: String(i), name: 'workspace_exec', arguments: { command: 'echo ok' } });
    f.capture('tool_completed', { callId: String(i), result: { exitCode: 0, output: 'ok' } });
  }
  clearTimeout(f.service.timer); f.service.timer = null;
  const pending = f.service.flush();
  assert.equal(seen.length, 2);
  f.capture('tool_started', { callId: 'next', name: 'workspace_list', arguments: {} });
  assert.equal(f.service.list(f.chat.id, f.run.id).items.length, 3);
  resolve({ text: '[{"index":0,"summary":"打印测试标记，执行成功"}]' }); await pending;
  const items = f.service.list(f.chat.id, f.run.id).items;
  assert.equal(items.find(i => i.callId === '0').summaryStatus, 'ready');
  assert.equal(items.find(i => i.callId === '1').summaryStatus, 'unavailable');
});

test('private project details never call cloud; memory payload and obvious secrets are excluded', async t => {
  let calls = 0;
  const f = fixture(t, 'local_private', async () => { calls++; });
  f.capture('tool_started', { callId: 'a', name: 'workspace_exec', arguments: { command: 'echo local', token: 'synthetic-private-token' } });
  f.capture('tool_completed', { callId: 'a', result: { output: 'local result', exitCode: 0 } });
  f.capture('tool_started', { callId: 'm', name: 'memory_search', arguments: { query: 'synthetic memory' } });
  f.capture('tool_completed', { callId: 'm', name: 'memory_search', result: { body: 'synthetic memory' } });
  await f.service.flush();
  const items = f.service.list(f.chat.id, f.run.id).items;
  assert.equal(calls, 0); assert.equal(f.service.queue.length, 0);
  assert.equal(items[0].summaryStatus, 'disabled'); assert.match(items[0].output, /local result/);
  assert.ok(!JSON.stringify(items).includes('synthetic-private-token'));
  assert.ok(!JSON.stringify(items).includes('synthetic memory'));
  assert.ok(!redactToolText('Authorization: Bearer synthetic-secret').includes('synthetic-secret'));
});

test('summary revoked during await is not stored; restart marks unknown tool interrupted', async t => {
  let resolve;
  const f = fixture(t, 'standard', () => new Promise(r => { resolve = r; }));
  f.capture('tool_completed', { callId: 'a', name: 'workspace_list', result: [] });
  clearTimeout(f.service.timer); f.service.timer = null;
  const pending = f.service.flush();
  f.db.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(f.user.id);
  resolve({ text: '[{"index":0,"summary":"must not persist"}]' }); await pending;
  assert.equal(f.service.list(f.chat.id, f.run.id).items[0].summary, '');
  f.db.db.prepare("UPDATE users SET status='active' WHERE id=?").run(f.user.id);
  f.capture('tool_started', { callId: 'b', name: 'workspace_exec', arguments: { command: 'echo pending' } });
  f.service.stop(); const reopened = new ToolDetailsService({ db: f.db, config: f.config });
  assert.equal(reopened.list(f.chat.id, f.run.id).items.find(i => i.callId === 'b').status, 'interrupted'); reopened.stop();
});

test('details UI escapes content, keeps expanded state, recovers revisions and discards stale chat responses', async () => {
  const { document } = parseHTML('<html><body><section></section></body></html>');
  const root = document.querySelector('section'); let ctx = { chatId: 'a', epoch: 1 };
  const item = { id: 1, name: 'workspace_exec', status: 'failed', exitCode: 2, startedAt: 0, endedAt: 1000, input: '<script>bad</script>', output: 'err', summaryStatus: 'unavailable' };
  assert.ok(!toolDetailHtml(item).includes('<script>')); assert.match(toolDetailHtml(item), /失败/);
  const panel = new ToolDetailsPanel({ root, context: () => ctx, api: async () => ({ runId: 'r', items: [item], cursor: 1, hasMore: false }) });
  await panel.refresh(); assert.equal(root.hidden, false); root.querySelector('details').setAttribute('open', '');
  await panel.refresh(); assert.equal(root.querySelector('details').hasAttribute('open'), true);
  let resolve; panel.api = () => new Promise(r => { resolve = r; });
  const pending = panel.refresh(); ctx = { chatId: 'b', epoch: 2 }; panel.reset('b');
  resolve({ runId: 'r', items: [item], cursor: 2 }); await pending;
  assert.equal(root.innerHTML, ''); assert.equal(root.hidden, true);
});
