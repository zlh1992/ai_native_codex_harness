import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { WorktreeService } from '../src/worktree-service.mjs';
import { WorkGraphStore } from '../src/work-graph-store.mjs';
import { WorkGraphService } from '../src/work-graph-service.mjs';
import { ProjectShareService } from '../src/project-share-service.mjs';
import { TaskMaterials } from '../src/task-materials.mjs';
import { TaskDispatchService } from '../src/task-dispatch-service.mjs';
import { DispatchRuntime } from '../src/dispatch-runtime.mjs';
import { WeixinService } from '../src/weixin-service.mjs';
import { toolImageContent } from '../src/raster-image.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=', 'base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dispatch-'));
  const config = { dataDir: root, databasePath: path.join(root, 'db.sqlite'), workspacesRoot: path.join(root, 'workspaces'),
    treesRoot: path.join(root, 'trees'), fileMaxBytes: 1024 * 1024, uploadMaxBytes: 50 * 1024 * 1024, taskDispatchEnabled: true };
  const db = new HarnessDatabase(config); t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const create = (username, role = 'user') => db.createUser({ username, displayName: username, passwordHash: 'synthetic', role,
    maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2, networkAccess: false });
  const boss = create('boss', 'admin'), employee = create('alice'), other = create('bob');
  const project = db.createProject({ userId: boss.id, slug: 'source', name: 'source' });
  const workspace = new WorkspaceService(config); workspace.createProject(project);
  const worktrees = new WorktreeService(config), store = new WorkGraphStore(db);
  const busy = new Set(); const codex = { workspaceBusy: id => busy.has(id), sharingAccesses: busy };
  const f = { config, db, boss, employee, other, project, workspace, worktrees, store, codex, busy };
  f.materials = new TaskMaterials(f); store.materials = f.materials;
  workspace.extraUsage = id => db.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM task_materials WHERE owner_id=?').get(id).n;
  f.service = new TaskDispatchService(f); store.onEvent = e => f.service.graphEvent(e);
  f.graphs = new WorkGraphService(f); f.shares = new ProjectShareService(f);
  f.chat = db.createChat({ projectId: project.id, userId: boss.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'Boss chat' });
  f.upload = (name = 'project.zip', bytes = Buffer.from('PK\x03\x04synthetic opaque ZIP')) => f.materials.storeFile({ userId: boss.id,
    projectId: project.id, chatId: f.chat.id, name, bytes, idempotencyKey: randomUUID() });
  f.request = (attachmentIds = []) => ({ projectId: project.id, chatId: f.chat.id, title: 'Prepare proposal',
    acceptance: 'Deliver a documented proposal.', assigneeUserId: employee.id, attachmentIds, idempotencyKey: randomUUID() });
  f.execute = () => {
    let job;
    while ((job = store.claimJob())) {
      const result = job.type === 'dispatch.prepare' ? f.service.prepare(job)
        : job.type === 'share.prepare' ? f.shares.prepareWorkflow(job) : f.graphs.reconcile(job.runId, job.generation);
      store.finishJob(job.id, job.leaseToken, result);
    }
  };
  return f;
}

