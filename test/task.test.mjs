import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HarnessDatabase } from '../src/db.mjs';

const SNAPSHOT_COMMIT = 'a'.repeat(40);
const SNAPSHOT_TREE = 'b'.repeat(40);
const DELIVERY_COMMIT = 'c'.repeat(40);

function user(db, username, role = 'user') {
  return db.createUser({
    username, displayName: username, passwordHash: 'test', role, networkAccess: false,
    maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 40,
  });
}

test('legacy submission schema gains Git delivery columns idempotently while retaining SET NULL evidence links', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-submission-migration-'));
  const config = { databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') };
  let db = new HarnessDatabase(config);
  db.close();

  const legacy = new DatabaseSync(config.databasePath);
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE task_submissions;
    CREATE TABLE task_submissions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_version INTEGER NOT NULL,
      submitter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
      codex_thread_id TEXT NOT NULL,
      codex_turn_id TEXT NOT NULL,
      final_item_id TEXT NOT NULL,
      final_reply_snapshot TEXT NOT NULL,
      diff_snapshot TEXT NOT NULL DEFAULT '',
      employee_note TEXT NOT NULL DEFAULT '',
      verdict TEXT NOT NULL DEFAULT 'pending' CHECK(verdict IN ('pending','passed','rework')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      UNIQUE(task_id, task_version)
    );
  `);
  legacy.close();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    db = new HarnessDatabase(config);
    const columns = new Set(db.db.prepare('PRAGMA table_info(task_submissions)').all().map((column) => column.name));
    for (const name of ['project_access_id', 'snapshot_commit_sha', 'snapshot_tree_sha', 'delivery_commit_sha', 'delivered_at']) {
      assert.equal(columns.has(name), true, `${name} must exist after migration`);
    }
    const foreignKeys = db.db.prepare('PRAGMA foreign_key_list(task_submissions)').all();
    assert.equal(foreignKeys.find((key) => key.from === 'chat_id')?.on_delete, 'SET NULL');
    assert.equal(foreignKeys.find((key) => key.from === 'turn_run_id')?.on_delete, 'SET NULL');
    assert.equal(foreignKeys.find((key) => key.from === 'project_access_id')?.on_delete, 'SET NULL');
    db.close();
  }
});

test('task access and immutable submission are bound to assignee, version, chat, turn and final item', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-task-'));
  const db = new HarnessDatabase({ databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') });
  const boss = user(db, 'boss', 'admin');
  const employee = user(db, 'employee');
  const intruder = user(db, 'intruder');
  const project = db.createProject({ userId: boss.id, slug: 'shared-project', name: 'Shared project' });
  const access = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'employee'), branchName: 'portal/share/employee',
  });
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Delivery', status: 'ready',
    steps: [{ assigneeUserId: employee.id, title: 'Implement employee page', acceptance: 'All IDOR tests pass.' }],
  });
  const active = db.activateRoadmap(roadmap.id).steps[0];
  assert.equal(active.status, 'active');
  assert.equal(db.getTaskForUser(active.id, employee.id)?.id, active.id);
  assert.equal(db.getTaskForUser(active.id, intruder.id), null);
  const chat = db.createChat({
    projectId: project.id, userId: employee.id, projectAccessId: access.id, treePath: access.treePath,
    taskId: active.id, taskVersion: active.version, title: 'Task chat',
  });
  const run = db.createTurnRun({ chat, project: db.getProjectForUser(project.id, employee.id), userId: employee.id, mode: 'edit' });
  db.updateTurnRun(run.id, {
    status: 'completed', codexThreadId: 'thread-1', codexTurnId: 'turn-1', finalItemId: 'item-final',
    finalReplySnapshot: 'Finished and tested.', diffSnapshot: 'diff --git a/a b/a', completedAt: new Date().toISOString(),
  });
  assert.throws(() => db.submitTask({
    taskId: active.id, taskVersion: 1, submitterUserId: intruder.id, chatId: chat.id,
    turnRunId: run.id, itemId: 'item-final',
  }), /不属于当前员工/);
  assert.throws(() => db.submitTask({
    taskId: active.id, taskVersion: 1, submitterUserId: employee.id, chatId: chat.id,
    turnRunId: run.id, itemId: 'commentary-item',
  }), /最终 Codex 回复/);
  const submission = db.submitTask({
    taskId: active.id, taskVersion: 1, submitterUserId: employee.id, chatId: chat.id,
    projectAccessId: access.id, turnRunId: run.id, itemId: 'item-final', note: 'Please check IDOR tests.',
    snapshotCommitSha: SNAPSHOT_COMMIT, snapshotTreeSha: SNAPSHOT_TREE,
  });
  assert.equal(submission.finalReplySnapshot, 'Finished and tested.');
  assert.equal(submission.diffSnapshot, 'diff --git a/a b/a');
  assert.equal(db.getTaskForUser(active.id, employee.id).status, 'submitted');
  assert.throws(() => db.deleteChat(chat.id), /提交证据/);
  db.db.prepare('DELETE FROM chats WHERE id=?').run(chat.id);
  const retained = db.getSubmission(submission.id);
  assert.equal(retained.chatId, null);
  assert.equal(retained.turnRunId, null);
  assert.equal(retained.finalReplySnapshot, 'Finished and tested.');
  assert.equal(db.getTaskForUser(active.id, employee.id).status, 'submitted');
  assert.throws(() => db.submitTask({
    taskId: active.id, taskVersion: 1, submitterUserId: employee.id, chatId: chat.id,
    turnRunId: run.id, itemId: 'item-final',
  }), /版本已变化/);
  db.reviewSubmission({ submissionId: submission.id, verdict: 'rework' });
  const rework = db.getTaskForUser(active.id, employee.id);
  assert.equal(rework.status, 'rework');
  assert.equal(rework.version, 2);
  assert.notEqual(chat.taskVersion, rework.version);
  db.close();
});

test('a three-step roadmap advances linearly and rework creates a new task version exactly once', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-roadmap-'));
  const db = new HarnessDatabase({ databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') });
  const boss = user(db, 'boss', 'admin');
  const employee = user(db, 'employee');
  const project = db.createProject({ userId: boss.id, slug: 'three-step', name: 'Three step' });
  const access = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'employee'), branchName: 'portal/share/employee',
  });
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Three steps', status: 'ready',
    steps: ['First', 'Second', 'Third'].map((title) => ({ assigneeUserId: employee.id, title, acceptance: `${title} done` })),
  });
  db.activateRoadmap(roadmap.id);

  const submit = (task, suffix) => {
    const chat = db.createChat({
      projectId: project.id, userId: employee.id, projectAccessId: access.id, treePath: access.treePath,
      taskId: task.id, taskVersion: task.version, title: `Task ${suffix}`,
    });
    const run = db.createTurnRun({ chat, project: db.getProjectForUser(project.id, employee.id), userId: employee.id, mode: 'edit' });
    db.updateTurnRun(run.id, {
      status: 'completed', codexThreadId: `thread-${suffix}`, codexTurnId: `turn-${suffix}`,
      finalItemId: `item-${suffix}`, finalReplySnapshot: `Finished ${suffix}`, completedAt: new Date().toISOString(),
    });
    return db.submitTask({
      taskId: task.id, taskVersion: task.version, submitterUserId: employee.id,
      projectAccessId: access.id, chatId: chat.id, turnRunId: run.id, itemId: `item-${suffix}`,
      snapshotCommitSha: SNAPSHOT_COMMIT, snapshotTreeSha: SNAPSHOT_TREE,
    });
  };

  let steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['active', 'ready', 'ready']);
  const firstSubmission = submit(steps[0], 'first-v1');
  db.reviewSubmission({ submissionId: firstSubmission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT });
  assert.throws(() => db.reviewSubmission({ submissionId: firstSubmission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT }), /待审核提交不存在/);
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'active', 'ready']);

  const secondSubmission = submit(steps[1], 'second-v1');
  db.reviewSubmission({ submissionId: secondSubmission.id, verdict: 'rework' });
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'rework', 'ready']);
  assert.equal(steps[1].version, 2);
  assert.equal(db.getRoadmap(roadmap.id).version, 2);

  const reworkSubmission = submit(steps[1], 'second-v2');
  db.reviewSubmission({ submissionId: reworkSubmission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT });
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'passed', 'active']);

  const thirdSubmission = submit(steps[2], 'third-v1');
  db.reviewSubmission({ submissionId: thirdSubmission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT });
  assert.deepEqual(db.getRoadmap(roadmap.id).steps.map((task) => task.status), ['passed', 'passed', 'passed']);
  assert.equal(db.getRoadmap(roadmap.id).status, 'passed');
  assert.throws(() => db.reviewSubmission({ submissionId: thirdSubmission.id, verdict: 'invalid' }), /审核结果无效/);
  db.close();
});

test('roadmap activation and advancement stop when the employee project ACL is revoked', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-roadmap-acl-'));
  const db = new HarnessDatabase({ databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') });
  const boss = user(db, 'boss', 'admin');
  const employee = user(db, 'employee');
  const project = db.createProject({ userId: boss.id, slug: 'acl-roadmap', name: 'ACL roadmap' });
  let access = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'employee-1'), branchName: 'portal/share/employee-1',
  });
  const blocked = db.createRoadmap({
    projectId: project.id, title: 'Blocked activation', status: 'ready',
    steps: [{ assigneeUserId: employee.id, title: 'First', acceptance: 'Done' }],
  });
  db.revokeProjectAccess(access.id);
  assert.throws(() => db.activateRoadmap(blocked.id), /项目授权已失效/);
  assert.equal(db.getRoadmap(blocked.id).status, 'ready');

  access = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'employee-2'), branchName: 'portal/share/employee-2',
  });
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Blocked advancement', status: 'ready',
    steps: ['First', 'Second'].map((title) => ({ assigneeUserId: employee.id, title, acceptance: 'Done' })),
  });
  const first = db.activateRoadmap(roadmap.id).steps[0];
  const chat = db.createChat({
    projectId: project.id, userId: employee.id, projectAccessId: access.id, treePath: access.treePath,
    taskId: first.id, taskVersion: first.version, title: 'ACL task',
  });
  const run = db.createTurnRun({ chat, project: db.getProjectForUser(project.id, employee.id), userId: employee.id, mode: 'edit' });
  db.updateTurnRun(run.id, {
    status: 'completed', codexThreadId: 'acl-thread', codexTurnId: 'acl-turn', finalItemId: 'acl-final',
    finalReplySnapshot: 'Done', completedAt: new Date().toISOString(),
  });
  const submission = db.submitTask({
    taskId: first.id, taskVersion: first.version, submitterUserId: employee.id,
    projectAccessId: access.id, chatId: chat.id, turnRunId: run.id, itemId: 'acl-final',
    snapshotCommitSha: SNAPSHOT_COMMIT, snapshotTreeSha: SNAPSHOT_TREE,
  });
  db.revokeProjectAccess(access.id);
  assert.throws(() => db.reviewSubmission({ submissionId: submission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT }), /不能审核或自动推进/);
  assert.equal(db.getSubmission(submission.id).verdict, 'pending');
  assert.deepEqual(db.getRoadmap(roadmap.id).steps.map((task) => task.status), ['submitted', 'ready']);
  db.close();
});

test('review cannot pass a revoked current assignee even when the next assignee remains active', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-roadmap-current-acl-'));
  const db = new HarnessDatabase({ databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') });
  const boss = user(db, 'current-acl-boss', 'admin');
  const currentEmployee = user(db, 'current-assignee');
  const nextEmployee = user(db, 'next-assignee');
  const project = db.createProject({ userId: boss.id, slug: 'current-acl', name: 'Current ACL' });
  const currentAccess = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: currentEmployee.id,
    treePath: path.join(base, 'trees', 'current'), branchName: 'portal/share/current',
  });
  db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: nextEmployee.id,
    treePath: path.join(base, 'trees', 'next'), branchName: 'portal/share/next',
  });
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Distinct assignees', status: 'ready',
    steps: [
      { assigneeUserId: currentEmployee.id, title: 'Current', acceptance: 'Done' },
      { assigneeUserId: nextEmployee.id, title: 'Next', acceptance: 'Done' },
    ],
  });
  const current = db.activateRoadmap(roadmap.id).steps[0];
  const chat = db.createChat({
    projectId: project.id, userId: currentEmployee.id, projectAccessId: currentAccess.id,
    treePath: currentAccess.treePath, taskId: current.id, taskVersion: current.version, title: 'Current task',
  });
  const run = db.createTurnRun({
    chat, project: db.getProjectForUser(project.id, currentEmployee.id), userId: currentEmployee.id, mode: 'edit',
  });
  db.updateTurnRun(run.id, {
    status: 'completed', codexThreadId: 'current-thread', codexTurnId: 'current-turn',
    finalItemId: 'current-final', finalReplySnapshot: 'Done', completedAt: new Date().toISOString(),
  });
  const submission = db.submitTask({
    taskId: current.id, taskVersion: current.version, submitterUserId: currentEmployee.id,
    projectAccessId: currentAccess.id, chatId: chat.id, turnRunId: run.id, itemId: 'current-final',
    snapshotCommitSha: SNAPSHOT_COMMIT, snapshotTreeSha: SNAPSHOT_TREE,
  });
  db.revokeProjectAccess(currentAccess.id);

  assert.throws(() => db.reviewSubmission({ submissionId: submission.id, verdict: 'passed', deliveryCommitSha: DELIVERY_COMMIT }), /当前任务员工.*不能审核或自动推进/);
  assert.equal(db.getSubmission(submission.id).verdict, 'pending');
  assert.deepEqual(db.getRoadmap(roadmap.id).steps.map((task) => task.status), ['submitted', 'ready']);
  db.close();
});

test('startup repairs an orphaned submitted task exactly once', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-orphan-'));
  const config = { databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') };
  let db = new HarnessDatabase(config);
  const boss = user(db, 'boss', 'admin');
  const employee = user(db, 'employee');
  const project = db.createProject({ userId: boss.id, slug: 'orphan', name: 'Orphan' });
  db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'tree'), branchName: 'portal/share/orphan',
  });
  const roadmap = db.createRoadmap({
    projectId: project.id, title: 'Repair', status: 'ready',
    steps: [{ assigneeUserId: employee.id, title: 'Lost submission', acceptance: 'Evidence exists' }],
  });
  const task = db.activateRoadmap(roadmap.id).steps[0];
  db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
  db.db.prepare("UPDATE roadmaps SET status='submitted' WHERE id=?").run(roadmap.id);
  db.db.prepare("DELETE FROM schema_migrations WHERE name='repair_orphaned_submissions_v1'").run();
  db.close();

  db = new HarnessDatabase(config);
  const repaired = db.getTask(task.id);
  assert.equal(repaired.status, 'rework');
  assert.equal(repaired.version, 2);
  assert.equal(db.getRoadmap(roadmap.id).version, 2);
  assert.equal(db.listAudit().filter((entry) => entry.action === 'task.submission_orphan_repaired').length, 1);
  db.close();

  db = new HarnessDatabase(config);
  assert.equal(db.getTask(task.id).version, 2);
  assert.equal(db.getRoadmap(roadmap.id).version, 2);
  db.close();
});

test('runtime guards cover queued, starting, running, approval, and lease state at every lifecycle scope', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-runtime-guard-'));
  const db = new HarnessDatabase({ databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') });
  const boss = user(db, 'runtime-boss', 'admin');
  const employee = user(db, 'runtime-employee');
  const project = db.createProject({ userId: boss.id, slug: 'runtime-guard', name: 'Runtime guard' });
  const access = db.grantProjectAccess({
    id: randomUUID(), projectId: project.id, userId: employee.id,
    treePath: path.join(base, 'trees', 'employee'), branchName: 'portal/share/runtime-employee',
  });
  const sharedProject = db.getProjectForUser(project.id, employee.id);
  const chat = db.createChat({
    projectId: project.id, userId: employee.id, projectAccessId: access.id,
    treePath: access.treePath, title: 'Guarded chat',
  });
  const scopes = () => [db.runtimeForChat(chat.id), db.runtimeForAccess(access.id), db.runtimeForProject(project.id)];

  for (const status of ['queued', 'starting', 'running']) {
    const run = db.createTurnRun({ chat, project: sharedProject, userId: employee.id, mode: 'edit' });
    db.updateTurnRun(run.id, { status });
    for (const runtime of scopes()) {
      assert.equal(runtime.busy, true, `${status} must make the lifecycle scope busy`);
      assert.equal(runtime.turnBusy, true);
    }
    assert.throws(() => db.deleteChat(chat.id), /排队或运行/);
    db.updateTurnRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
  }

  const approvalRun = db.createTurnRun({ chat, project: sharedProject, userId: employee.id, mode: 'edit' });
  db.updateTurnRun(approvalRun.id, { status: 'completed', completedAt: new Date().toISOString() });
  db.createApproval({
    id: 'runtime-approval', turnRunId: approvalRun.id, chatId: chat.id,
    userId: employee.id, kind: 'command', request: { command: 'pwd' },
  });
  for (const runtime of scopes()) {
    assert.equal(runtime.busy, true);
    assert.equal(runtime.approvalBusy, true);
  }
  assert.throws(() => db.deleteChat(chat.id), /排队或运行/);
  db.resolveApproval('runtime-approval', 'cancelled');

  const leaseRun = db.createTurnRun({ chat, project: sharedProject, userId: employee.id, mode: 'execute' });
  db.updateTurnRun(leaseRun.id, { status: 'completed', completedAt: new Date().toISOString() });
  db.createExecutionLease({
    turnRunId: leaseRun.id, userId: employee.id, chatId: chat.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  for (const runtime of scopes()) {
    assert.equal(runtime.busy, true);
    assert.equal(runtime.leaseBusy, true);
  }
  assert.throws(() => db.deleteChat(chat.id), /排队或运行/);
  db.deleteExecutionLease(leaseRun.id);

  assert.deepEqual(scopes().map((runtime) => runtime.busy), [false, false, false]);
  db.deleteChat(chat.id);
  assert.equal(db.getChat(chat.id), null);
  db.close();
});
