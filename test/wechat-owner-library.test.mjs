import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { InputQueueService } from '../src/input-queue-service.mjs';
import { acceptInstruction, reviewDesktopInstruction } from '../src/wechat-task-instructions.mjs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';
import { answerLibrary, parseLibraryCommand } from '../src/wechat-owner-library.mjs';

test('signed boss library isolates private data, desktop identities, employee projects and replay', async t => {
  const root = fs.realpathSync(fs.mkdtempSync('/private/tmp/wechat-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'portal');
  const home = path.join(root, 'mac');
  t.mock.method(os, 'homedir', () => home);
  fs.mkdirSync(dataDir);
  const dir = path.join(home, '.codex');
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  const files = path.join(root, 'Desktop project');
  fs.mkdirSync(files);
  fs.writeFileSync(path.join(files, 'own file.txt'), 'desktop text');
  fs.writeFileSync(path.join(files, '.env'), 'hidden');
  fs.symlinkSync(dataDir, path.join(files, 'link'));
  const config = { dataDir, workspacesRoot: path.join(dataDir, 'workspaces'), databasePath: path.join(dataDir, 'test.sqlite'),
    wechatChannelEnabled: true, wechatChannelSenderId: 'sender' };
  const db = new HarnessDatabase(config);
  t.after(() => db.close());
  function user(username, role) {
    return db.createUser({ username, displayName: username, passwordHash: 'fixture', role, networkAccess: true,
      maxProjects: 10, maxStorageBytes: 100000, maxConcurrentTurns: 1 });
  }
  const owner = user('boss', 'admin'), employee = user('staff', 'user');
  const project = db.createProject({ userId: owner.id, slug: 'hub', name: 'Inbox' });
  const priv = db.createProject({ userId: owner.id, slug: 'private', name: 'Private project', projectType: 'local_private' });
  const foreign = db.createProject({ userId: employee.id, slug: 'foreign', name: 'Employee project' });
  db.grantProjectAccess({ projectId: foreign.id, userId: owner.id, treePath: path.join(root, 'shared'), branchName: 'shared' });
  config.wechatChannelProjectId = project.id;
  const chat = p => db.createChat({ projectId: p.id, userId: p.userId, projectAccessId: p.accessId, treePath: p.treePath, title: 'Fixture' });
  const binding = db.createChannelBinding({ channel: 'wechat', externalScopeId: 'sender', userId: owner.id, projectId: project.id, chatId: chat(project).id });
  const personal = chat(priv), other = chat(foreign);
  db.addMessage({ chatId: personal.id, role: 'user', content: 'private ' + '字'.repeat(1600) });
  const workspace = { readFile: ({ id }) => { assert.equal(id, priv.id); return { content: 'local body' }; } };
  const context = { config, db, workspace, owner, project, binding, secret: Buffer.alloc(32, 1), senderId: 'sender', externalScopeId: 'sender' };
  const ask = (text, eventId = randomUUID(), overrides = {}) => answerLibrary({ ...context, text, eventId, ...overrides }, parseLibraryCommand(text));
  const uid = randomUUID();
  const account = randomUUID();
  const desktop = new DatabaseSync(path.join(dir, 'state_5.sqlite'));
  desktop.exec('CREATE TABLE projects(id,name); CREATE TABLE project_roots(project_id,path); CREATE TABLE threads(id,name,title,cwd,source,originator,creator_user_id,creator_account_id,rollout_path,updated_at)');
  desktop.prepare('INSERT INTO projects VALUES(?,?)').run('project', 'Mac work');
  desktop.prepare('INSERT INTO project_roots VALUES(?,?)').run('project', files);
  function thread(title, author, cwd) {
    const id = randomUUID();
    const rollout = path.join(dir, 'sessions', 'rollout-' + id + '.jsonl');
    const meta = { id, cwd, source: 'vscode', originator: 'Codex Desktop', creator_user_id: author, creator_account_id: account };
    const records = [
      { type: 'session_meta', payload: meta },
      { type: 'response_item', payload: { role: 'developer', content: 'hidden system' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'personal message' }] } } },
    ];
    fs.writeFileSync(rollout, records.map(r => JSON.stringify(r)).join('\n'));
    desktop.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, null, title, cwd, 'vscode', 'Codex Desktop', author, account, rollout, 0);
    return id;
  }
  const mine = thread('Mine', uid, files), theirs = thread('Other account', 'other', files);
  thread('Portal worktree', uid, dataDir);
  thread('No owner', null, files);
  desktop.close();
  const st = fs.statSync(files);
  fs.writeFileSync(path.join(dataDir, 'wechat-owner-library.json'), JSON.stringify({ ownerId: owner.id, creatorUser: uid, creatorAccount: account,
    projects: [{ id: 'project', key: 'd-project', path: files, device: st.dev, inode: st.ino }] }), { mode: 0o600 });
  assert.match((await ask('/projects')).text, /Private project/u);
  assert.doesNotMatch((await ask('/projects')).text, /Employee project/u);
  assert.equal((await ask('/file ' + priv.id + ' note.txt', 'repeat')).text, 'local body');
  assert.doesNotMatch(db.getChannelEvent('wechat', 'repeat').responseText, /local body|note.txt/u);
  assert.equal((await ask('/file ' + priv.id + ' note.txt', 'repeat')).duplicate, true);
  await assert.rejects(ask('/projects', 'repeat'));
  await assert.rejects(ask('/projects', 'other-scope', { externalScopeId: 'other' }));
  assert.match((await ask('/file ' + foreign.id + ' x')).text, /不可用/u);
  assert.match((await ask('/chat ' + other.id)).text, /不可用/u);
  assert.match((await ask('/chat ' + personal.id)).text, /private.*下一页/su);
  assert.match((await ask('/chat @2 ' + personal.id)).text, /^字+/u);
  assert.match((await ask('/desktop')).text, /Mac work d-project/u);
  assert.equal((await ask('/file d-project own file.txt')).text, 'desktop text');
  assert.match((await ask('/files d-project')).text, /own file.txt/u);
  for (const relative of ['.env', 'link/test.sqlite', '../portal/test.sqlite']) {
    assert.match((await ask('/file d-project ' + relative)).text, /不可用/u);
  }
  const list = (await ask('/chats desktop')).text;
  assert.match(list, /Mine d-/u);
  assert.doesNotMatch(list, /Other account|Portal worktree|No owner/u);
  assert.match((await ask('/chat d-' + theirs)).text, /不可用/u);
  assert.equal((await ask('/chat d-' + mine)).text.trim(), '老板：personal message');
  const queue = new InputQueueService({ db, config, sharingAccesses: new Set(), recoveringChats: new Set() });
  const tell = (target, prompt, eventId = randomUUID(), overrides = {}) => {
    const text = '/tell ' + target + ' ' + prompt;
    return acceptInstruction({ ...context, text, eventId, inputQueue: queue, ...overrides }, parseLibraryCommand(text));
  };
  const portalReceipt = await tell(personal.id, 'fixture input', 'portal-input');
  assert.equal(portalReceipt.duplicate, false);
  assert.equal((await tell(personal.id, 'fixture input', 'portal-input')).duplicate, true);
  assert.equal(db.listChatInputs(personal.id).length, 1);
  assert.equal(db.listChatInputs(personal.id)[0].prompt, 'fixture input');
  assert.doesNotMatch(db.getChannelEvent('wechat', 'portal-input').responseText, /fixture input/u);
  await assert.rejects(tell(personal.id, 'different', 'portal-input'));
  await assert.rejects(tell(other.id, 'denied'));
  await assert.rejects(tell(personal.id, 'denied', 'bad-scope', { senderId: 'other' }));
  await assert.rejects(tell('d-' + theirs, 'denied'));
  assert.equal(db.listChatInputs(other.id).length, 0);

  const staged = await tell('d-' + mine, 'desktop fixture', 'desktop-input');
  const id = db.getChannelEvent('wechat', 'desktop-input').id;
  assert(staged.text.includes(id));
  assert(!staged.text.includes('desktop fixture'));
  const inspect = (send = false, extra = {}) => reviewDesktopInstruction({ db, config, authorize: () => owner, id, send, ...extra });
  const detail = await inspect();
  assert.equal(detail.status, 'pending');
  assert.equal(detail.title, 'Mine');
  assert.equal(detail.prompt, 'desktop fixture');
  await assert.rejects(inspect(false, { authorize: () => employee }));

  const control = path.join(dir, 'app-server-control');
  fs.mkdirSync(control);
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const calls = [];
  let queuedInput;
  wss.on('connection', socket => socket.on('message', frame => {
    const msg = JSON.parse(frame);
    calls.push(msg.method);
    if (msg.id === undefined) return;
    let result;
    if (msg.method === 'initialize') result = {};
    if (msg.method === 'thread/read') result = { thread: { id: mine, cwd: files, path: path.join(dir, 'sessions', 'rollout-' + mine + '.jsonl'),
      source: 'vscode', originator: 'Codex Desktop', status: { type: 'notLoaded' } } };
    if (msg.method === 'thread/queue/add') {
      queuedInput = msg.params;
      result = { queuedSubmission: { id: 'queued', ...msg.params } };
    }
    if (msg.method === 'thread/resume') result = { thread: { id: mine } };
    socket.send(JSON.stringify({ id: msg.id, result }));
  }));
  await new Promise((resolve, reject) => server.once('error', reject).listen(path.join(control, 'app-server-control.sock'), resolve));
  try {
    const results = await Promise.allSettled([inspect(true), inspect(true)]);
    assert(results.some(r => r.status === 'fulfilled' && r.value.status === 'queued'));
    assert.equal((await inspect(true)).status, 'queued');
    assert.equal(calls.filter(m => m === 'thread/queue/add').length, 1);
    assert.equal(queuedInput.threadId, mine);
    assert.equal(queuedInput.input[0].text, 'desktop fixture');
    assert.equal((await inspect()).prompt, '');
    assert.deepEqual((await tell('d-' + mine, 'desktop fixture', 'desktop-input')).text, staged.text);
  } finally { wss.close(); await new Promise(resolve => server.close(resolve)); }
  const lost = await tell('d-' + mine, 'fixture lost ack', 'desktop-timeout');
  assert(lost.ok);
  const lostId = db.getChannelEvent('wechat', 'desktop-timeout').id;
  const uncertain = await inspect(true, { id: lostId, deliver: async args => { args.claimed(); throw new Error('lost ack'); } });
  assert.equal(uncertain.status, 'uncertain');
  assert.equal((await inspect(true, { id: lostId, deliver: () => assert.fail('must not retry') })).status, 'uncertain');
  db.db.prepare("UPDATE channel_bindings SET status='revoked'").run();
  await assert.rejects(inspect());
  await assert.rejects(tell(personal.id, 'fixture input', 'portal-input'));
  await assert.rejects(ask('/file ' + priv.id + ' note.txt', 'repeat'));
});