function weixinFixture(t) {
  const f = fixture(t); f.config.weixinEnabled = true; f.config.employeePublicOrigin = 'https://employee.example.test';
  f.db.updateUser(f.boss.id, { networkAccess: true }); f.db.updateUser(f.employee.id, { networkAccess: true });
  const calls = []; let messages = [], failSend = false;
  const transport = { request: async (op, input) => {
    calls.push({ op, input });
    if (op === 'qr') return { qrcode: 'synthetic', qrcode_img_content: 'synthetic-test-code' };
    if (op === 'qrStatus') return { status: 'confirmed', ilink_bot_id: 'test-account', bot_token: 'synthetic-token', ilink_user_id: 'test-sender', baseurl: 'https://ilinkai.weixin.qq.com' };
    if (op === 'poll') return { ret: 0, msgs: messages, get_updates_buf: 'cursor' };
    if (op === 'download') return { bytes: (input.file.kind === 'image' ? png : Buffer.from(input.file.fixture)).toString('base64') };
    if (op === 'send') { if (failSend) throw new Error('uncertain fixture'); return { ret: 0 }; }
  }, stop() {} };
  f.codex.interrupt = async () => {};
  const wx = new WeixinService({ ...f, dispatch: f.service, relayFactory: () => transport }); t.after(() => wx.stop());
  f.bind = async () => {
    const result = wx.bind(f.boss.id, f.project.id), id = result.connection.id;
    for (let i = 0; i < 100 && wx.connection(id).status === 'pending'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(wx.connection(id).status, 'active'); return wx.connection(id);
  };
  Object.assign(f, { wx, calls, setMessages: value => { messages = value; }, failSend: () => { failSend = true; } });
  f.message = (id, itemList) => ({ message_id: id, from_user_id: 'test-sender', message_type: 1, context_token: 'synthetic-context', item_list: itemList });
  return f;
}

test('independent Weixin binding receives file-only messages in order, deduplicates, and never dispatches on upload', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.setMessages([f.message('file-1', [{ type: 4, file_item: { file_name: 'brief.txt', len: '5', fixture: 'brief' } }]),
    f.message('file-2', [{ type: 4, file_item: { file_name: 'source.zip', len: '3', fixture: 'ZIP' } }]),
    { ...f.message('intruder', [{ type: 4 }]), from_user_id: 'wrong-sender' }]);
  await f.wx.poll(row); await f.wx.poll(row);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM weixin_inbox').get().n, 2);
  await f.wx.process(row); await f.wx.process(f.wx.connection(row.id));
  const received = f.materials.list(f.boss.id, f.project.id);
  assert.equal(received.length, 2); assert.ok(received.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(f.store.runs().length, 0); assert.equal(f.calls.filter(c => c.op === 'download').length, 2);
  await f.wx.deliver(f.wx.connection(row.id));
  assert.match(f.calls.find(c => c.op === 'send').input.text, /尚未派发/);
  assert.throws(() => f.store.assertNotWeixinInbox(f.project.id), { code: 'WEIXIN_INBOX_PRIVATE' });
});

test('Weixin revoke during download prevents persistence and late replies; banned employees cannot bind', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.db.updateUser(f.employee.id, { networkAccess: false });
  const ep = f.db.createProject({ userId: f.employee.id, name: 'employee', slug: 'employee' }); f.workspace.createProject(ep);
  assert.throws(() => f.wx.bind(f.employee.id, ep.id), { code: 'WEIXIN_NETWORK_DISABLED' });
  const relay = f.wx.relay(row), original = relay.request;
  relay.request = async (op, input) => { const result = await original(op, input); if (op === 'download') f.wx.revoke(f.boss.id); return result; };
  f.setMessages([f.message('file-revoked', [{ type: 4, file_item: { file_name: 'brief.txt', len: '5', fixture: 'brief' } }])]);
  await f.wx.poll(row); await f.wx.process(row);
  assert.equal(f.materials.list(f.boss.id, f.project.id).length, 0);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM weixin_outbox').get().n, 0);
  assert.equal(f.calls.filter(c => c.op === 'send').length, 0);
});

test('ordinary Weixin images become immutable materials, stay private and resolve employees by username', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.db.updateUser(f.employee.id, { displayName: 'Different display name' });
  f.setMessages([f.message('photo', [{ type: 2, image_item: { media: { full_url: 'https://novac2c.cdn.weixin.qq.com/fixture' } } }])]);
  await f.wx.poll(row); await f.wx.process(row); await f.wx.poll(row); await f.wx.process(row);
  const chat = f.db.getChat(f.wx.connection(row.id).chat_id);
  const active = { chat, user: f.db.getUserById(f.boss.id), project: f.project, threadId: 'root' }, runtime = new DispatchRuntime(f);
  const context = await runtime.call(active, 'dispatch_context', {}, 'root');
  assert.equal(context.employees.find(e => e.username === 'alice').name, 'Different display name');
  assert.equal(context.materials.length, 1); assert.equal(context.materials[0].name, '微信图片-1.png');
  assert.equal(f.store.runs().length, 0);
  const output = await runtime.call(active, 'dispatch_read_material', { attachmentId: context.materials[0].id }, 'root');
  assert.equal(toolImageContent(output).imageUrl, `data:image/png;base64,${png.toString('base64')}`);
  assert.ok(!JSON.stringify(output).includes(png.toString('base64')));
  await assert.rejects(runtime.call({ ...active, user: f.other }, 'dispatch_read_material', { attachmentId: output.id }, 'root'), { code: 'DISPATCH_ROOT_REQUIRED' });
  const request = { ...f.request([output.id]), chatId: chat.id };
  const receipt = f.service.request(f.boss.id, request); f.execute();
  const task = f.service.receipt(receipt.id, f.boss.id).tasks[0];
  assert.deepEqual(f.materials.readTask(task.id, f.employee.id, output.id).bytes, png);
  assert.throws(() => f.materials.readTask(task.id, f.other.id, output.id), { code: 'PROJECT_ACCESS_REVOKED' });
});

