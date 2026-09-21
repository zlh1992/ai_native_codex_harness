import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { CodexService } from '../src/codex-service.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-recovery-'));
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
    username: 'employee', displayName: 'Employee', passwordHash: 'test', role: 'user', networkAccess: false,
    maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2,
  });
  const project = db.createProject({ userId: user.id, slug: 'project', name: 'Project' });
  workspace.createProject(project);
  const chat = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'Recover me',
  });
  db.updateChat(chat.id, { codexThreadId: 'old-thread' });
  return { base, config, db, workspace, user, project: db.getProjectForUser(project.id, user.id), chat: db.getChat(chat.id) };
}

test('resume failure preserves the old mapping until an acknowledged reset records lineage', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') throw new Error(`${config.workspacesRoot}/secret resume failure`);
    if (method === 'thread/start') return { thread: { id: 'new-thread' } };
    return {};
  };

  await assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'hello', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'CODEX_THREAD_RESUME_FAILED');
  assert.equal(calls.includes('thread/start'), false);
  const failed = db.getChat(chat.id);
  assert.equal(failed.codexThreadId, 'old-thread');
  assert.equal(failed.threadState, 'resume_failed');
  assert.equal(failed.threadError.includes(config.workspacesRoot), false);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'failed');

  await assert.rejects(codex.recoverChatThread({
    chat: failed, project, user, action: 'retry', acknowledgeHistoryBreak: false,
  }), (error) => error.code === 'CODEX_THREAD_RESUME_FAILED');
  const retried = db.getChat(chat.id);
  assert.equal(retried.codexThreadId, 'old-thread');
  assert.equal(retried.threadState, 'resume_failed');
  assert.equal(retried.threadError.includes(config.workspacesRoot), false);

  await assert.rejects(codex.recoverChatThread({
    chat: retried, project, user, action: 'reset', acknowledgeHistoryBreak: false,
  }), (error) => error.code === 'HISTORY_BREAK_ACK_REQUIRED');
  const recovered = await codex.recoverChatThread({
    chat: retried, project, user, action: 'reset', acknowledgeHistoryBreak: true,
  });
  assert.equal(recovered.codexThreadId, 'new-thread');
  assert.equal(recovered.threadState, 'ready');
  assert.deepEqual(db.listChatThreadRecoveries(chat.id).map((item) => [item.oldThreadId, item.newThreadId]), [['old-thread', 'new-thread']]);
  await assert.rejects(codex.recoverChatThread({
    chat: recovered, project, user, action: 'retry', acknowledgeHistoryBreak: false,
  }), (error) => error.code === 'THREAD_RECOVERY_NOT_REQUIRED');
  db.close();
});

test('turn journal cursors are ordered and omit token text and raw diffs', () => {
  const { db, user, project, chat } = fixture();
  const run = db.createTurnRun({ chat, project, userId: user.id, mode: 'edit' });
  const first = db.appendTurnEvent({ turnRunId: run.id, chatId: chat.id, eventType: 'turn_status', payload: { status: 'running' } });
  const second = db.appendTurnEvent({ turnRunId: run.id, chatId: chat.id, eventType: 'diff_updated', payload: { hasDiff: true, byteLength: 123 } });
  assert.ok(second.id > first.id);
  assert.deepEqual(db.listTurnEvents(chat.id, { afterId: first.id, turnRunId: run.id }).map((event) => event.id), [second.id]);
  assert.equal(JSON.stringify(db.listTurnEvents(chat.id)).includes('diff --git'), false);
  assert.equal(db.getLatestTurnEventIdForRun(run.id), second.id);
  db.close();
});

test('deterministic fallback messages are idempotent and do not reorder a chat during hydration', () => {
  const { db, chat } = fixture();
  db.addMessage({ id: 'stable-message', chatId: chat.id, role: 'assistant', content: 'first snapshot' });
  const stableTimestamp = '2000-01-01T00:00:00.000Z';
  db.db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(stableTimestamp, chat.id);
  const duplicate = db.addMessage({ id: 'stable-message', chatId: chat.id, role: 'assistant', content: 'must not replace' });
  assert.equal(db.listMessages(chat.id).length, 1);
  assert.equal(duplicate.content, 'first snapshot');
  assert.equal(db.getChat(chat.id).updatedAt, stableTimestamp);
  db.close();
});

