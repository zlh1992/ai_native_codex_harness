import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDatabase } from '../src/db.mjs';

function createUser(db) {
  return db.createUser({
    username: 'mode-user', displayName: 'Mode User', passwordHash: 'test', role: 'user', networkAccess: false,
    maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 4,
  });
}

test('legacy chats migrate to EXECUTE and each chat keeps an independent preferred mode', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-chat-mode-'));
  const config = { databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') };
  let db = new HarnessDatabase(config);
  const user = createUser(db);
  const project = db.createProject({ userId: user.id, slug: 'mode-project', name: 'Mode project' });
  const first = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'First chat',
  });
  db.db.exec('ALTER TABLE chats DROP COLUMN preferred_mode');
  db.close();

  db = new HarnessDatabase(config);
  const migrated = db.getChat(first.id);
  assert.equal(migrated.preferredMode, 'execute');
  const second = db.createChat({
    projectId: project.id, userId: user.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'Second chat',
  });
  db.updateChat(migrated.id, { preferredMode: 'edit' });
  assert.equal(db.getChat(migrated.id).preferredMode, 'edit');
  assert.equal(db.getChat(second.id).preferredMode, 'execute');
  db.close();
});

test('model preference migrates nullable, persists across reopen and stays independent', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-model-'));
  const config = { databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces') };
  let db = new HarnessDatabase(config);
  try {
    const user = createUser(db);
    const project = db.createProject({ userId: user.id, slug: 'models', name: 'Models' });
    const args = { projectId: project.id, userId: user.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'Model' };
    const first = db.createChat(args);
    db.db.exec('ALTER TABLE chats DROP COLUMN preferred_model; ALTER TABLE chats DROP COLUMN preferred_effort');
    db.close(); db = new HarnessDatabase(config);
    assert.equal(db.getChat(first.id).preferredModel, null);
    assert.equal(db.getChat(first.id).preferredEffort, null);
    const second = db.createChat(args);
    db.updateChat(first.id, { preferredModel: 'gpt-6.1-sol', preferredEffort: 'max' });
    db.close(); db = new HarnessDatabase(config);
    assert.equal(db.getChat(first.id).preferredModel, 'gpt-6.1-sol');
    assert.equal(db.getChat(second.id).preferredModel, null);
    assert.equal(db.getChat(first.id).preferredEffort, 'max');
    assert.equal(db.getChat(second.id).preferredEffort, null);
  } finally { db.close(); fs.rmSync(base, { recursive: true, force: true }); }
});
