import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.mjs';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { UserMemoryService } from '../src/user-memory-service.mjs';
import { AgentRuntimeService } from '../src/agent-runtime-service.mjs';
import { localModelUrl } from '../src/private-projects.mjs';

export function fixture(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-local-test-'));
  const config = loadConfig({ DATA_DIR: root, LOCAL_QWEN_ENABLED: 'true', LOCAL_QWEN_TIMEOUT_MS: '15000', ...env });
  const db = new HarnessDatabase(config), workspace = new WorkspaceService(config);
  const memory = new UserMemoryService({ config, db });
  memory.index.search = async () => ({ results: [] }); memory.index.index = async () => ({});
  const service = new AgentRuntimeService({ config, db, workspace, memory });
  const user = db.createUser({ username: 'localboss', displayName: 'Boss', role: 'admin', passwordHash: 'synthetic',
    networkAccess: true, maxProjects: 10, maxStorageBytes: 1e8, maxConcurrentTurns: 4 });
  workspace.ensureUserRoot(user.id);
  const project = db.createProject({ userId: user.id, name: 'Private', slug: 'private', projectType: 'local_private' });
  workspace.createProject(project);
  const chat = db.createChat({ userId: user.id, projectId: project.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'Local' });
  t.after(async () => { await service.interruptUserAndWait(user.id); service.stop(); memory.stop(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, db, workspace, memory, service, user, project, chat, root };
}

async function model(t, reply) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-qwen' }] })); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const choice = await reply(body, requests.length);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const packet = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 1, model: 'test-qwen', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    packet({ role: 'assistant', ...choice.delta }); packet({}, choice.finish || 'stop');
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 25 } } })}\n\n`); res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, env: { LOCAL_QWEN_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, LOCAL_QWEN_MODEL: 'test-qwen' } };
}

async function until(check) { for (let n = 0; n < 500; n++) { if (check()) return; await delay(20); } throw new Error('local test condition timed out'); }
const toolReply = (name, args) => ({ delta: { tool_calls: [{ index: 0, id: 'call-one', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish: 'tool_calls' });

test('private migration, ownership and immutable engine boundaries', (t) => {
  const { db, user, project, chat, config } = fixture(t);
  assert.equal(chat.controlMode, 'manual'); assert.equal(project.projectType, 'local_private');
  assert.throws(() => db.db.prepare("UPDATE projects SET project_type='standard' WHERE id=?").run(project.id), /PROJECT_TYPE_IMMUTABLE/);
  assert.throws(() => db.updateChat(chat.id, { codexThreadId: 'cloud-thread' }), /PRIVATE_PROJECT_NO_CODEX/);
  const employee = db.createUser({ ...user, id: undefined, username: 'employee', role: 'user', passwordHash: 'test' });
  assert.throws(() => db.createProject({ userId: employee.id, name: 'Denied', slug: 'denied', projectType: 'local_private' }), /PRIVATE_PROJECT_OWNER_REQUIRED/);
  assert.throws(() => db.grantProjectAccess({ projectId: project.id, userId: employee.id }), /隐私项目/);
  assert.equal(db.getProjectForUser(project.id, employee.id), null);
  const reopened = new HarnessDatabase(config); reopened.close();
  assert.throws(() => localModelUrl('https://api.qwen.com/v1'), /回环/);
  assert.throws(() => localModelUrl('http://localhost:8000/v1'), /回环/);
});

test('project memory crosses local chats only, never private projects or normal user memory', async (t) => {
  const { db, memory, user, project, chat } = fixture(t);
  const normal = db.createProject({ userId: user.id, name: 'Normal', slug: 'normal' });
  const other = db.createProject({ userId: user.id, name: 'Other', slug: 'other', projectType: 'local_private' });
  const saved = memory.create({ userId: user.id, body: 'Only private fact', scopeProjectId: project.id });
  memory.create({ userId: user.id, body: 'Normal fact' });
  assert.deepEqual(memory.list(user.id).map(m => m.body), ['Normal fact']);
  const recall = async p => {
    const c = db.createChat({ projectId: p.id, userId: user.id, projectAccessId: p.accessId, treePath: p.treePath, title: 'Memory' });
    const run = db.createTurnRun({ chat: c, project: p, userId: user.id, mode: 'edit' });
    db.updateTurnRun(run.id, { status: 'completed' });
    return memory.recall({ userId: user.id, chat: c, projectId: p.id, turnRunId: run.id, query: '' });
  };
  assert.deepEqual((await recall(project)).map(m => m.id), [saved.id]);
  assert.equal((await recall(other)).length, 0);
  assert.deepEqual((await recall(normal)).map(m => m.body), ['Normal fact']);
  assert.throws(() => memory.delete({ id: saved.id, userId: user.id, version: 1 }), /不存在/);
  assert.equal(db.getChat(chat.id).codexThreadId, null);
});

test('real sandboxed DSH core streams, calls Portal tools, persists and resumes with Codex offline', { timeout: 45000 }, async (t) => {
  const mock = await model(t, (_body, n) => n === 1
    ? { delta: { tool_calls: [{ index: 0, id: 'write-one', type: 'function', function: { name: 'workspace_write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'synthetic local result' }) } }] }, finish: 'tool_calls' }
    : { delta: { content: 'Synthetic local completed' } });
  const { service, db, workspace, project, user, chat } = fixture(t, mock.env);
  let approvalCount = 0;
  service.on('turnEvent', event => {
    if (event.eventType !== 'approval_required') return;
    approvalCount++;
    const approval = service.pendingApprovalsForChat(chat.id, user.id)[0];
    assert.equal(fs.existsSync(path.join(workspace.projectRoot(project), 'result.txt')), false);
    service.resolveApproval({ chatId: chat.id, userId: user.id, approvalId: approval.id, decision: 'accept' });
  });
  await service.runTurn({ chat, project, user, prompt: 'Create a synthetic test file', mode: 'edit' });
  assert.equal(approvalCount, 1);
  assert.equal(workspace.readFile(project, 'result.txt').content, 'synthetic local result');
  assert.equal(service.standard.client.started, false);
  const saved = db.getChat(chat.id); assert.ok(saved.localSessionId); assert.equal(saved.codexThreadId, null);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'completed');
  await service.runTurn({ chat: saved, project, user, prompt: 'Continue the same local conversation', mode: 'edit' });
  assert.equal(db.getChat(chat.id).localSessionId, saved.localSessionId);
  assert.match(JSON.stringify(mock.requests.at(-1).messages), /Create a synthetic test file/);
  const usage = db.tokenUsage.dashboard().totals.qwen;
  assert.equal(usage.calls, mock.requests.length);
  assert.equal(usage.totalTokens, mock.requests.length * 120);
  assert.equal(usage.cachedInputTokens, mock.requests.length * 25);
  assert.equal(usage.incompleteCalls, 0);
  assert.equal(service.capacity.status().activeRootTurns, 0);
});

test('manual approval stop cancels the operation before releasing the local serial slot', { timeout: 45000 }, async t => {
  const mock = await model(t, (_body, n) => n === 1 ? toolReply('workspace_write_file', { path: 'never.txt', content: 'synthetic' }) : { delta: { content: 'Second local chat completed' } });
  const { service, db, workspace, project, user, chat } = fixture(t, mock.env);
  const first = service.runTurn({ chat, project, user, prompt: 'Synthetic file request', mode: 'edit' }); void first.catch(() => {});
  await until(() => service.pendingApprovalsForChat(chat.id, user.id).length);
  const approval = service.pendingApprovalsForChat(chat.id, user.id)[0];
  const secondChat = db.createChat({ userId: user.id, projectId: project.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'second' });
  const second = service.runTurn({ chat: secondChat, project, user, prompt: 'Second request', mode: 'edit' }); void second.catch(() => {});
  await delay(50); assert.equal(mock.requests.length, 1); assert.equal(service.local.globalPending, 1);
  await service.interruptAndWait(chat.id);
  await assert.rejects(first, error => error.code === 'TURN_INTERRUPTED');
  assert.equal(db.getApproval(approval.id).status, 'cancelled');
  assert.equal(fs.existsSync(path.join(workspace.projectRoot(project), 'never.txt')), false);
  assert.throws(() => service.resolveApproval({ chatId: chat.id, userId: user.id, approvalId: approval.id, decision: 'accept' }), /失效/);
  await second; assert.equal(db.getLatestTurnRunForChat(secondChat.id).status, 'completed');
  assert.equal(service.capacity.status().activeRootTurns, 0);
});

test('search sends only the edited approved query and never private history, files or memory', { timeout: 30000 }, async t => {
  const mock = await model(t, (_body, n) => n === 1 ? toolReply('web_search', { query: 'sensitive original query' }) : { delta: { content: 'Public findings read locally' } });
  const { service, db, project, user, chat } = fixture(t, mock.env);
  const calls = []; service.local.search.search = async (...args) => { calls.push(args); return { text: 'Public result' }; };
  const run = service.runTurn({ chat, project, user, prompt: 'Synthetic private context', mode: 'edit' }); void run.catch(() => {});
  await until(() => service.pendingApprovalsForChat(chat.id, user.id).length);
  assert.equal(calls.length, 0);
  const row = service.pendingApprovalsForChat(chat.id, user.id)[0]; assert.equal(row.kind, 'web_search');
  service.resolveApproval({ chatId: chat.id, userId: user.id, approvalId: row.id, decision: 'accept', query: 'public generic query' });
  await run;
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'public generic query'); assert.equal(calls[0].length, 3);
  assert.equal(calls[0][2].user.id, user.id); assert.equal(calls[0][2].ledger, db.tokenUsage);
  assert.equal(calls[0][2].projectId, project.id);
  assert.ok(calls[0][1] instanceof AbortSignal);
  assert.equal(db.getApproval(row.id).request.query, 'public generic query');
  assert.doesNotMatch(JSON.stringify(db.listTurnEvents(chat.id)), /sensitive original|public generic|Synthetic private/);
});

test('auto still denies commands in EDIT; EXECUTE uses a network-denied local sandbox', { timeout: 30000 }, async t => {
  const mock = await model(t, (_body, n) => n % 2 ? toolReply('workspace_exec', { command: 'echo synthetic' }) : { delta: { content: 'Tool result received' } });
  const { service, db, project, user, chat } = fixture(t, mock.env);
  const automatic = db.updateChat(chat.id, { controlMode: 'auto' });
  await service.runTurn({ chat: automatic, project, user, prompt: 'EDIT command denied', mode: 'edit' });
  assert.match(JSON.stringify(mock.requests[1].messages), /EXECUTE_MODE_REQUIRED/);
  await service.runTurn({ chat: db.getChat(chat.id), project, user, prompt: 'EXECUTE command allowed', mode: 'execute' });
  assert.match(JSON.stringify(mock.requests[3].messages), /synthetic/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM turn_approvals WHERE status='pending'").get().n, 0);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM turn_approvals WHERE status='accepted' AND kind='command'").get().n, 1);
});

test('private EXECUTE cannot reach another loopback service even with user network permission', { timeout: 30000 }, async t => {
  let reached = false;
  const sink = http.createServer((_req, res) => { reached = true; res.end('not allowed'); });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { sink.closeAllConnections(); sink.close(resolve); }));
  const command = `/usr/bin/curl --silent --show-error --max-time 2 http://127.0.0.1:${sink.address().port}/`;
  const mock = await model(t, (_body, n) => n === 1 ? toolReply('workspace_exec', { command }) : { delta: { content: 'Network tool refused' } });
  const { service, db, project, user, chat } = fixture(t, mock.env);
  assert.equal(user.networkAccess, true);
  await service.runTurn({ chat: db.updateChat(chat.id, { controlMode: 'auto' }), project, user, prompt: 'Synthetic network denial test', mode: 'execute' });
  assert.equal(reached, false);
  const tool = mock.requests[1].messages.find(message => message.role === 'tool');
  assert.match(tool.content, /"ok":false/);
});