test('native history hydration keeps Portal-only failed turns visible', async () => {
  const { db, workspace, config, chat } = fixture();
  db.addMessage({ id: 'portal-only-error', chatId: chat.id, role: 'error', kind: 'turn_error', content: 'queued turn was revoked' });
  const codex = new CodexService({ config, db, workspace });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    assert.equal(method, 'thread/read');
    return { thread: { id: chat.codexThreadId, turns: [] } };
  };
  const history = await codex.historyForChat(chat);
  assert.deepEqual(history.map((message) => [message.id, message.role, message.content]), [
    ['portal-only-error', 'error', 'queued turn was revoked'],
  ]);
  db.close();
});

test('a queued turn rechecks revoked access before touching the native thread and persists its failure', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  config.portalMaxActiveRootTurns = 1;
  const codex = new CodexService({ config, db, workspace });
  const blockerChat = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'Capacity blocker',
  });
  const blockerRun = db.createTurnRun({ chat: blockerChat, project, userId: user.id, mode: 'edit' });
  const blocker = await codex.capacity.acquire({
    turnRunId: blockerRun.id, chatId: blockerChat.id, userId: user.id, mode: 'edit', workspaceKey: 'blocker',
  });
  let nativeTouched = false;
  codex.client.start = async () => { nativeTouched = true; };
  codex.client.request = async () => { nativeTouched = true; return {}; };

  const rejection = assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'must stop at the revoked boundary', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'PROJECT_ACCESS_REVOKED');
  const queuedRun = db.getLatestTurnRunForChat(chat.id);
  assert.equal(queuedRun.status, 'queued');
  db.db.prepare("UPDATE project_access SET status='revoked',revoked_at=? WHERE id=?")
    .run(new Date().toISOString(), project.accessId);
  blocker.release();
  await rejection;

  const failedRun = db.getTurnRun(queuedRun.id);
  const events = db.listTurnEvents(chat.id, { turnRunId: failedRun.id });
  assert.equal(nativeTouched, false);
  assert.equal(failedRun.status, 'failed');
  assert.equal(events.at(-1).eventType, 'turn_error');
  assert.equal(events.at(-1).payload.status, 'failed');
  assert.equal(events.at(-1).payload.code, 'PROJECT_ACCESS_REVOKED');
  assert.equal(db.listMessages(chat.id).at(-1).role, 'error');
  db.close();
});

test('revocation during thread setup prevents native turn start', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') {
      db.db.prepare("UPDATE project_access SET status='revoked',revoked_at=? WHERE id=?")
        .run(new Date().toISOString(), project.accessId);
      return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    }
    return {};
  };

  await assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'must not start after setup-time revoke', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'PROJECT_ACCESS_REVOKED');
  const run = db.getLatestTurnRunForChat(chat.id);
  assert.equal(calls.includes('thread/resume'), true);
  assert.equal(calls.includes('turn/start'), false);
  assert.equal(run.status, 'failed');
  assert.equal(db.listTurnEvents(chat.id, { turnRunId: run.id }).at(-1).payload.code, 'PROJECT_ACCESS_REVOKED');
  db.close();
});

test('an interrupt during native turn startup is remembered and drained once the turn id arrives', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  let releaseStart;
  const delayedStart = new Promise((resolve) => { releaseStart = resolve; });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    if (method === 'turn/start') return delayedStart;
    return {};
  };

  const rejection = assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'startup must be interruptible', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'TURN_INTERRUPTED');
  while (!calls.includes('turn/start')) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await codex.interrupt(chat.id), true);
  releaseStart({ turn: { id: 'native-turn-after-interrupt' } });
  await rejection;

  assert.equal(calls.filter((method) => method === 'turn/interrupt').length, 1);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'interrupted');
  assert.equal(db.runtimeForChat(chat.id).busy, false);
  db.close();
});