test('uncertain Weixin send remains distinct from unread and is not automatically resent', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.setMessages([f.message('hello', [])]); await f.wx.poll(row); await f.wx.process(row);
  f.failSend(); await f.wx.deliver(f.wx.connection(row.id)); await f.wx.deliver(f.wx.connection(row.id));
  assert.equal(f.calls.filter(c => c.op === 'send').length, 1);
  assert.equal(f.db.db.prepare('SELECT status FROM weixin_outbox').get().status, 'uncertain');
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM task_notifications').get().n, 0);
});

test('explicit Weixin task switch verifies assignee, confirms context and does not run a model', async t => {
  const f = weixinFixture(t), row = await f.bind();
  const receipt = f.service.request(f.boss.id, f.request([f.upload().id])); f.execute();
  const task = f.db.getTask(f.service.receipt(receipt.id, f.boss.id).tasks[0].id);
  const ep = f.db.createProject({ userId: f.employee.id, name: 'employee', slug: 'employee' }); f.workspace.createProject(ep);
  f.wx.revoke(f.boss.id); const result = f.wx.bind(f.employee.id, ep.id);
  for (let i = 0; i < 100 && f.wx.connection(result.connection.id).status === 'pending'; i++) await new Promise(r => setTimeout(r, 5));
  const staff = f.wx.connection(result.connection.id); assert.equal(staff.status, 'active');
  let runs = 0; f.codex.runTurn = async () => { runs++; };
  f.setMessages([f.message('task-switch', [{ type: 1, text_item: { text: `处理任务 ${task.id}` } }])]);
  await f.wx.poll(staff); await f.wx.process(staff);
  assert.equal(f.db.getChat(f.wx.connection(staff.id).chat_id).taskId, task.id); assert.equal(runs, 0);
  assert.equal(f.materials.notifications(f.employee.id)[0].readAt, null);
});

test('dispatch snapshots inputs, shares only the new batch and recovers without duplicate projects/tasks', t => {
  const f = fixture(t); const file = f.upload();
  f.workspace.writeFile(f.project, 'private-notes.txt', 'Do not share inbox contents');
  const body = f.request([file.id]); const accepted = f.service.request(f.boss.id, body);
  assert.equal(accepted.status, 'accepted'); assert.equal(f.store.runs().length, 0);
  f.busy.add(f.project.accessId); const job = f.store.claimJob();
  assert.throws(() => f.service.prepare(job), { code: 'WORKSPACE_BUSY' });
  f.busy.clear(); f.service.prepare(job); f.service.prepare(job); f.store.finishJob(job.id, job.leaseToken);
  f.execute();
  const receipt = f.service.receipt(accepted.id, f.boss.id);
  assert.equal(receipt.status, 'published'); assert.equal(receipt.tasks.length, 1);
  assert.equal(f.service.request(f.boss.id, body).id, accepted.id);
  const target = f.db.getProjectForUser(receipt.projectId, f.employee.id);
  assert.ok(target); assert.notEqual(target.id, f.project.id);
  assert.equal(f.db.getProjectForUser(f.project.id, f.employee.id), null);
  assert.throws(() => f.workspace.readFile(target, 'private-notes.txt'), { code: 'PATH_NOT_FOUND' });
  const task = f.db.getTask(receipt.tasks[0].id);
  assert.equal(task.status, 'active'); assert.deepEqual(task.inputManifest, []);
  assert.deepEqual(f.materials.readTask(task.id, f.employee.id, file.id).bytes, Buffer.from('PK\x03\x04synthetic opaque ZIP'));
  assert.throws(() => f.materials.readTask(task.id, f.other.id, file.id), { code: 'PROJECT_ACCESS_REVOKED' });
  assert.equal(f.materials.notifications(f.employee.id).length, 1);
  assert.equal(f.db.listProjectsForUser(f.boss.id).length, 2);
});

