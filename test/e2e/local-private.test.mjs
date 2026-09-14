import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

test('private project HTTP ACL, scoped memory, manual approval and queue work with Codex unavailable', { timeout: 45000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-private-http-'));
  let calls = 0;
  const model = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'synthetic-local' }] })); return; }
    for await (const _chunk of req) { /* consume synthetic request */ }
    const first = ++calls === 1;
    const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'create-file', type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'Private HTTP synthetic output' }) } }] }
      : { role: 'assistant', content: 'Local HTTP completed' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [d, reason] of [[delta, null], [{}, first ? 'tool_calls' : 'stop']]) res.write(`data: ${JSON.stringify({ id: 'http-local', object: 'chat.completion.chunk', created: 1, model: 'synthetic-local', choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: process.cwd(), env: { ...process.env,
    HOST: '127.0.0.1', PORT: String(port), DATA_DIR: root, DATABASE_PATH: path.join(root, 'db.sqlite'), WORKSPACES_ROOT: path.join(root, 'workspaces'),
    TREES_ROOT: path.join(root, 'trees'), RUNTIME_ROOT: path.join(root, 'runtime'), TRASH_ROOT: path.join(root, 'trash'),
    MEMORY_INDEX_ROOT: path.join(root, 'index'), MEMORY_PYTHON: path.join(root, 'missing-python'),
    PUBLIC_ORIGIN: '', PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '', TRUST_PROXY: 'false', COOKIE_SECURE: 'false', TRUST_PROXY_PROVIDER: 'generic',
    ADMIN_USERNAME: 'privateboss', ADMIN_PASSWORD: 'SyntheticBossPassword123!', CODEX_BIN: '/usr/bin/false',
    LOCAL_DEEPSEEK_ENABLED: 'true', LOCAL_DEEPSEEK_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LOCAL_DEEPSEEK_MODEL: 'synthetic-local',
    LOCAL_DEEPSEEK_TIMEOUT_MS: '20000', WORK_GRAPH_ENABLED: 'true', WORK_GRAPH_DISPATCH_ENABLED: 'false',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'close'); }
    model.closeAllConnections(); await new Promise(r => model.close(r)); fs.rmSync(root, { recursive: true, force: true });
  });
  const request = async (session, url, body, expected = 200, method = body === undefined ? 'GET' : 'POST') => {
    const res = await fetch(origin + url, { method, headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(res.status, expected, `${method} ${url}: ${await res.clone().text()}`); return res;
  };
  const json = async (...args) => (await request(...args)).json();
  const until = async check => { for (let n = 0; n < 500; n++) { if (await check()) return; await delay(20); } throw new Error(`Private HTTP timeout ${logs}`); };
  await until(async () => { try { const h = await (await fetch(origin + '/api/health')).json(); return h.localDeepSeek?.state === 'ready'; } catch { return false; } });
  const health = await json(null, '/api/health'); assert.equal(health.codex, false); assert.equal(health.localDeepSeek.state, 'ready');
  const login = async (username, password, role) => {
    const response = await request(null, `/api/${role}/login`, { username, password });
    const session = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: '' };
    session.csrf = (await json(session, '/api/me')).csrfToken; return session;
  };
  const boss = await login('privateboss', 'SyntheticBossPassword123!', 'boss');
  const { user: employee } = await json(boss, '/api/admin/users', { username: 'privateemployee', displayName: 'Employee', password: 'SyntheticEmployee123!' }, 201);
  const worker = await login('privateemployee', 'SyntheticEmployee123!', 'employee');
  await json(worker, '/api/projects', { name: 'denied', projectType: 'local_private' }, 403);
  const { project } = await json(boss, '/api/projects', { name: 'Local private test', projectType: 'local_private' }, 201);
  assert.equal(project.projectType, 'local_private');
  await json(boss, `/api/projects/${project.id}`, { projectType: 'standard' }, 409, 'PATCH');
  await json(boss, `/api/admin/projects/${project.id}/shares`, { userId: employee.id, scope: 'files_only' }, 403);
  await json(boss, `/api/projects/${project.id}/work-graphs/generate`, { prompt: 'Denied private graph' }, 403);
  await json(worker, `/api/projects/${project.id}`, undefined, 403);
  await json(worker, `/api/projects/${project.id}/memories`, undefined, 403);
  const scoped = `/api/projects/${project.id}/memories`;
  const { memory } = await json(boss, scoped, { body: 'Private only HTTP fact' }, 201);
  assert.equal((await json(boss, '/api/memories')).memories.length, 0);
  await json(boss, `/api/memories/${memory.id}`, { body: 'must not cross scopes', version: 1 }, 404, 'PATCH');
  assert.equal((await json(boss, scoped)).memories[0].id, memory.id);
  const { chat } = await json(boss, `/api/projects/${project.id}/chats`, { title: 'Private chat' }, 201);
  assert.equal(chat.controlMode, 'manual'); assert.equal(chat.localSessionId, undefined);
  await json(boss, `/api/chats/${chat.id}`, { preferredModel: 'gpt-5.6-luna' }, 403, 'PATCH');
  await json(boss, `/api/chats/${chat.id}/queue`, { id: randomUUID(), prompt: 'Create a synthetic local file', mode: 'edit' });
  let approval;
  await until(async () => {
    approval = (await json(boss, `/api/chats/${chat.id}/approvals`)).approvals[0];
    if (!approval) {
      const state = await json(boss, `/api/chats/${chat.id}/queue`);
      assert.notEqual(state.inputs[0]?.status, 'paused', `Local input unexpectedly paused: ${JSON.stringify(state)}`);
      assert.notEqual(state.latestTurnRun?.status, 'failed', `Local run failed: ${JSON.stringify(await json(boss, `/api/chats/${chat.id}`))}`);
    }
    return approval;
  });
  assert.equal(approval.kind, 'file');
  await json(boss, `/api/chats/${chat.id}`, { controlMode: 'auto' }, 409, 'PATCH');
  await json(worker, `/api/chats/${chat.id}/approvals`, undefined, 403);
  await json(boss, `/api/chats/${chat.id}/approvals/${encodeURIComponent(approval.id)}`, { decision: 'accept' });
  let history;
  await until(async () => { history = await json(boss, `/api/chats/${chat.id}`); return history.latestTurnRun?.status === 'completed'; });
  assert.match(history.messages.find(m => m.role === 'assistant').content, /Local HTTP completed/);
  assert.equal(history.chat.codexThreadId, null); assert.equal(history.chat.localSessionId, undefined);
  const details = await json(boss, `/api/chats/${chat.id}/tool-calls`);
  assert.equal(details.items[0].name, 'workspace_write_file');
  assert.match(details.items[0].input, /Private HTTP synthetic output/);
  assert.equal(details.items[0].summaryStatus, 'disabled');
  assert.equal(details.items[0].status, 'completed');
  await json(worker, `/api/chats/${chat.id}/tool-calls`, undefined, 403);
  const { chat: otherChat } = await json(boss, `/api/projects/${project.id}/chats`, { title: 'Other local' }, 201);
  await json(boss, `/api/chats/${otherChat.id}/tool-calls?runId=${details.runId}`, undefined, 403);
  const file = await json(boss, `/api/projects/${project.id}/file?path=hello.txt`); assert.match(file.content, /Private HTTP synthetic output/);
  await json(boss, `/api/chats/${chat.id}`, { controlMode: 'auto' }, 200, 'PATCH');
  assert.equal(calls, 2);
  assert.doesNotMatch(logs, /Private HTTP synthetic output|Private only HTTP fact|Create a synthetic local file/);
});