test('an interrupt during thread setup cancels the pre-turn startup without calling turn/start', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  let releaseResume;
  const delayedResume = new Promise((resolve) => { releaseResume = resolve; });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') return delayedResume;
    return {};
  };

  const rejection = assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'stop before native turn creation', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'TURN_INTERRUPTED');
  while (!calls.includes('thread/resume')) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(await codex.interrupt(chat.id), true);
  releaseResume({ thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } });
  await rejection;

  assert.equal(calls.includes('turn/start'), false);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'interrupted');
  assert.equal(db.runtimeForChat(chat.id).busy, false);
  db.close();
});

test('a user-scoped interrupt covers thread setup and waits for its durable terminal state', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  let releaseResume;
  const delayedResume = new Promise((resolve) => { releaseResume = resolve; });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') return delayedResume;
    return {};
  };

  const rejection = assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'user reset during setup', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'TURN_INTERRUPTED');
  while (!calls.includes('thread/resume')) await new Promise((resolve) => setTimeout(resolve, 1));
  const drained = codex.interruptUserAndWait(user.id, 2_000);
  releaseResume({ thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } });
  await Promise.all([rejection, drained]);

  assert.equal(calls.includes('turn/start'), false);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'interrupted');
  assert.equal(codex.userBusy(user.id), false);
  db.close();
});

test('terminal run and chat state are durable before capacity is released', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/resume') return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    if (method === 'turn/start') return { turn: { id: 'durable-turn' } };
    return {};
  };
  let releasedState;
  codex.capacity.on('released', ({ turnRunId }) => {
    releasedState = {
      run: db.getTurnRun(turnRunId)?.status,
      chat: db.getChat(chat.id)?.status,
      leases: db.countExecutionLeases(),
    };
  });

  const completion = codex.runTurn({
    chat, project, user, prompt: 'finish durably', effort: 'low', mode: 'execute', emit: () => {},
  });
  while (!calls.includes('turn/start')) await new Promise((resolve) => setTimeout(resolve, 1));
  codex.client.emit('notification', {
    method: 'turn/completed', params: { threadId: chat.codexThreadId, turn: { id: 'durable-turn', status: 'completed' } },
  });
  await completion;

  assert.deepEqual(releasedState, { run: 'completed', chat: 'idle', leases: 0 });
  db.close();
});

test('history and goal authorization callbacks run after native awaits before data is returned', async () => {
  const { db, workspace, config, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    if (method === 'thread/read') return { thread: { turns: [] } };
    if (method === 'thread/goal/get') return { goal: { status: 'paused', objective: 'safe' } };
    return {};
  };
  let historyChecks = 0;
  await assert.rejects(codex.historyForChat(chat, () => {
    historyChecks += 1;
    if (historyChecks >= 2) throw new Error('authorization revoked');
  }), /authorization revoked/);
  assert.ok(historyChecks >= 2);

  let goalChecks = 0;
  await assert.rejects(codex.getGoal(chat, () => {
    goalChecks += 1;
    if (goalChecks >= 2) throw new Error('authorization revoked');
  }), /authorization revoked/);
  assert.ok(goalChecks >= 2);
  db.close();
});

test('health readiness remains false when Portal skill registration fails', async () => {
  const { db, workspace, config } = fixture();
  const codex = new CodexService({ config, db, workspace });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    if (method === 'skills/extraRoots/set') throw new Error('skill registration failed');
    return {};
  };

  await assert.rejects(codex.start(), /skill registration failed/);
  assert.equal(codex.status().ready, false);
  assert.match(codex.status().lastError, /skill registration failed/);
  db.close();
});

