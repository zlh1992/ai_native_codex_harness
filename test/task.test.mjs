import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';

function user(db, username, role = 'user') {
  return db.createUser({
    username, displayName: username, passwordHash: 'test', role, networkAccess: false,
    maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 40,
  });
}

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
    turnRunId: run.id, itemId: 'item-final', note: 'Please check IDOR tests.',
  });
  assert.equal(submission.finalReplySnapshot, 'Finished and tested.');
  assert.equal(submission.diffSnapshot, 'diff --git a/a b/a');
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
      chatId: chat.id, turnRunId: run.id, itemId: `item-${suffix}`,
    });
  };

  let steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['active', 'ready', 'ready']);
  const firstSubmission = submit(steps[0], 'first-v1');
  db.reviewSubmission({ submissionId: firstSubmission.id, verdict: 'passed' });
  assert.throws(() => db.reviewSubmission({ submissionId: firstSubmission.id, verdict: 'passed' }), /待审核提交不存在/);
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'active', 'ready']);

  const secondSubmission = submit(steps[1], 'second-v1');
  db.reviewSubmission({ submissionId: secondSubmission.id, verdict: 'rework' });
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'rework', 'ready']);
  assert.equal(steps[1].version, 2);
  assert.equal(db.getRoadmap(roadmap.id).version, 2);

  const reworkSubmission = submit(steps[1], 'second-v2');
  db.reviewSubmission({ submissionId: reworkSubmission.id, verdict: 'passed' });
  steps = db.getRoadmap(roadmap.id).steps;
  assert.deepEqual(steps.map((task) => task.status), ['passed', 'passed', 'active']);

  const thirdSubmission = submit(steps[2], 'third-v1');
  db.reviewSubmission({ submissionId: thirdSubmission.id, verdict: 'passed' });
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
    chatId: chat.id, turnRunId: run.id, itemId: 'acl-final',
  });
  db.revokeProjectAccess(access.id);
  assert.throws(() => db.reviewSubmission({ submissionId: submission.id, verdict: 'passed' }), /不能自动推进/);
  assert.equal(db.getSubmission(submission.id).verdict, 'pending');
  assert.deepEqual(db.getRoadmap(roadmap.id).steps.map((task) => task.status), ['submitted', 'ready']);
  db.close();
});
