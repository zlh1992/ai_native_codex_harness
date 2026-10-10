import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HarnessDatabase } from '../src/db.mjs';
import { WechatOwnerProjectTools } from '../src/wechat-owner-project-tools.mjs';
import { formatWechatModelCatalog, parseWechatCommand, resolveWechatModel } from '../src/wechat-channel-commands.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-channel-'));
  const config = {
    databasePath: path.join(root, 'harness.sqlite'),
    workspacesRoot: path.join(root, 'workspaces'),
  };
  const db = new HarnessDatabase(config);
  const user = db.createUser({ username: 'owner', displayName: 'Owner', passwordHash: 'test', role: 'admin', networkAccess: true,
    maxProjects: 10, maxStorageBytes: 1024 * 1024, maxConcurrentTurns: 2 });
  const project = db.createProject({ userId: user.id, slug: 'weichat-project', name: 'weichat-project' });
  const chat = db.createChat({ projectId: project.id, userId: user.id, projectAccessId: project.accessId, treePath: project.treePath,
    title: '微信对话', preferredMode: 'execute' });
  return { db, user, project, chat, root };
}

test('channel bindings and events are idempotent under duplicate delivery', () => {
  const f = fixture();
  try {
    const firstBinding = f.db.createChannelBinding({ channel: 'wechat', externalScopeId: 'scope-1', userId: f.user.id,
      projectId: f.project.id, chatId: f.chat.id });
    const secondBinding = f.db.createChannelBinding({ channel: 'wechat', externalScopeId: 'scope-1', userId: f.user.id,
      projectId: f.project.id, chatId: f.chat.id });
    assert.equal(firstBinding.chatId, f.chat.id);
    assert.equal(secondBinding.id, firstBinding.id);

    const firstEvent = f.db.createChannelEvent({ channel: 'wechat', externalEventId: 'event-1', externalScopeId: 'scope-1', chatId: f.chat.id });
    const secondEvent = f.db.createChannelEvent({ channel: 'wechat', externalEventId: 'event-1', externalScopeId: 'scope-1', chatId: f.chat.id });
    assert.equal(firstEvent.created, true);
    assert.equal(secondEvent.created, false);
    assert.equal(secondEvent.status, 'processing');

    const completed = f.db.completeChannelEvent('wechat', 'event-1', { responseText: 'done' });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.responseText, 'done');

    const nextChat = f.db.createChat({ projectId: f.project.id, userId: f.user.id, projectAccessId: f.project.accessId,
      treePath: f.project.treePath, title: '微信新对话', preferredMode: 'execute' });
    const rebound = f.db.rebindChannelBindingChat({ channel: 'wechat', externalScopeId: 'scope-1',
      expectedChatId: f.chat.id, chatId: nextChat.id });
    assert.equal(rebound.chatId, nextChat.id);
    assert.equal(f.db.getChannelBinding('wechat', 'scope-1').chatId, nextChat.id);
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('WeChat commands use Portal model catalog and explicit chat controls', () => {
  assert.deepEqual(parseWechatCommand('/new'), { type: 'new' });
  assert.deepEqual(parseWechatCommand(' /MODELS '), { type: 'models' });
  assert.deepEqual(parseWechatCommand('/model gpt-6-astra'), { type: 'model', value: 'gpt-6-astra' });
  assert.deepEqual(parseWechatCommand('/model'), { type: 'model', value: null });
  assert.equal(parseWechatCommand('/new please'), null);
  assert.equal(resolveWechatModel('default'), null);
  assert.equal(resolveWechatModel('gpt-6-astra'), 'gpt-6-astra');
  const text = formatWechatModelCatalog({ config: { codexModel: 'gpt-5.6-sol' }, chat: {}, user: { role: 'admin' } });
  assert.match(text, /gpt-6-astra/u);
  assert.match(text, /gpt-5\.3-codex-spark/u);
});


test('WeChat hub exposes only boss-owned standard projects through read-only tools', () => {
  const f = fixture();
  try {
    f.config = {
      wechatChannelEnabled: true,
      wechatChannelProjectId: f.project.id,
    };
    f.db.createChannelBinding({ channel: 'wechat', externalScopeId: 'boss-scope', userId: f.user.id,
      projectId: f.project.id, chatId: f.chat.id });
    const owned = f.db.createProject({ userId: f.user.id, slug: 'owned-standard', name: 'Owned standard' });
    f.db.createProject({ userId: f.user.id, slug: 'owned-private', name: 'Owned private', projectType: 'local_private' });
    const employee = f.db.createUser({ username: 'employee', displayName: 'Employee', passwordHash: 'test', role: 'user', networkAccess: false,
      maxProjects: 10, maxStorageBytes: 1024 * 1024, maxConcurrentTurns: 2 });
    const employeeProject = f.db.createProject({ userId: employee.id, slug: 'employee-project', name: 'Employee project' });
    f.db.grantProjectAccess({ projectId: employeeProject.id, userId: f.user.id,
      treePath: path.join(f.root, 'shared-employee-project'), branchName: 'shared/boss' });

    const workspace = {
      tree: (project, relative, maxDepth) => ({ projectId: project.id, path: relative, maxDepth, entries: [] }),
      readFile: (project, relative) => ({ projectId: project.id, path: relative, content: 'owned content', size: 13 }),
    };
    const tools = new WechatOwnerProjectTools({ config: f.config, db: f.db, workspace });
    const active = { user: f.user, project: f.project, chat: f.chat };
    assert.equal(tools.toolsFor(active).length, 4);

    const listed = tools.call(active, 'owner_projects_list');
    assert.deepEqual(new Set(listed.projects.map((project) => project.id)), new Set([f.project.id, owned.id]));
    assert.equal(listed.projects.some((project) => 'treePath' in project || 'accessId' in project), false);

    assert.equal(tools.call(active, 'owner_project_read_file', { project_id: owned.id, path: 'README.md' }).content, 'owned content');
    assert.throws(() => tools.call(active, 'owner_project_read_file', { project_id: employeeProject.id, path: 'README.md' }),
      (error) => error.code === 'OWNER_PROJECT_FORBIDDEN');
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('ordinary chats cannot activate WeChat boss project tools', () => {
  const f = fixture();
  try {
    const tools = new WechatOwnerProjectTools({
      config: { wechatChannelEnabled: true, wechatChannelProjectId: f.project.id },
      db: f.db,
      workspace: {},
    });
    assert.deepEqual(tools.toolsFor({ user: f.user, project: f.project, chat: f.chat }), []);
  } finally {
    f.db.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
