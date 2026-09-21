import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { CodexService } from '../src/codex-service.mjs';
import { loadConfig } from '../src/config.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-input-queue-'));
  const config = loadConfig({ DATA_DIR: base, DATABASE_PATH: path.join(base, 'db.sqlite'),
    WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'),
    RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash') });
  const db = new HarnessDatabase(config);
  const workspace = new WorkspaceService(config);
  const user = db.createUser({ username: 'queue-user', displayName: 'Queue User', passwordHash: 'test', role: 'user',
    networkAccess: false, maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 1 });
  const project = db.createProject({ userId: user.id, slug: 'queue-project', name: 'Queue Project' });
  workspace.createProject(project);
  const chat = db.createChat({ userId: user.id, projectId: project.id, projectAccessId: project.accessId,
    treePath: project.treePath, title: 'Queue' });
  const codex = new CodexService({ db, config, workspace });
  const queue = codex.inputQueue;
  const calls = [];
  codex.client.started = true; codex.skillsReady = true;
  codex.client.start = async () => {};
  codex.client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: 'queue-thread', modelProvider: config.codexModelProvider } };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    if (method === 'turn/steer') return { turnId: params.expectedTurnId };
    if (method === 'turn/interrupt') finish('interrupted');
    return {};
  };
  const finish = (status = 'completed') => {
    const active = codex.activeByChat.get(chat.id);
    if (active) codex.client.emit('notification', { method: 'turn/completed', params: {
      threadId: active.threadId, turn: { id: active.turnId, status },
    } });
  };
  const enqueue = (prompt, opts = {}) => queue.enqueue(chat.id, { id: randomUUID(), prompt, mode: 'edit', effort: 'low', ...opts });
  t.after(async () => { queue.stop(); finish('interrupted'); await tick(); db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { db, codex, queue, chat, user, project, config, calls, finish, enqueue };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function running(codex, chat) {
  for (let i = 0; i < 100; i++) {
    if (codex.activeByChat.get(chat.id)?.turnId) return;
    const run = codex.db.getLatestTurnRunForChat(chat.id);
    if (run?.status === 'failed') throw new Error(run.errorMessage);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('queued turn did not start');
}

test('durable FIFO dispatch uses one root, editable revisions, idempotency, and lifecycle guards', async (t) => {
  const { db, codex, queue, chat, project, calls, finish, enqueue } = fixture(t);
  const first = enqueue('first input');
  const second = enqueue('second input');
  const third = enqueue('cancelled input');
  assert.equal(db.runtimeForChat(chat.id).queueBusy, true);
  assert.equal(db.runtimeForAccess(project.accessId).busy, true);
  assert.equal(db.runtimeForProject(project.id).busy, true);
  assert.throws(() => db.deleteChat(chat.id));
  const edited = queue.edit(chat.id, second.id, second.revision, 'edited input');
  assert.throws(() => queue.cancel(chat.id, second.id, second.revision), { code: 'INPUT_CHANGED' });
  queue.cancel(chat.id, third.id, third.revision);
  assert.equal(queue.enqueue(chat.id, { ...first }).id, first.id);
  queue.pump(); queue.pump(); await running(codex, chat);
  assert.equal(codex.globalActive, 1);
  assert.equal(db.listTurnRunsForChat(chat.id).length, 1);
  assert.equal(db.getChatInput(chat.id, first.id).prompt, '');
  assert.throws(() => queue.edit(chat.id, first.id, first.revision, 'too late'), { code: 'INPUT_CHANGED' });
  finish(); await tick(); queue.pump(); await running(codex, chat);
  assert.equal(codex.globalActive, 1);
  assert.equal(db.getChatInput(chat.id, edited.id).status, 'sent');
  finish(); await tick(); queue.pump();
  assert.equal(db.listTurnRunsForChat(chat.id).length, 2);
  assert.deepEqual(calls.filter((call) => call.method === 'turn/start').map((call) => call.params.input[0].text),
    ['<!-- portal-mode:EDIT -->\nfirst input', '<!-- portal-mode:EDIT -->\nedited input']);
  assert.equal(db.runtimeForChat(chat.id).busy, false);
  assert.equal(db.listChatInputs(chat.id).length, 0);
});

test('steer targets the existing native turn, preserves other inputs, and keeps history idempotent', async (t) => {
  const { db, codex, queue, chat, calls, enqueue } = fixture(t);
  enqueue('initial'); queue.pump(); await running(codex, chat);
  const before = codex.activeByChat.get(chat.id);
  const follow = enqueue('follow later');
  const steer = enqueue('change direction');
  await assert.rejects(queue.steer(chat.id, steer.id, steer.revision, 'stale-run'), { code: 'TURN_CHANGED' });
  await queue.steer(chat.id, steer.id, steer.revision, before.turnRunId);
  assert.equal(codex.activeByChat.get(chat.id), before);
  assert.equal(db.listTurnRunsForChat(chat.id).length, 1);
  assert.equal(db.getChatInput(chat.id, follow.id).status, 'queued');
  assert.equal(calls.find((call) => call.method === 'turn/steer').params.expectedTurnId, before.turnId);
  const events = JSON.stringify(db.listTurnEvents(chat.id));
  assert.equal(events.includes('change direction'), false);
  const request = codex.client.request;
  codex.client.request = async (method, params) => method === 'thread/read' ? { thread: { turns: [{ id: before.turnId, items: [
    { id: 'original', type: 'userMessage', content: [{ type: 'text', text: 'initial' }] },
    { id: steer.id, type: 'userMessage', content: [{ type: 'text', text: 'change direction' }] },
  ] }] } } : request(method, params);
  const history = await codex.historyForChat(db.getChat(chat.id));
  assert.deepEqual(history.filter((item) => item.role === 'user').map((item) => item.content), ['initial', 'change direction']);
  await codex.historyForChat(db.getChat(chat.id));
  assert.equal(db.listMessages(chat.id).length, 2);
});

test('steer mode mismatch and unknown delivery do not start a new turn or silently resend', async (t) => {
  const { db, codex, queue, chat, enqueue } = fixture(t);
  enqueue('initial'); queue.pump(); await running(codex, chat);
  const active = codex.activeByChat.get(chat.id);
  const wrongMode = enqueue('execute later', { mode: 'execute' });
  await assert.rejects(queue.steer(chat.id, wrongMode.id, wrongMode.revision, active.turnRunId), { code: 'STEER_MODE_MISMATCH' });
  const steer = enqueue('uncertain');
  const request = codex.client.request;
  codex.client.request = async (method, params) => {
    if (method === 'turn/steer') throw new Error('untrusted upstream detail');
    return request(method, params);
  };
  await assert.rejects(queue.steer(chat.id, steer.id, steer.revision, active.turnRunId), { code: 'STEER_NOT_CONFIRMED' });
  const paused = db.getChatInput(chat.id, steer.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'DELIVERY_UNCERTAIN');
  assert.throws(() => queue.resume(chat.id, steer.id, paused.revision), { code: 'DELIVERY_UNCERTAIN' });
  queue.resume(chat.id, steer.id, paused.revision, true);
  assert.equal(db.listTurnRunsForChat(chat.id).length, 1);
});

test('stop pauses queued messages; restarting migrates idempotently and does not auto-send', async (t) => {
  const { db, codex, queue, chat, enqueue } = fixture(t);
  enqueue('initial'); queue.pump(); await running(codex, chat);
  const pending = enqueue('still pending');
  await codex.interruptAndWait(chat.id);
  assert.equal(db.getChatInput(chat.id, pending.id).status, 'paused');
  assert.equal(db.runtimeForChat(chat.id).busy, false);
  const latest = db.getChatInput(chat.id, pending.id);
  queue.resume(chat.id, pending.id, latest.revision);
  db.migrate(); db.migrate(); db.recoverInterruptedRuntime();
  const restored = db.getChatInput(chat.id, pending.id);
  assert.equal(restored.prompt, 'still pending');
  assert.equal(restored.status, 'paused');
  queue.pump(); await tick();
  assert.equal(db.listTurnRunsForChat(chat.id).length, 1);
});

test('user disable is rechecked before dispatch and pauses pending work', async (t) => {
  const { db, queue, chat, user, calls, enqueue } = fixture(t);
  const input = enqueue('must not start');
  db.updateUser(user.id, { status: 'disabled' });
  queue.pump(); await tick();
  assert.equal(calls.some((call) => call.method === 'turn/start'), false);
  assert.equal(db.getChatInput(chat.id, input.id).status, 'paused');
  assert.throws(() => queue.resume(chat.id, input.id, db.getChatInput(chat.id, input.id).revision), { code: 'USER_DISABLED' });
});

test('completion during steer waits for acknowledgement before dispatching the next input', async (t) => {
  const { db, codex, queue, chat, enqueue, finish } = fixture(t);
  enqueue('initial'); queue.pump(); await running(codex, chat);
  const active = codex.activeByChat.get(chat.id);
  const next = enqueue('next');
  const steer = enqueue('late acknowledgement');
  let acknowledge;
  const request = codex.client.request;
  codex.client.request = (method, params) => method === 'turn/steer'
    ? new Promise((resolve) => { acknowledge = resolve; }) : request(method, params);
  const sending = queue.steer(chat.id, steer.id, steer.revision, active.turnRunId);
  finish(); await tick(); queue.pump();
  assert.equal(db.listTurnRunsForChat(chat.id).length, 1);
  assert.equal(db.runtimeForChat(chat.id).busy, true);
  acknowledge({ turnId: active.turnId }); await sending;
  queue.pump(); await running(codex, chat);
  assert.equal(db.getChatInput(chat.id, next.id).status, 'sent');
  assert.equal(db.getChatInput(chat.id, steer.id).turn_run_id, active.turnRunId);
  assert.notEqual(codex.activeByChat.get(chat.id).turnRunId, active.turnRunId);
});

test('a newly opened database preserves queue drafts and startup recovery pauses uncertain delivery', async (t) => {
  const { db, config, chat, enqueue } = fixture(t);
  const queued = enqueue('persisted across reopen');
  const steering = enqueue('unconfirmed before restart');
  db.changeChatInput(chat.id, steering.id, steering.revision, { status: 'steering' });
  const reopened = new HarnessDatabase(config);
  try {
    assert.equal(reopened.getChatInput(chat.id, queued.id).status, 'queued');
    reopened.recoverInterruptedRuntime();
    assert.equal(reopened.getChatInput(chat.id, queued.id).status, 'paused');
    assert.equal(reopened.getChatInput(chat.id, queued.id).prompt, 'persisted across reopen');
    assert.equal(reopened.getChatInput(chat.id, steering.id).reason, 'DELIVERY_UNCERTAIN');
    assert.equal(reopened.runtimeForChat(chat.id).busy, false);
  } finally { reopened.close(); }
});

test('queue resolves role and chat effort at enqueue and preserves the frozen explicit choice', async t => {
  const {db,codex,queue,chat,enqueue,calls,finish}=fixture(t);
  const first=enqueue('role default',{effort:undefined}); assert.equal(first.effort,'medium');
  db.updateChat(chat.id,{preferredEffort:'max'});
  const second=enqueue('chat preference',{effort:undefined});assert.equal(second.effort,'max');
  const third=enqueue('explicit',{effort:'low'});assert.equal(third.effort,'low');
  assert.throws(()=>enqueue('invalid',{effort:'invalid'}),{code:'INVALID_EFFORT'});
  // A settings change outside the API cannot rewrite already persisted queue choices.
  db.updateChat(chat.id,{preferredEffort:'high'});
  for(let i=0;i<3;i++){queue.pump();await running(codex,chat);finish();await tick();}
  assert.deepEqual(calls.filter(c=>c.method==='turn/start').map(c=>c.params.effort),['medium','max','low']);
});