test('a native turn that completes before turn/start resolves still persists its Codex turn identity', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    if (method === 'thread/resume') return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    if (method === 'turn/start') {
      const turn = { id: 'fast-native-turn', status: 'completed' };
      codex.client.emit('notification', {
        method: 'item/completed',
        params: {
          threadId: chat.codexThreadId, turnId: turn.id,
          item: { id: 'fast-final-item', type: 'agentMessage', phase: 'final_answer', text: 'fast final answer' },
        },
      });
      codex.client.emit('notification', { method: 'turn/completed', params: { threadId: chat.codexThreadId, turn } });
      return { turn };
    }
    return {};
  };

  await codex.runTurn({
    chat, project, user, prompt: 'complete synchronously', effort: 'low', mode: 'edit', emit: () => {},
  });
  const run = db.getLatestTurnRunForChat(chat.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.codexTurnId, 'fast-native-turn');
  assert.equal(run.finalItemId, 'fast-final-item');
  assert.equal(run.finalReplySnapshot, 'fast final answer');
  db.close();
});

test('task policy is rechecked after asynchronous skill discovery and before native turn/start', async () => {
  const { db, workspace, config, user, project } = fixture();
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Policy task', status: 'ready',
    steps: [{ assigneeUserId: user.id, title: 'Policy boundary', acceptance: 'Do not start after disable.' }],
  });
  const task = db.activateRoadmap(roadmap.id).steps[0];
  const taskChat = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, taskId: task.id, taskVersion: task.version, title: 'Policy task chat',
  });
  db.updateChat(taskChat.id, { codexThreadId: 'task-policy-thread' });
  const chat = db.getChat(taskChat.id);
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method, params) => {
    calls.push(method);
    if (method === 'thread/resume') return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    if (method === 'skills/list') {
      db.updateUser(user.id, { status: 'disabled' });
      return { data: (params.cwds || []).map((cwd) => ({
        cwd, skills: [{ name: 'task-execution', path: path.join(config.portalSkillsRoot, 'task-execution', 'SKILL.md'), enabled: true }],
      })) };
    }
    return {};
  };

  await assert.rejects(codex.runTurn({
    chat, project, user, prompt: 'must stop after policy changes', effort: 'low', mode: 'edit', emit: () => {},
  }), (error) => error.code === 'USER_DISABLED');
  assert.equal(calls.includes('skills/list'), true);
  assert.equal(calls.includes('turn/start'), false);
  assert.equal(db.getLatestTurnRunForChat(chat.id).status, 'failed');
  db.close();
});

test('thread recovery participates in chat and worktree lifecycle barriers', async () => {
  const { db, workspace, config, user, project, chat } = fixture();
  db.markChatThreadError(chat.id, 'resume failed');
  const failedChat = db.getChat(chat.id);
  const codex = new CodexService({ config, db, workspace });
  const calls = [];
  let releaseStart;
  const delayedStart = new Promise((resolve) => { releaseStart = resolve; });
  codex.client.start = async () => { codex.client.started = true; };
  codex.client.request = async (method) => {
    calls.push(method);
    if (method === 'thread/start') return delayedStart;
    return {};
  };

  const recovery = codex.recoverChatThread({
    chat: failedChat, project, user, action: 'reset', acknowledgeHistoryBreak: true,
  });
  while (!calls.includes('thread/start')) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(codex.chatBusy(chat.id), true);
  assert.equal(codex.workspaceBusy(project.accessId), true);
  await assert.rejects(codex.waitForChatIdle(chat.id, 10), (error) => error.code === 'TURN_DRAIN_TIMEOUT');
  releaseStart({ thread: { id: 'recovered-thread' } });
  const recovered = await recovery;
  assert.equal(recovered.codexThreadId, 'recovered-thread');
  assert.equal(codex.chatBusy(chat.id), false);
  assert.equal(codex.workspaceBusy(project.accessId), false);
  db.close();
});