test('stale file approval refuses overwrite and local steer arrives at the next step', { timeout: 30000 }, async t => {
  const mock = await model(t, (_body, n) => n === 1 ? toolReply('workspace_write_file', { path: 'version.txt', content: 'proposed synthetic revision' }) : { delta: { content: 'Direction updated' } });
  const { service, db, workspace, project, user, chat } = fixture(t, mock.env);
  const target = path.join(workspace.projectRoot(project), 'version.txt');
  fs.writeFileSync(target, 'original synthetic revision');
  const run = service.runTurn({ chat, project, user, prompt: 'Synthetic approved edit', mode: 'edit' }); void run.catch(() => {});
  await until(() => service.pendingApprovalsForChat(chat.id, user.id).length);
  const active = service.local.activeByChat.get(chat.id);
  const steer = await service.local.steerInput(active, { id: 'synthetic-steer', prompt: 'Synthetic correction: preserve the newest file.' });
  assert.ok(steer.turnId);
  fs.writeFileSync(target, 'newer synthetic revision');
  const row = service.pendingApprovalsForChat(chat.id, user.id)[0];
  service.resolveApproval({ chatId: chat.id, userId: user.id, approvalId: row.id, decision: 'accept' });
  await run;
  assert.equal(fs.readFileSync(target, 'utf8'), 'newer synthetic revision');
  assert.match(JSON.stringify(mock.requests.at(-1).messages), /FILE_VERSION_CONFLICT/);
  assert.match(JSON.stringify(mock.requests.at(-1).messages), /Synthetic correction/);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'completed');
});

