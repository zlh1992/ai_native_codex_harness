import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';
import { loadConfig } from '../src/config.mjs';
import { UserMemoryService } from '../src/user-memory-service.mjs';
import { callMemoryTool, MEMORY_TOOLS } from '../src/memory-tools.mjs';

function addUser(db, username, role = 'user') {
  return db.createUser({ username, displayName: username, passwordHash: 'test', role, networkAccess: false,
    maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 40 });
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-memory-'));
  const config = loadConfig({ DATA_DIR: base, DATABASE_PATH: path.join(base, 'db.sqlite'),
    WORKSPACES_ROOT: path.join(base, 'workspaces'), MEMORY_PYTHON: path.join(base, 'missing-python') });
  const db = new HarnessDatabase(config);
  const memory = new UserMemoryService({ config, db });
  memory.index.search = async () => { throw Object.assign(new Error('index unavailable'), { code: 'TEST_INDEX_DOWN' }); };
  memory.index.index = async () => ({ indexed: true });
  t.after(() => { memory.stop(); db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, config, db, memory };
}

function addChat(db, project, user, title) {
  return db.createChat({ projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title });
}

function addCompletedRun(db, chat, project, user, prompt = 'ordinary request') {
  const run = db.createTurnRun({ chat, project, userId: user.id, mode: 'edit' });
  db.addMessage({ id: `user:${run.id}`, chatId: chat.id, turnId: run.id, role: 'user', content: prompt });
  db.updateTurnRun(run.id, { status: 'completed', completedAt: new Date().toISOString() });
  return run;
}

test('memory recall is per-user, crosses only currently authorized projects, and fails closed after revoke', async (t) => {
  const { base, db, memory } = fixture(t);
  const boss = addUser(db, 'boss', 'admin');
  const employee = addUser(db, 'employee');
  const intruder = addUser(db, 'intruder');
  const sourceOwned = db.createProject({ userId: boss.id, slug: 'source', name: 'Source' });
  const sourceAccess = db.grantProjectAccess({ id: randomUUID(), projectId: sourceOwned.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'source'), branchName: 'portal/share/source' });
  const source = db.getProjectForUser(sourceOwned.id, employee.id);
  const target = db.createProject({ userId: employee.id, slug: 'target', name: 'Target' });
  const sourceChat = addChat(db, source, employee, 'source chat');
  const sourceRun = addCompletedRun(db, sourceChat, source, employee);
  const targetChat = addChat(db, target, employee, 'target chat');
  const targetRun = addCompletedRun(db, targetChat, target, employee);
  const saved = memory.create({ userId: employee.id, body: '发布文案统一使用克制语气', sourceKind: 'turn',
    sourceProjectId: source.id, sourceChatId: sourceChat.id, sourceTurnRunId: sourceRun.id });

  assert.equal(memory.list(intruder.id).length, 0);
  const recalled = await memory.recall({ userId: employee.id, chat: targetChat, projectId: target.id,
    turnRunId: targetRun.id, query: '发布文案应该使用什么语气？' });
  assert.deepEqual(recalled.map((item) => item.id), [saved.id]);
  assert.equal(recalled[0].crossProject, true);
  assert.equal(memory.refsForTurn(targetRun.id, employee.id)[0].body, saved.body);
  assert.equal(memory.refsForTurn(targetRun.id, intruder.id).length, 0);

  db.revokeProjectAccess(sourceAccess.id);
  assert.equal(memory.list(employee.id).some((item) => item.id === saved.id), false);
  const hidden = memory.refsForTurn(targetRun.id, employee.id)[0];
  assert.equal(hidden.available, false);
  assert.equal(hidden.body, '');
  assert.throws(() => memory.update({ id: saved.id, userId: employee.id, version: saved.version, body: 'changed' }),
    (error) => error.code === 'MEMORY_NOT_FOUND');
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: employee.id,
    recipientUserId: intruder.id }), (error) => error.code === 'MEMORY_SHARE_CONTEXT_INVALID');
  db.updateChat(targetChat.id, { codexThreadId: 'memory-old-thread' });
  memory.invalidateThreads([saved.id]);
  db.recoverChatThread({ chatId: targetChat.id, expectedThreadId: 'memory-old-thread',
    newThreadId: 'memory-reset-thread', reason: 'memory source revoked' });
  assert.deepEqual(memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: employee.id,
    recipientUserId: intruder.id }), { required: false, memoryCount: 0 });
});

