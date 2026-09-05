import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDatabase } from '../src/db.mjs';
import { CapacityService } from '../src/capacity-service.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-capacity-'));
  const config = { databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') };
  const db = new HarnessDatabase(config);
  const user = db.createUser({
    username: 'employee', displayName: 'Employee', passwordHash: 'test', role: 'user', networkAccess: false,
    maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 40,
  });
  const project = db.createProject({ userId: user.id, slug: 'project', name: 'Project' });
  const chats = Array.from({ length: 4 }, (_, index) => db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: `Chat ${index}`,
  }));
  const run = (chat, mode) => db.createTurnRun({ chat, project, userId: user.id, mode });
  return { config, db, user, project, chats, run };
}

test('the third EXECUTE turn queues while EDIT can still run and queue cancellation is durable', async () => {
  const { db, user, chats, run } = fixture();
  const capacity = new CapacityService({ db, maxRootTurns: 11, maxExecuteLeases: 2, leaseTtlMs: 30_000 });
  const firstRun = run(chats[0], 'execute');
  const secondRun = run(chats[1], 'execute');
  const thirdRun = run(chats[2], 'execute');
  const editRun = run(chats[3], 'edit');
  const first = await capacity.acquire({ turnRunId: firstRun.id, chatId: chats[0].id, userId: user.id, mode: 'execute' });
  const second = await capacity.acquire({ turnRunId: secondRun.id, chatId: chats[1].id, userId: user.id, mode: 'execute' });
  const positions = [];
  const third = capacity.acquire({
    turnRunId: thirdRun.id, chatId: chats[2].id, userId: user.id, mode: 'execute', onQueue: (position) => positions.push(position),
  });
  const thirdRejected = assert.rejects(third, /取消排队/);
  const edit = await capacity.acquire({ turnRunId: editRun.id, chatId: chats[3].id, userId: user.id, mode: 'edit' });
  assert.equal(capacity.status().activeExecuteLeases, 2);
  assert.equal(capacity.status().activeRootTurns, 3);
  assert.equal(db.countExecutionLeases(), 2);
  assert.deepEqual(positions, [1]);
  assert.equal(capacity.cancelChat(chats[2].id), true);
  await thirdRejected;
  assert.equal(db.getTurnRun(thirdRun.id).status, 'cancelled');
  edit.release(); first.release(); second.release();
  assert.equal(db.countExecutionLeases(), 0);
  db.close();
});

test('root turn capacity never exceeds eleven', async () => {
  const { db, user, chats, run } = fixture();
  const capacity = new CapacityService({ db, maxRootTurns: 2, maxExecuteLeases: 2 });
  const firstRun = run(chats[0], 'edit');
  const secondRun = run(chats[1], 'edit');
  const thirdRun = run(chats[2], 'edit');
  const first = await capacity.acquire({ turnRunId: firstRun.id, chatId: chats[0].id, userId: user.id, mode: 'edit' });
  const second = await capacity.acquire({ turnRunId: secondRun.id, chatId: chats[1].id, userId: user.id, mode: 'edit' });
  const thirdPromise = capacity.acquire({ turnRunId: thirdRun.id, chatId: chats[2].id, userId: user.id, mode: 'edit' });
  assert.equal(capacity.status().activeRootTurns, 2);
  assert.equal(capacity.status().queuedTurns, 1);
  first.release();
  const third = await thirdPromise;
  assert.equal(capacity.status().activeRootTurns, 2);
  second.release(); third.release(); db.close();
});

test('turns sharing one project access serialize while another worktree can run', async () => {
  const { db, user, project, chats, run } = fixture();
  const capacity = new CapacityService({ db, maxRootTurns: 3, maxExecuteLeases: 3 });
  const firstRun = run(chats[0], 'edit');
  const secondRun = run(chats[1], 'edit');
  const otherRun = run(chats[2], 'edit');
  const first = await capacity.acquire({
    turnRunId: firstRun.id, chatId: chats[0].id, userId: user.id, mode: 'edit', workspaceKey: project.accessId,
  });
  let secondGranted = false;
  const secondPromise = capacity.acquire({
    turnRunId: secondRun.id, chatId: chats[1].id, userId: user.id, mode: 'edit', workspaceKey: project.accessId,
  }).then((token) => { secondGranted = true; return token; });
  const other = await capacity.acquire({
    turnRunId: otherRun.id, chatId: chats[2].id, userId: user.id, mode: 'edit', workspaceKey: 'another-access',
  });
  assert.equal(secondGranted, false);
  assert.equal(capacity.status().activeRootTurns, 2);
  assert.equal(capacity.status().queuedTurns, 1);
  first.release();
  const second = await secondPromise;
  assert.equal(secondGranted, true);
  second.release(); other.release(); db.close();
});

test('restart interrupts running work and cancels stale approvals and leases', () => {
  const { config, db, user, project, chats, run } = fixture();
  const turn = run(chats[0], 'execute');
  db.updateTurnRun(turn.id, { status: 'running', startedAt: new Date().toISOString() });
  db.updateChat(chats[0].id, { status: 'running' });
  db.createExecutionLease({
    turnRunId: turn.id, userId: user.id, chatId: chats[0].id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  db.createApproval({
    id: 'approval-before-restart', turnRunId: turn.id, chatId: chats[0].id,
    userId: user.id, kind: 'command', request: { command: 'pwd' },
  });
  db.close();

  const observer = new HarnessDatabase(config);
  assert.equal(observer.getTurnRun(turn.id).status, 'running');
  assert.equal(observer.countExecutionLeases(), 1);
  observer.close();

  const recovered = new HarnessDatabase(config);
  recovered.recoverInterruptedRuntime();
  assert.equal(recovered.getTurnRun(turn.id).status, 'interrupted');
  assert.equal(recovered.getApproval('approval-before-restart').status, 'cancelled');
  assert.equal(recovered.countExecutionLeases(), 0);
  assert.equal(recovered.getChat(chats[0].id).status, 'idle');
  assert.equal(recovered.getProjectForUser(project.id, user.id).id, project.id);
  assert.equal(recovered.listTurnEvents(chats[0].id).at(-1).eventType, 'turn_error');
  assert.equal(recovered.listMessages(chats[0].id).at(-1).metadata.code, 'PORTAL_RESTARTED');
  recovered.close();
});