test('share barrier blocks owner turns and thread recovery without changing native mapping', async () => {
  const { db, config, workspace, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  codex.sharingAccesses.add(project.accessId);
  assert.equal(codex.workspaceBusy(project.accessId), true);
  assert.equal(codex.chatBusy(chat.id), true);
  await assert.rejects(codex.runTurn({ chat, project, user, prompt: 'Blocked during share', mode: 'edit', emit: () => {} }),
    (error) => error.code === 'WORKSPACE_BUSY');
  await assert.rejects(codex.recoverChatThread({ chat, project, user, action: 'retry' }),
    (error) => error.code === 'WORKSPACE_BUSY');
  assert.equal(db.getChat(chat.id).codexThreadId, 'old-thread');
  assert.equal(db.getLatestTurnRunForChat(chat.id), null);
  codex.sharingAccesses.clear();
  assert.equal(codex.workspaceBusy(project.accessId), false);
  db.close();
});

test('share fork applies recipient policy and rejects revoked authorization after native await', async () => {
  const { db, config, workspace, user, project, chat } = fixture();
  const codex = new CodexService({ config, db, workspace });
  const recipient = { ...user, networkAccess: false };
  const recipientProject = { ...project, treePath: path.join(config.treesRoot, 'recipient') };
  let revoked = false;
  let readCalled = false;
  codex.client.start = async () => {};
  codex.client.request = async (method, params) => {
    if (method === 'thread/fork') {
      assert.equal(params.threadId, chat.codexThreadId);
      assert.equal(params.cwd, recipientProject.treePath);
      assert.equal(params.sandbox, 'read-only');
      assert.match(params.baseInstructions, /network access for this user is disabled/);
      assert.equal('dynamicTools' in params, false);
      revoked = true;
      return { thread: { id: 'independent-fork', modelProvider: config.codexModelProvider } };
    }
    readCalled = true;
    return {};
  };
  await assert.rejects(codex.prepareSharedChats({ sources: [chat], project: recipientProject, user: recipient,
    authorize() { if (revoked) throw new Error('authorization revoked'); },
  }), /authorization revoked/);
  assert.equal(readCalled, false);
  assert.equal(db.getChat(chat.id).codexThreadId, 'old-thread');
  db.close();
});


test('share publishing rolls back access and earlier chats when a later chat fails, and lineage migrates idempotently', () => {
  const { db, config, user, project, chat } = fixture();
  const recipient = db.createUser({ username: 'share-recipient', displayName: 'Recipient', passwordHash: 'test', role: 'user',
    maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2 });
  const options = { projectId: project.id, userId: recipient.id, treePath: path.join(config.treesRoot, 'copy'), branchName: 'copy' };
  const snapshot = { source: chat, threadId: 'new-private-thread', messages: [] };
  assert.throws(() => db.grantProjectAccessWithChats(options, [snapshot, { ...snapshot, source: { ...chat, title: null } }]), /NOT NULL/);
  assert.equal(db.listProjectAccess(project.id).length, 1);
  assert.equal(db.listChats({ userId: recipient.id }).length, 0);
  assert.equal(db.getChat(chat.id).userId, user.id);
  const access = db.grantProjectAccessWithChats(options, [snapshot]);
  const copied = db.listChats({ userId: recipient.id })[0];
  assert.equal(copied.projectAccessId, access.id);
  assert.equal(copied.sourceChatId, chat.id);
  assert.equal(copied.taskId, null);
  db.close();
  const reopened = new HarnessDatabase(config);
  assert.equal(reopened.getChat(copied.id).sourceChatId, chat.id);
  assert.equal(reopened.getChat(copied.id).sharedAt, copied.sharedAt);
  assert.deepEqual(reopened.db.prepare('PRAGMA foreign_key_check').all(), []);
  reopened.close();
});

test('boss and employee model preferences reach resumed thread and each turn with role/chat effort', async () => {
  const { base, db, workspace, config, user, project, chat } = fixture();
  const service = new CodexService({ config, db, workspace });
  const calls = [];
  service.client.start = async () => { service.client.started = true; };
  service.client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/resume') return { thread: { id: chat.codexThreadId, modelProvider: config.codexModelProvider } };
    if (method === 'turn/start') throw new Error('intentional test stop');
    return {};
  };
  try {
    db.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      const current = db.updateChat(chat.id, { preferredModel: model });
      await assert.rejects(service.runTurn({ chat: current, project, user: db.getUserById(user.id), prompt: 'model test', mode: 'edit', emit() {} }), /intentional test stop/);
      assert.equal(calls.filter((call) => call.method === 'turn/start').at(-1).params.model, model);
    }
    assert.equal(calls.find((call) => call.method === 'thread/resume').params.model, 'gpt-6-astra');
    db.db.prepare("UPDATE users SET role='user' WHERE id=?").run(user.id);
    await assert.rejects(service.runTurn({ chat: db.getChat(chat.id), project, user, prompt: 'employee model test', mode: 'edit', emit() {} }), /intentional test stop/);
    assert.equal(calls.filter((call) => call.method === 'turn/start').at(-1).params.model, 'gpt-5.6-terra');
    assert.equal(calls.filter((call) => call.method === 'turn/start').at(-1).params.effort, 'medium');
    db.updateChat(chat.id, { preferredEffort: 'max' });
    await assert.rejects(service.runTurn({ chat: db.getChat(chat.id), project, user, prompt: 'effort', mode: 'edit', emit() {} }), /intentional test stop/);
    assert.equal(calls.filter((call) => call.method === 'turn/start').at(-1).params.effort, 'max');
  } finally { db.close(); fs.rmSync(base, { recursive: true, force: true }); }
});

