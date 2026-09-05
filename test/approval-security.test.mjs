import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { CodexService } from '../src/codex-service.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-approval-'));
  const config = {
    rootDir: base, dataDir: base, databasePath: path.join(base, 'db.sqlite'),
    workspacesRoot: path.join(base, 'workspaces'), treesRoot: path.join(base, 'trees'),
    runtimeRoot: path.join(base, 'runtime'), trashRoot: path.join(base, 'trash'),
    portalSkillsRoot: path.join(base, 'skills'), portalAgentConfig: path.join(base, 'luna.toml'),
    codexModel: 'test-model', codexModelProvider: 'test-provider', codexReasoningEffort: 'low',
    codexMaxConcurrentTurns: 4, portalMaxActiveRootTurns: 2, portalMaxExecuteLeases: 1,
    executionLeaseTtlMs: 30_000, maxSubagentsPerRoot: 3, subagentModel: 'test-subagent',
    codexRequestTimeoutMs: 30_000, fileMaxBytes: 1024 * 1024, uploadMaxBytes: 1024 * 1024,
  };
  fs.mkdirSync(config.portalSkillsRoot, { recursive: true });
  const db = new HarnessDatabase(config);
  const workspace = new WorkspaceService(config);
  const user = db.createUser({
    username: 'approval-user', displayName: 'Approval User', passwordHash: 'test', role: 'user', networkAccess: false,
    maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2,
  });
  const created = db.createProject({ userId: user.id, slug: 'approval-project', name: 'Approval project' });
  workspace.createProject(created);
  const project = db.getProjectForUser(created.id, user.id);
  const chat = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'Approval chat',
  });
  db.updateChat(chat.id, { codexThreadId: 'approval-thread', status: 'running' });
  const run = db.createTurnRun({ chat: db.getChat(chat.id), project, userId: user.id, mode: 'edit' });
  db.updateTurnRun(run.id, { status: 'running', codexThreadId: 'approval-thread', codexTurnId: 'approval-turn' });
  const codex = new CodexService({ config, db, workspace });
  const active = {
    chat: db.getChat(chat.id), project, user, threadId: 'approval-thread', turnId: 'approval-turn',
    turnRunId: run.id, mode: 'edit', emit: () => {}, fileChangePathsByItem: new Map(),
  };
  codex.activeByChat.set(chat.id, active);
  codex.activeByThread.set(active.threadId, active);
  return { db, workspace, codex, active };
}

async function waitFor(predicate) {
  for (let count = 0; count < 100; count += 1) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timed out waiting for approval processing');
}

test('native file approvals fail closed for missing or reserved targets and expose safe targets', async () => {
  const { db, workspace, codex, active } = fixture();
  const responses = new Map();
  codex.client.respond = (id, response) => { responses.set(id, response); };

  codex.client.emit('serverRequest', {
    method: 'item/fileChange/requestApproval', id: 1,
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'missing', grantRoot: workspace.projectRoot(active.project) },
  });
  await waitFor(() => responses.get(1));
  assert.equal(responses.get(1).decision, 'decline');

  codex.client.emit('notification', {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'reserved', changes: [{ path: '.GIT/config', kind: 'update', diff: '' }] },
  });
  codex.client.emit('serverRequest', {
    method: 'item/fileChange/requestApproval', id: 2,
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'reserved', grantRoot: workspace.projectRoot(active.project) },
  });
  await waitFor(() => responses.get(2));
  assert.equal(responses.get(2).decision, 'decline');

  codex.client.emit('notification', {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'safe', changes: [{ path: 'src/index.js', kind: 'add', diff: '' }] },
  });
  codex.client.emit('serverRequest', {
    method: 'item/fileChange/requestApproval', id: 3,
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'safe', grantRoot: null },
  });
  const approval = await waitFor(() => db.getApproval('rpc:3'));
  assert.deepEqual(approval.request.files, ['src/index.js']);
  assert.equal(responses.has(3), false);

  codex.client.emit('notification', {
    method: 'item/fileChange/patchUpdated',
    params: { threadId: active.threadId, turnId: active.turnId, itemId: 'safe', changes: [{ path: 'src/changed.js', kind: 'add', diff: '' }] },
  });
  assert.throws(() => codex.resolveApproval({
    chatId: active.chat.id, userId: active.user.id, approvalId: approval.id, decision: 'accept',
  }), /目标已变化/);
  codex.resolveApproval({ chatId: active.chat.id, userId: active.user.id, approvalId: approval.id, decision: 'decline' });
  db.close();
});

test('legacy apply-patch approval validates source and move targets using conversationId', async () => {
  const { db, codex, active } = fixture();
  const responses = new Map();
  codex.client.respond = (id, response) => { responses.set(id, response); };

  codex.client.emit('serverRequest', {
    method: 'applyPatchApproval', id: 10,
    params: {
      conversationId: active.threadId, callId: 'legacy-safe', grantRoot: null, reason: null,
      fileChanges: { 'src/old.js': { type: 'update', unified_diff: '', move_path: 'src/new.js' } },
    },
  });
  const safe = await waitFor(() => db.getApproval('rpc:10'));
  assert.deepEqual(safe.request.files, ['src/new.js', 'src/old.js']);
  codex.resolveApproval({ chatId: active.chat.id, userId: active.user.id, approvalId: safe.id, decision: 'decline' });

  codex.client.emit('serverRequest', {
    method: 'applyPatchApproval', id: 11,
    params: {
      conversationId: active.threadId, callId: 'legacy-reserved', grantRoot: null, reason: null,
      fileChanges: { 'src/old.js': { type: 'update', unified_diff: '', move_path: '.CoDeX/config.toml' } },
    },
  });
  await waitFor(() => responses.get(11));
  assert.equal(responses.get(11).decision, 'decline');
  db.close();
});