test('material source changes and account policy changes prevent dispatch before sharing', t => {
  const f = fixture(t); f.workspace.writeFile(f.project, 'brief.md', 'original');
  const file = f.materials.capture({ userId: f.boss.id, projectId: f.project.id, relative: 'brief.md', idempotencyKey: randomUUID() });
  const receipt = f.service.request(f.boss.id, f.request([file.id]));
  f.workspace.writeFile(f.project, 'brief.md', 'changed');
  assert.throws(() => f.service.prepare(f.store.claimJob()), { code: 'MATERIAL_SOURCE_CHANGED' });
  assert.equal(f.service.receipt(receipt.id, f.boss.id).projectId, null);
  assert.equal(f.db.listProjectsForUser(f.employee.id).length, 0);
});

test('supplements are versioned, scoped, idempotent and reject submitted tasks and overwrites', t => {
  const f = fixture(t); const first = f.upload('first.txt', Buffer.from('first'));
  const receipt = f.service.request(f.boss.id, f.request([first.id])); f.execute();
  const published = f.service.receipt(receipt.id, f.boss.id), task = f.db.getTask(published.tasks[0].id);
  const second = f.upload('second.txt', Buffer.from('second'));
  const append = { attachmentIds: [second.id], expectedRevision: 1, taskVersion: task.version, idempotencyKey: randomUUID() };
  assert.equal(f.materials.append(task.id, f.boss.id, append).revision, 2);
  assert.equal(f.materials.append(task.id, f.boss.id, append).revision, 2);
  assert.equal(f.materials.current(task.id, 1).files.length, 1);
  assert.throws(() => f.materials.readTask(task.id, f.employee.id, second.id, 1), { code: 'MATERIAL_NOT_FOUND' });
  const target = f.db.getProjectForUser(task.projectId, f.employee.id);
  f.workspace.writeFile(target, second.path, 'employee work');
  assert.throws(() => f.materials.importFiles(target, [second]), { code: 'MATERIAL_PATH_CONFLICT' });
  f.db.db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(task.id);
  assert.throws(() => f.materials.append(task.id, f.boss.id, { ...append, idempotencyKey: randomUUID() }), { code: 'TASK_VERSION_CHANGED' });
  assert.equal(f.workspace.readFile(target, second.path).content, 'employee work');
});

test('dispatch history is limited to current chat and dispatch tools reject employee and child agents', async t => {
  const f = fixture(t); const runtime = new DispatchRuntime(f);
  f.db.addMessage({ chatId: f.chat.id, role: 'assistant', content: 'The selected source is brief.md.' });
  const active = { chat: f.chat, user: f.boss, project: f.project, threadId: 'root' };
  assert.match((await runtime.call(active, 'dispatch_history', {}, 'root')).messages[0].content, /brief/);
  await assert.rejects(runtime.call(active, 'dispatch_context', {}, 'child'), { code: 'DISPATCH_ROOT_REQUIRED' });
  await assert.rejects(runtime.call({ ...active, user: f.employee }, 'dispatch_context', {}, 'root'), { code: 'DISPATCH_ROOT_REQUIRED' });
  for (const name of ['../x.zip', '.git', 'x/y', 'x\u0000.zip']) assert.throws(() => f.upload(name), e => ['INVALID_MATERIAL_NAME', 'INVALID_GRAPH_PATH'].includes(e.code));
});