test('native usage counts child and root exactly once, attributes late samples and survives chat deletion', async () => {
  const {base,db,workspace,config,user,project,chat}=fixture();
  const service=new CodexService({config,db,workspace});
  const emit=(method,params)=>service.client.emit('notification',{method,params});
  const counts=(n)=>({inputTokens:100*n,outputTokens:20*n,totalTokens:120*n});
  service.client.start=async()=>{service.client.started=true;};
  service.client.request=async(method)=>{
    if(method==='thread/resume'){
      emit('thread/tokenUsage/updated',{threadId:'old-thread',turnId:'past',tokenUsage:{total:counts(5),last:counts(1)}});
      return {thread:{id:'old-thread',modelProvider:config.codexModelProvider}};
    }
    if(method==='turn/start'){
      emit('turn/started',{threadId:'old-thread',turn:{id:'root-turn'}});
      emit('thread/started',{thread:{id:'child-thread',parentThreadId:'old-thread',forkedFromId:null}});
      emit('thread/settings/updated',{threadId:'child-thread',threadSettings:{model:config.subagentModel,effort:'medium'}});
      emit('turn/started',{threadId:'child-thread',turn:{id:'child-turn'}});
      emit('thread/tokenUsage/updated',{threadId:'child-thread',turnId:'child-turn',tokenUsage:{total:counts(1),last:counts(1)}});
      emit('turn/completed',{threadId:'child-thread',turn:{id:'child-turn',status:'completed'}});
      emit('thread/tokenUsage/updated',{threadId:'old-thread',turnId:'root-turn',tokenUsage:{total:counts(6),last:counts(1)}});
      emit('turn/completed',{threadId:'old-thread',turn:{id:'root-turn',status:'completed'}});
      return {turn:{id:'root-turn'}};
    }
    return {};
  };
  try{
    await service.runTurn({chat,project,user,prompt:'Synthetic usage',mode:'edit',emit(){}});
    assert.equal(db.tokenUsage.dashboard().totals.employeeGpt.totalTokens,240);
    assert.equal(db.tokenUsage.dashboard().totals.employeeGpt.incompleteCalls,0);
    emit('thread/tokenUsage/updated',{threadId:'child-thread',turnId:'child-turn',tokenUsage:{total:counts(2),last:counts(1)}});
    assert.equal(db.tokenUsage.dashboard().totals.employeeGpt.totalTokens,360);
    assert.equal(db.tokenUsage.dashboard().models.find(m=>m.model===config.subagentModel).effort,'medium');
    db.db.prepare('DELETE FROM chats WHERE id=?').run(chat.id);
    assert.equal(db.tokenUsage.dashboard().totals.employeeGpt.totalTokens,360);
  }finally{service.stop();db.close();fs.rmSync(base,{recursive:true,force:true});}
});