test('cross-project memory makes history sharing require a recipient- and snapshot-bound confirmation', async (t) => {
  const { db, memory } = fixture(t);
  const owner = addUser(db, 'owner');
  const recipient = addUser(db, 'recipient');
  const other = addUser(db, 'other');
  const source = db.createProject({ userId: owner.id, slug: 'source', name: 'Source' });
  const target = db.createProject({ userId: owner.id, slug: 'target', name: 'Target' });
  const sourceChat = addChat(db, source, owner, 'source chat');
  const sourceRun = addCompletedRun(db, sourceChat, source, owner);
  const targetChat = addChat(db, target, owner, 'target chat');
  const targetRun = addCompletedRun(db, targetChat, target, owner);
  const saved = memory.create({ userId: owner.id, body: '客户代号是北斗', sourceKind: 'turn',
    sourceProjectId: source.id, sourceChatId: sourceChat.id, sourceTurnRunId: sourceRun.id });
  await memory.recall({ userId: owner.id, chat: targetChat, projectId: target.id,
    turnRunId: targetRun.id, query: '客户代号' });

  let token;
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id }), (error) => {
    token = error.details.confirmationToken;
    assert.equal(error.code, 'MEMORY_SHARE_CONFIRMATION_REQUIRED');
    assert.equal(error.details.memoryCount, 1);
    return true;
  });
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: other.id, confirmationToken: token }), (error) => error.code === 'MEMORY_SHARE_CONFIRMATION_STALE');

  const updated = memory.update({ id: saved.id, userId: owner.id, version: saved.version, body: '客户代号是天枢' });
  assert.equal(updated.version, 2);
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: token }), (error) => error.code === 'MEMORY_SHARE_CONFIRMATION_STALE');

  let currentToken;
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id }), (error) => { currentToken = error.details.confirmationToken; return true; });
  const authorization = memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: currentToken });
  assert.equal(authorization.memoryCount, 1);
  memory.update({ id: saved.id, userId: owner.id, version: updated.version, body: '客户代号是玉衡' });
  assert.throws(() => memory.consumeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: currentToken, snapshotHash: authorization.snapshotHash }),
  (error) => error.code === 'MEMORY_SHARE_CONFIRMATION_STALE');

  let finalToken;
  assert.throws(() => memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id }), (error) => { finalToken = error.details.confirmationToken; return true; });
  const finalAuthorization = memory.authorizeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: finalToken });
  assert.deepEqual(memory.consumeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: finalToken, snapshotHash: finalAuthorization.snapshotHash }),
  { required: true, memoryCount: 1 });
  assert.throws(() => memory.consumeHistoryShare({ projectId: target.id, ownerUserId: owner.id,
    recipientUserId: recipient.id, confirmationToken: finalToken, snapshotHash: finalAuthorization.snapshotHash }),
  (error) => error.code === 'MEMORY_SHARE_CONFIRMATION_STALE');
});

test('model memory tools perform scoped CRUD with version checks and invalidate previous readers', async (t) => {
  const { db, memory } = fixture(t);
  const user = addUser(db, 'employee');
  const project = db.createProject({ userId: user.id, slug: 'memory', name: 'Memory' });
  const chat = addChat(db, project, user, 'normal chat');
  const run = addCompletedRun(db, chat, project, user, '请记住：以后发布前运行 gate');
  db.updateChat(chat.id, { codexThreadId: 'memory-tool-thread' });
  assert.equal(memory.list(user.id).length, 0, 'words alone must not save memory');
  assert.equal(memory.enqueueExtraction, undefined);
  assert.equal(MEMORY_TOOLS.length, 4);
  const active = { user, project, chat, turnRunId: run.id };
  const interrupted = [];
  const call = (name, args) => callMemoryTool({ memory, active, name, args,
    authorize: () => db.getChat(chat.id), interruptOther: async (id) => interrupted.push(id) });
  const saved = await call('memory_add', { body: '发布前运行 gate' });
  assert.equal(saved.saved, true);
  assert.equal('body' in saved, false);
  assert.equal(memory.get(saved.id).sources[0].turnRunId, run.id);
  assert.deepEqual((await call('memory_search', { query: '发布' })).memories,
    [{ id: saved.id, version: 1, body: '发布前运行 gate' }]);
  assert.equal(memory.refsForTurn(run.id, user.id).length, 1);
  await assert.rejects(call('memory_update', { id: saved.id, version: 9, body: '新内容' }), { code: 'MEMORY_CHANGED' });
  const updated = await call('memory_update', { id: saved.id, version: 1, body: '发布前运行完整 gate' });
  assert.equal(updated.version, 2);
  assert.equal(updated.resetRequired, true);
  assert.equal(db.getChat(chat.id).threadState, 'resume_failed');
  assert.throws(() => memory.assertContextFresh(db.getChat(chat.id), user.id), { code: 'MEMORY_CONTEXT_INVALIDATED' });
  assert.deepEqual(interrupted, [], 'must not await self interruption');
  assert.equal(memory.refsForTurn(run.id, user.id)[0].body, '', 'do not substitute newer text for old reference');
  await assert.rejects(call('memory_delete', { id: saved.id, version: 1 }), { code: 'MEMORY_CHANGED' });
  await call('memory_delete', { id: saved.id, version: 2 });
  assert.equal(memory.get(saved.id).body, '');
  assert.equal(memory.list(user.id).length, 0);
});

