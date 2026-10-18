import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserService } from '../src/browser-service.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-state-'));
  const user = { id: 'user', status: 'active', networkAccess: true };
  const project = { id: 'project', accessId: 'access', projectType: 'standard' };
  const chat = { id: 'chat', userId: user.id, projectAccessId: project.accessId };
  const db = { getUserById: () => user, getChat: () => chat, getProjectForUser: () => project, getSession: token => token === 'owner' };
  const browser = new BrowserService({ config: { browserEnabled: true, browserHandoffTimeoutMs: 30 }, db });
  const active = { user, project, chat, mode: 'execute', turnRunId: 'run' };
  const session = { id: 'session', root, active, state: 'ready', control: 'agent', pages: new Map(), refs: new Map(), viewers: new Set(), serial: Promise.resolve(), activity: Date.now(), browser: { close: async () => {} } };
  browser.sessions.set(chat.id, session);
  t.after(() => browser.stop());
  return { browser, active, session, user, project, chat };
}

test('handoff timeout ends waiting and removes profile rather than accepting verification', async t => {
  const { browser, active, session } = fixture(t);
  const result = await browser.handoff(active, 'verify');
  assert.equal(result.errorCode, 'BROWSER_HANDOFF_ENDED'); assert.equal(result.decision, 'timeout');
  await browser.close(active.chat.id); assert.equal(fs.existsSync(session.root), false);
});

test('user may decline a handoff before taking control', async t => {
  const { browser, active } = fixture(t);
  const waiting = browser.handoff(active, 'verify');
  await browser.control(active, 'cancel', 'owner');
  assert.equal((await waiting).decision, 'cancel');
  assert.equal(browser.state(active.chat.id).state, 'closed');
});

test('takeover pauses Agent calls and a returned human page prevents stale action replay', async t => {
  const { browser, active, session } = fixture(t);
  browser.config.browserHandoffTimeoutMs = 1000;
  await browser.control(active, 'takeover', 'owner');
  let snapshots = 0; browser.snapshot = async () => { snapshots++; return { text: 'still blocked' }; };
  let done = false;
  const operation = browser.call(active, 'browser_action', { action: 'click', ref: '1' }).then(value => { done = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  await assert.rejects(browser.action(active, { action: 'text', text: 'private' }, 'human', 'different-session'), { code: 'BROWSER_CONTROL_CHANGED' });
  await browser.control(active, 'continue', 'owner');
  assert.equal((await operation).errorCode, 'BROWSER_PAGE_CHANGED'); assert.equal(snapshots, 1);
  await browser.closeSession('owner'); // controller was released; viewing session still owns its browser
  session.viewers.add('owner'); await browser.closeSession('owner'); assert.equal(browser.state(active.chat.id).state, 'closed');
});

test('browser authorization fails closed after account, ACL, mode and lifecycle changes', async t => {
  const { browser, active, user, project, chat } = fixture(t);
  for (const [object, key, value, code] of [
    [user, 'status', 'disabled', 'BROWSER_FORBIDDEN'], [user, 'networkAccess', false, 'NETWORK_DISABLED'],
    [project, 'accessId', 'different', 'BROWSER_FORBIDDEN'], [chat, 'userId', 'different', 'BROWSER_FORBIDDEN'],
    [active, 'mode', 'edit', 'BROWSER_EXECUTE_REQUIRED'], [active, 'interruptRequested', true, 'BROWSER_RUN_REQUIRED'],
  ]) { const before = object[key]; object[key] = value; assert.throws(() => browser.authorize(active), { code }); object[key] = before; }
});

test('browser capacity includes cleanup in flight', async t => {
  const { browser, active, session } = fixture(t);
  browser.config.browserMaxSessions = 1; browser.authorize = () => {};
  const other = { ...active, chat: { ...active.chat, id: 'other' } };
  await assert.rejects(browser.open(other, 'https://example.com'), { code: 'BROWSER_CAPACITY' });
  let release; session.browser.close = () => new Promise(resolve => { release = resolve; });
  const closing = browser.close(active.chat.id);
  await assert.rejects(browser.open(other, 'https://example.com'), { code: 'BROWSER_CAPACITY' });
  release(); await closing; assert.equal(browser.closing.size, 0);
});

test('disconnected sessions expire and clear their temporary login directory', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const { browser, session } = fixture(t);
  t.mock.timers.tick(130000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.sessions.size, 0); assert.equal(fs.existsSync(session.root), false);
});


test('manual browsing checks live mode and Agent adoption retains human control', async t => {
  const { browser, active, session, chat } = fixture(t);
  const manual = { ...active, manual: true }; session.active = manual;
  chat.preferredMode = 'edit';
  assert.throws(() => browser.authorize(manual), { code: 'BROWSER_EXECUTE_REQUIRED' });
  chat.preferredMode = 'execute'; browser.authorize(manual);
  browser.config.browserHandoffTimeoutMs = 1000;
  await browser.control(manual, 'takeover', 'owner');
  browser.snapshot = async () => ({ text: 'human page retained' });
  const pending = browser.call(active, 'browser_snapshot', {});
  assert.equal(session.active, active); assert.equal(session.control, 'human');
  await browser.control(active, 'continue', 'owner');
  assert.equal((await pending).text, 'human page retained');
});

test('control changes queue after human input and reject stale concurrent ownership', async t => {
  const { browser, active, session } = fixture(t);
  browser.config.browserHandoffTimeoutMs = 1000;
  await browser.control(active, 'takeover', 'owner');
  let release; const input = browser.operate(active, 'human', 'owner', () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const returning = browser.control(active, 'continue', 'owner');
  assert.equal(session.control, 'human'); release(); await input; await returning;
  assert.equal(session.control, 'agent');
  await assert.rejects(browser.control(active, 'continue', 'owner'), { code: 'BROWSER_CONTROL_CHANGED' });
});
