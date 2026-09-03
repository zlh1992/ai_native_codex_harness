import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-access-'));
  const config = {
    databasePath: path.join(base, 'harness.sqlite'),
    workspacesRoot: path.join(base, 'workspaces'),
  };
  const db = new HarnessDatabase(config);
  const user = (username, role = 'user') => db.createUser({
    username, displayName: username, passwordHash: 'test-only', role,
    networkAccess: false, maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2,
  });
  return { base, db, user };
}

test('boss administration role does not bypass project content ACL', () => {
  const { db, user } = fixture();
  const boss = user('boss', 'admin');
  assert.throws(() => user('second-boss', 'admin'), /只允许一个超级管理员/);
  const employee = user('employee');
  const employeeProject = db.createProject({ userId: employee.id, slug: 'employee-project', name: 'Employee project' });
  assert.equal(db.getProjectForUser(employeeProject.id, employee.id)?.accessKind, 'owner');
  assert.equal(db.getProjectForUser(employeeProject.id, boss.id), null);
  assert.equal(db.listAdminProjects().find((project) => project.id === employeeProject.id)?.username, employee.username);
  db.close();
});

test('shared access is single-seat, tree-bound and immediately revocable', () => {
  const { base, db, user } = fixture();
  const boss = user('boss', 'admin');
  const first = user('first');
  const second = user('second');
  const project = db.createProject({ userId: boss.id, slug: 'boss-project', name: 'Boss project' });
  const accessId = randomUUID();
  const treePath = path.join(base, 'trees', accessId);
  const access = db.grantProjectAccess({ id: accessId, projectId: project.id, userId: first.id, treePath, branchName: 'portal/share/test' });
  assert.equal(db.getProjectForUser(project.id, first.id)?.treePath, treePath);
  assert.equal(db.listProjectsForUser(first.id).length, 1);
  assert.throws(() => db.grantProjectAccess({
    projectId: project.id, userId: second.id, treePath: path.join(base, 'trees', randomUUID()), branchName: 'portal/share/second',
  }), /UNIQUE constraint failed/);
  const chat = db.createChat({
    projectId: project.id, userId: first.id, projectAccessId: access.id, treePath: access.treePath, title: 'Shared task',
  });
  assert.equal(chat.projectAccessId, access.id);
  assert.equal(chat.treePath, treePath);
  db.revokeProjectAccess(access.id);
  assert.equal(db.getProjectForUser(project.id, first.id), null);
  assert.equal(db.getProjectAccessById(access.id).status, 'revoked');
  db.close();
});
