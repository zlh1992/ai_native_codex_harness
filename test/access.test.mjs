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

test('a boss project can grant independent active access to multiple employees and restore the same access id', () => {
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
    projectId: project.id, userId: first.id, treePath: path.join(base, 'trees', randomUUID()), branchName: 'portal/share/first-duplicate',
  }), /UNIQUE constraint failed/);
  const chat = db.createChat({
    projectId: project.id, userId: first.id, projectAccessId: access.id, treePath: access.treePath, title: 'Shared task',
  });
  assert.equal(chat.projectAccessId, access.id);
  assert.equal(chat.treePath, treePath);
  const secondAccess = db.grantProjectAccess({
    projectId: project.id, userId: second.id, treePath: path.join(base, 'trees', randomUUID()), branchName: 'portal/share/second',
  });
  assert.equal(db.getProjectForUser(project.id, second.id)?.accessId, secondAccess.id);
  assert.equal(db.listAdminProjects().find((item) => item.id === project.id).sharedAccesses.length, 2);
  db.revokeProjectAccess(access.id);
  assert.equal(db.getProjectForUser(project.id, first.id), null);
  assert.equal(db.getProjectAccessById(access.id).status, 'revoked');
  assert.equal(db.latestRevokedProjectAccess(project.id, first.id).id, access.id);
  const restored = db.restoreProjectAccess(access.id);
  assert.equal(db.getProjectForUser(project.id, first.id)?.accessId, restored.id);
  db.close();
});

test('legacy revoked access for multiple employees remains restorable instead of freezing the project', () => {
  const { base, db, user } = fixture();
  const boss = user('boss', 'admin');
  const first = user('first');
  const second = user('second');
  const project = db.createProject({ userId: boss.id, slug: 'legacy-conflict', name: 'Legacy conflict' });
  const insert = db.db.prepare(`INSERT INTO project_access
    (id,project_id,user_id,access_kind,tree_path,branch_name,status,created_at,revoked_at)
    VALUES (?,?,?,'shared',?,?,'revoked',?,?)`);
  insert.run(randomUUID(), project.id, first.id, path.join(base, 'trees', 'first'), 'portal/share/first', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  insert.run(randomUUID(), project.id, second.id, path.join(base, 'trees', 'second'), 'portal/share/second', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z');

  const firstRevoked = db.latestRevokedProjectAccess(project.id, first.id);
  const secondRevoked = db.latestRevokedProjectAccess(project.id, second.id);
  assert.ok(firstRevoked);
  assert.ok(secondRevoked);
  db.restoreProjectAccess(firstRevoked.id);
  db.restoreProjectAccess(secondRevoked.id);
  const dashboardProject = db.listAdminProjects().find((item) => item.id === project.id);
  assert.deepEqual(new Set(dashboardProject.sharedAccesses.map((access) => access.userId)), new Set([first.id, second.id]));
  db.close();
});