test('Weixin pilot and expired Web authorization cannot create a late binding', async t => {
  const f = weixinFixture(t);
  f.config.weixinPilotUserIds = [f.employee.id];
  assert.throws(() => f.wx.bind(f.boss.id, f.project.id), { code: 'WEIXIN_DISABLED' });
  assert.equal(f.wx.current(f.boss.id), undefined);
  f.config.weixinPilotUserIds = [f.boss.id];
  let checks = 0;
  const result = f.wx.bind(f.boss.id, f.project.id, () => { if (++checks > 1) throw new Error('session logged out'); });
  for (let i = 0; i < 100 && f.wx.logins.size; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(f.wx.public(f.boss.id).connection.status, 'expired');
  assert.equal(f.wx.connection(result.connection.id).account_id, null);
  assert.equal(fs.existsSync(path.join(f.wx.folder(result.connection.id), 'credentials.json')), false);
});

test('Weixin restart keeps completed data and never replays in-flight execution or uncertain delivery', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.setMessages([f.message('restart', [{ type: 1, text_item: { text: 'synthetic' } }])]);
  await f.wx.poll(row);
  f.db.db.prepare("UPDATE weixin_inbox SET status='processing'").run();
  f.wx.queue(row, { dedupeKey: 'restart-delivery', inboxId: 1 });
  f.db.db.prepare("UPDATE weixin_outbox SET status='sending'").run();
  f.wx.tick = () => {}; f.wx.start();
  assert.equal(f.db.db.prepare('SELECT status FROM weixin_inbox').get().status, 'uncertain');
  assert.equal(f.db.db.prepare('SELECT status FROM weixin_outbox').get().status, 'uncertain');
  await f.wx.process(row); await f.wx.deliver(row);
  assert.equal(f.calls.filter(c => c.op === 'send').length, 0);
  assert.equal(f.wx.connection(row.id).status, 'active');
});


test('Weixin default-zero transport responses confirm server acceptance without marking notifications read', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.setMessages([f.message('no-ack', [{ type: 4, file_item: { file_name: 'note.txt', len: '4', fixture: 'note' } }])]);
  await f.wx.poll(row); await f.wx.process(row);
  const relay = f.wx.relay(row), original = relay.request;
  relay.request = (op, input) => op === 'send' ? Promise.resolve({}) : original(op, input);
  await f.wx.deliver(row);
  assert.equal(f.db.db.prepare('SELECT status FROM weixin_outbox').get().status, 'sent');
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM task_notifications WHERE read_at IS NOT NULL').get().n, 0);
  await f.wx.deliver(row);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) n FROM weixin_outbox').get().n, 1);
});

test('Weixin explicit rejection and malformed responses remain failed or uncertain without resending', async t => {
  const f = weixinFixture(t), row = await f.bind();
  f.setMessages([f.message('response-cases', [])]); await f.wx.poll(row); await f.wx.process(row);
  const relay = f.wx.relay(row), original = relay.request;
  for (const [response, status, code] of [
    [{ ret: 1 }, 'failed', 'WEIXIN_REJECTED'], [{ errcode: -14 }, 'failed', 'WEIXIN_REJECTED'],
    [{ ret: 'invalid' }, 'uncertain', 'DELIVERY_UNCONFIRMED'], [null, 'uncertain', 'DELIVERY_UNCONFIRMED'],
    [{ ret: '0', errcode: 0 }, 'sent', null],
  ]) {
    f.db.db.prepare("UPDATE weixin_outbox SET status='queued'").run();
    let sends = 0;
    relay.request = (op, input) => op === 'send' ? (sends++, Promise.resolve(response)) : original(op, input);
    await f.wx.deliver(row); await f.wx.deliver(row);
    assert.equal(sends, 1);
    const item = f.db.db.prepare('SELECT status,error_code FROM weixin_outbox').get();
    assert.equal(item.status, status); assert.equal(item.error_code, code);
  }
});


test('read-only packaging works during the boss turn while task imports still require idle workspaces', async t => {
  const f = fixture(t);
  f.workspace.writeFile(f.project, 'brief.txt', 'chosen background');
  f.workspace.writeFile(f.project, 'unselected.txt', 'private background');
  f.busy.add(f.project.accessId);
  const file = await f.materials.pack({ userId: f.boss.id, projectId: f.project.id, chatId: f.chat.id,
    paths: ['brief.txt'], name: 'selected.zip', idempotencyKey: randomUUID() });
  const zip = await JSZip.loadAsync(f.materials.bytes(f.materials.row(file.id)));
  assert.deepEqual(Object.keys(zip.files), ['brief.txt']);
  assert.equal(await zip.file('brief.txt').async('string'), 'chosen background');
  const receipt = f.service.request(f.boss.id, f.request([file.id]));
  assert.equal(receipt.status, 'accepted');
  assert.throws(() => f.service.prepare(f.store.claimJob()), { code: 'WORKSPACE_BUSY' });
  assert.throws(() => f.materials.importFiles(f.project, [file]), { code: 'WORKSPACE_BUSY' });
});