test('memory tools reject identity override, secrets, foreign IDs and disabled capabilities', async (t) => {
  const { db, memory } = fixture(t);
  const user = addUser(db, 'employee');
  const other = addUser(db, 'other');
  const project = db.createProject({ userId: user.id, slug: 'tools', name: 'Tools' });
  const chat = addChat(db, project, user, 'tools');
  const run = addCompletedRun(db, chat, project, user);
  const call = (name, args) => callMemoryTool({ memory, active: { user, project, chat, turnRunId: run.id },
    name, args, authorize: () => db.getChat(chat.id), interruptOther: async () => {} });
  await assert.rejects(call('memory_add', { body: '中文', userId: other.id }), { code: 'INVALID_MEMORY_ARGUMENTS' });
  await assert.rejects(call('memory_add', { body: '请记住密码' }), { code: 'MEMORY_SECRET_REJECTED' });
  const foreign = memory.create({ userId: other.id, body: '其他用户偏好' });
  await assert.rejects(call('memory_delete', { id: foreign.id, version: 1 }), { code: 'MEMORY_NOT_FOUND' });
  db.updateChat(chat.id, { saveMemory: false, useMemory: false });
  await assert.rejects(call('memory_add', { body: '中文' }), { code: 'MEMORY_TOOL_DISABLED' });
  await assert.rejects(call('memory_search', { query: '' }), { code: 'MEMORY_TOOL_DISABLED' });
  db.updateChat(chat.id, { saveMemory: true, useMemory: true });
  db.db.prepare("UPDATE chats SET purpose='planner' WHERE id=?").run(chat.id);
  await assert.rejects(call('memory_search', { query: '' }), { code: 'MEMORY_TOOL_FORBIDDEN' });
});

test('search reauthorizes after asynchronous index lookup', async (t) => {
  const { db, memory } = fixture(t);
  const user = addUser(db, 'employee');
  const project = db.createProject({ userId: user.id, slug: 'race', name: 'Race' });
  const chat = addChat(db, project, user, 'race');
  const run = addCompletedRun(db, chat, project, user);
  memory.create({ userId: user.id, body: '中文偏好' });
  memory.index.search = async () => { db.updateChat(chat.id, { useMemory: false }); return { results: [] }; };
  await assert.rejects(callMemoryTool({ memory, active: { user, project, chat, turnRunId: run.id },
    name: 'memory_search', args: { query: '' }, authorize: () => db.getChat(chat.id), interruptOther: async () => {} }),
  { code: 'MEMORY_TOOL_DISABLED' });
  assert.equal(memory.refsForTurn(run.id, user.id).length, 0);
});

test('tool updates atomically append provenance and startup never replays legacy extraction jobs', (t) => {
  const { db, memory } = fixture(t);
  const user = addUser(db, 'employee');
  const project = db.createProject({ userId: user.id, slug: 'legacy', name: 'Legacy' });
  const chat = addChat(db, project, user, 'legacy');
  const run = addCompletedRun(db, chat, project, user);
  const saved = memory.create({ userId: user.id, body: '原始偏好' });
  db.db.exec("CREATE TEMP TRIGGER reject_memory_source BEFORE INSERT ON user_memory_sources BEGIN SELECT RAISE(ABORT,'test source failure'); END");
  assert.throws(() => memory.update({ id: saved.id, userId: user.id, version: 1, body: '不应写入',
    sourceProjectId: project.id, sourceChatId: chat.id, sourceTurnRunId: run.id }));
  assert.equal(memory.get(saved.id).version, 1);
  db.db.exec('DROP TRIGGER reject_memory_source');
  const updated = memory.update({ id: saved.id, userId: user.id, version: 1, body: '新的偏好',
    sourceProjectId: project.id, sourceChatId: chat.id, sourceTurnRunId: run.id });
  assert.equal(updated.sources[0].projectId, project.id);
  db.db.prepare(`INSERT INTO memory_extraction_jobs
    (id,turn_run_id,user_id,chat_id,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)`)
    .run(randomUUID(), run.id, user.id, chat.id, project.id, new Date().toISOString(), new Date().toISOString());
  memory.start();
  const job = db.db.prepare('SELECT status,error_code FROM memory_extraction_jobs WHERE turn_run_id=?').get(run.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error_code, 'REPLACED_BY_MEMORY_TOOLS');
  assert.equal(memory.list(user.id).length, 1);
});