test('failed local session resume retains mapping; explicit reset persists engine lineage', { timeout: 30000 }, async t => {
  const mock = await model(t, () => ({ delta: { content: 'local saved' } }));
  const { service, db, config, project, user, chat } = fixture(t, mock.env);
  await service.runTurn({ chat, project, user, prompt: 'saved', mode: 'edit' });
  const old = db.getChat(chat.id);
  const store = path.join(config.localSessionsRoot, user.id, project.id, chat.id, 'events');
  fs.renameSync(store, `${store}-unavailable`);
  await assert.rejects(service.runTurn({ chat: old, project, user, prompt: 'must not silently reset', mode: 'edit' }), error => error.code === 'LOCAL_RESUME_FAILED');
  assert.equal(db.getChat(chat.id).localSessionId, old.localSessionId);
  assert.equal(db.getChat(chat.id).threadState, 'resume_failed');
  await assert.rejects(service.recoverChatThread({ chat: db.getChat(chat.id), project, user, action: 'reset' }), /明确确认/);
  const reset = await service.recoverChatThread({ chat: db.getChat(chat.id), project, user, action: 'reset', acknowledgeHistoryBreak: true });
  assert.notEqual(reset.localSessionId, old.localSessionId);
  assert.equal(db.listChatThreadRecoveries(chat.id)[0].engine, 'qwen');
  await service.runTurn({ chat: reset, project, user, prompt: 'fresh session', mode: 'edit' });
  assert.doesNotMatch(JSON.stringify(mock.requests.at(-1).messages), /must not silently reset/);
});
