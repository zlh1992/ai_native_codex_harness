import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_CODEX = path.join(ROOT, 'test/fixtures/fake-codex.mjs');
const FAKE_CODEX_FAIL_RESUME = path.join(ROOT, 'test/fixtures/fake-codex-fail-resume.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-http-e2e-'));
let port;
let origin;
let serverProcess;
let logs = '';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close((error) => error ? reject(error) : resolve(value));
    });
  });
}

async function startServer({ failResume = false } = {}) {
  logs = '';
  serverProcess = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '',
      PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '', TRUST_PROXY_PROVIDER: 'generic',
      DATA_DIR: base, DATABASE_PATH: path.join(base, 'harness.sqlite'),
      WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'),
      RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash'),
      ADMIN_USERNAME: 'gateboss', ADMIN_PASSWORD: 'GateBossPassword!123',
      CODEX_BIN: failResume ? FAKE_CODEX_FAIL_RESUME : FAKE_CODEX,
      CODEX_MODEL: 'gpt-5.6-sol', CODEX_MODEL_PROVIDER: 'openai_http',
      CODEX_REQUEST_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { logs += String(chunk); });
  serverProcess.stderr.on('data', (chunk) => { logs += String(chunk); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Portal exited during startup:\n${logs}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      const health = await response.json();
      if (health.ok && health.codex) {
        assert.equal(health.codexState, 'ready');
        return;
      }
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portal did not become ready:\n${logs}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Portal did not stop:\n${logs}`)), 8000)),
  ]);
}

async function request(session, pathname, { method = 'GET', body, headers = {}, expect = 200 } = {}) {
  const requestHeaders = new Headers(headers);
  if (session?.cookie) requestHeaders.set('cookie', session.cookie);
  if (method !== 'GET' && session?.csrf) requestHeaders.set('x-csrf-token', session.csrf);
  let payload = body;
  if (body !== undefined && !(body instanceof ArrayBuffer) && !Buffer.isBuffer(body) && typeof body !== 'string') {
    requestHeaders.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, { method, headers: requestHeaders, body: payload });
  assert.equal(response.status, expect, `${method} ${pathname}: ${await response.clone().text()}`);
  return response;
}

async function login(username, password) {
  const endpoint = username === 'gateboss' ? '/api/boss/login' : '/api/employee/login';
  const response = await request(null, endpoint, { method: 'POST', body: { username, password } });
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^codex_harness_session=/);
  const session = { cookie, csrf: '' };
  const me = await (await request(session, '/api/me')).json();
  session.csrf = me.csrfToken;
  session.user = me.user;
  return session;
}

function parseSse(text) {
  return text.split('\n\n').map((frame) => {
    let id = null; let event = 'message'; let data = null;
    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) id = Number(line.slice(3).trim());
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data = JSON.parse(line.slice(5));
    }
    return data ? { id, event, data } : null;
  }).filter(Boolean);
}

async function json(session, pathname, options) {
  return (await request(session, pathname, options)).json();
}

function startChunkedUpload(session, pathname, firstChunk) {
  const target = new URL(pathname, origin);
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const req = http.request(target, {
    method: 'PUT',
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'content-type': 'application/octet-stream',
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolveResponse({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', rejectResponse);
  req.write(firstChunk);
  return { req, response };
}

async function waitUntil(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(message);
}

test('fixed Portal release gate', { timeout: 60_000 }, async (t) => {
  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  await startServer();
  t.after(async () => stopServer());

  const boss = await login('gateboss', 'GateBossPassword!123');
  const passwords = { first: 'EmployeeOne!123', second: 'EmployeeTwo!123' };
  let firstUser;
  let secondUser;
  let project;
  let firstAccess;
  let taskChat;
  let completedRun;
  let ownerChat;

  await t.test('boss creates two employees and grants isolated worktrees from one project snapshot', async () => {
    firstUser = (await json(boss, '/api/admin/users', {
      method: 'POST', body: { username: 'gatefirst', displayName: 'Gate First', password: passwords.first, maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 4 }, expect: 201,
    })).user;
    secondUser = (await json(boss, '/api/admin/users', {
      method: 'POST', body: { username: 'gatesecond', displayName: 'Gate Second', password: passwords.second, maxProjects: 10, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 4 }, expect: 201,
    })).user;
    project = (await json(boss, '/api/projects', {
      method: 'POST', body: { name: 'Release gate project', description: 'multi-employee isolation' }, expect: 201,
    })).project;
    await request(boss, `/api/projects/${project.id}/file?path=owner-snapshot.txt&overwrite=0`, {
      method: 'PUT', body: 'owner uncommitted snapshot', headers: { 'content-type': 'application/octet-stream' },
    });
    const htmlArtifact = '<!doctype html><html><head><style>body{background:#102018;color:#d9ff54}</style></head><body><h1>Rendered artifact</h1><script>document.body.dataset.scriptRan="yes"</script></body></html>';
    await request(boss, `/api/projects/${project.id}/file?path=artifact.html&overwrite=0`, {
      method: 'PUT', body: htmlArtifact, headers: { 'content-type': 'application/octet-stream' },
    });
    const ownerHtml = await request(boss, `/api/projects/${project.id}/raw?path=artifact.html`);
    assert.match(ownerHtml.headers.get('content-type') || '', /^text\/html\b/);
    const previewCsp = ownerHtml.headers.get('content-security-policy') || '';
    assert.match(previewCsp, /(?:^|;)\s*sandbox allow-scripts(?:;|$)/);
    assert.match(previewCsp, /connect-src 'none'/);
    assert.match(previewCsp, /form-action 'none'/);
    assert.doesNotMatch(previewCsp, /allow-same-origin/);
    assert.equal(await ownerHtml.text(), htmlArtifact);
    ownerChat = (await json(boss, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Owner design history' }, expect: 201,
    })).chat;
    assert.ok((await json(boss, '/api/me')).models.some((model) => model.id === 'gpt-6-astra'));
    await request(boss, `/api/chats/${ownerChat.id}`, { method: 'PATCH', body: { preferredModel: 'arbitrary-model' }, expect: 400 });
    for (const preferredModel of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
      const changed = await json(boss, `/api/chats/${ownerChat.id}`, { method: 'PATCH', body: { preferredModel } });
      assert.equal(changed.chat.preferredModel, preferredModel);
      assert.equal((await json(boss, `/api/chats/${ownerChat.id}`)).chat.preferredModel, preferredModel);
    }
    await request(boss, `/api/chats/${ownerChat.id}/turns`, { method: 'POST', body: { prompt: 'Before sharing design context', mode: 'edit' } });
    await json(boss, `/api/projects/${project.id}/chats`, { method: 'POST', body: { title: 'Empty owner chat' }, expect: 201 });
    firstAccess = (await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id }, expect: 201,
    })).access;
    const secondAccess = (await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: secondUser.id }, expect: 201,
    })).access;
    assert.notEqual(firstAccess.id, secondAccess.id);
    assert.match(firstAccess.baseSha, /^[0-9a-f]{40,64}$/);
    assert.match(secondAccess.baseSha, /^[0-9a-f]{40,64}$/);
    const dashboard = await json(boss, '/api/admin/dashboard');
    assert.equal(dashboard.projects.find((item) => item.id === project.id).sharedAccesses.length, 2);

    const first = await login('gatefirst', passwords.first);
    const second = await login('gatesecond', passwords.second);
    assert.equal((await json(first, `/api/projects/${project.id}/file?path=owner-snapshot.txt`)).content, 'owner uncommitted snapshot');
    const employeeHtml = await request(first, `/api/projects/${project.id}/raw?path=artifact.html`);
    assert.match(employeeHtml.headers.get('content-type') || '', /^text\/html\b/);
    assert.equal(await employeeHtml.text(), htmlArtifact);
    await request(first, `/api/projects/${project.id}/file?path=employee-one-only.txt&overwrite=0`, {
      method: 'PUT', body: 'private work in progress', headers: { 'content-type': 'application/octet-stream' },
    });
    await request(second, `/api/projects/${project.id}/file?path=employee-one-only.txt`, { expect: 404 });
  });

  await t.test('Portal memory is user-isolated, source-aware, inspectable, and confirmation-gated on history share', async () => {
    const me = await json(boss, '/api/me');
    assert.equal(me.memory.nativeCodexMemory, false);
    const manual = (await json(boss, '/api/memories', {
      method: 'POST', body: { body: '手动长期偏好' }, expect: 201,
    })).memory;
    const edited = (await json(boss, `/api/memories/${manual.id}`, {
      method: 'PATCH', body: { version: manual.version, body: '更新后的手动长期偏好' },
    })).memory;
    assert.equal(edited.version, 2);
    await json(boss, `/api/memories/${manual.id}`, { method: 'DELETE', body: { version: edited.version } });

    const sourceProject = (await json(boss, '/api/projects', {
      method: 'POST', body: { name: 'Memory source project' }, expect: 201,
    })).project;
    const sourceChat = (await json(boss, `/api/projects/${sourceProject.id}/chats`, {
      method: 'POST', body: { title: 'Memory source chat' }, expect: 201,
    })).chat;
    await request(boss, `/api/chats/${sourceChat.id}/turns`, {
      method: 'POST', body: { prompt: '请记住：以后默认蓝色主题', mode: 'edit' },
    });
    assert.equal((await json(boss, '/api/memories')).memories.length, 0, 'no keyword-based extraction');
    await request(boss, `/api/chats/${sourceChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[memory-tools]]' + JSON.stringify([{ name: 'memory_add', args: { body: '发布说明统一使用克制语气' } }]), mode: 'edit' },
    });
    await waitUntil(async () => (await json(boss, '/api/memories')).memories
      .some((item) => item.body === '发布说明统一使用克制语气'), 'memory_add did not save the record');
    const saved = (await json(boss, '/api/memories')).memories
      .find((item) => item.body === '发布说明统一使用克制语气');
    assert.equal(saved.sourceKind, 'turn');
    const toolTurn = async (calls) => request(boss, `/api/chats/${sourceChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[memory-tools]]' + JSON.stringify(calls), mode: 'edit' },
    });
    await toolTurn([{ name: 'memory_add', args: { body: '工具修改删除测试偏好' } }]);
    const mutable = (await json(boss, '/api/memories')).memories.find((item) => item.body === '工具修改删除测试偏好');
    assert.ok(mutable);
    await toolTurn([{ name: 'memory_update', args: { id: mutable.id, version: 1, body: '修改后的偏好' } }]);
    assert.equal((await json(boss, '/api/memories')).memories.find((item) => item.id === mutable.id).version, 2);
    await toolTurn([{ name: 'memory_delete', args: { id: mutable.id, version: 2 } }]);
    assert.equal((await json(boss, '/api/memories')).memories.some((item) => item.id === mutable.id), false);

    const targetProject = (await json(boss, '/api/projects', {
      method: 'POST', body: { name: 'Memory target project' }, expect: 201,
    })).project;
    const targetChat = (await json(boss, `/api/projects/${targetProject.id}/chats`, {
      method: 'POST', body: { title: 'Memory target chat' }, expect: 201,
    })).chat;
    await request(boss, `/api/chats/${targetChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[memory-tools]]' + JSON.stringify([{ name: 'memory_search', args: { query: '发布说明语气' } }]), mode: 'edit' },
    });
    const target = await json(boss, `/api/chats/${targetChat.id}`);
    const references = (await json(boss,
      `/api/chats/${targetChat.id}/turn-runs/${target.latestTurnRun.id}/memory-references`)).references;
    assert.equal(references.some((ref) => ref.memoryId === saved.id && ref.available), true);
    assert.equal(references.find((ref) => ref.memoryId === saved.id).sourceProjectId, sourceProject.id);
    await json(boss, `/api/chats/${targetChat.id}/memory`, {
      method: 'PATCH', body: { useMemory: false, saveMemory: false },
    });
    const settings = await json(boss, `/api/chats/${targetChat.id}/memory`);
    assert.deepEqual(settings.settings, { useMemory: false, saveMemory: false });

    const challenge = await json(boss, `/api/admin/projects/${targetProject.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id, scope: 'files_and_history' }, expect: 409,
    });
    assert.equal(challenge.error.code, 'MEMORY_SHARE_CONFIRMATION_REQUIRED');
    assert.equal(challenge.error.details.memoryCount, 1);
    const grant = await json(boss, `/api/admin/projects/${targetProject.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id, scope: 'files_and_history',
        memoryConfirmationToken: challenge.error.details.confirmationToken }, expect: 201,
    });
    const first = await login('gatefirst', passwords.first);
    assert.equal((await json(first, '/api/memories')).memories.length, 0);
    await request(first, `/api/chats/${targetChat.id}`, { expect: 403 });

    await toolTurn([
      { name: 'memory_search', args: { query: '发布说明语气' } },
      { name: 'memory_update', args: { id: saved.id, version: 1, body: '发布说明使用精炼语气' } },
      { name: 'workspace_write_file', args: { path: 'after-invalid-memory.txt', content: 'must be denied' } },
    ]);
    const invalidated = await json(boss, `/api/chats/${sourceChat.id}`);
    assert.equal(invalidated.chat.threadState, 'resume_failed');
    assert.equal(invalidated.latestTurnRun.status, 'failed', 'further tools must be denied after invalidation');
    assert.equal((await json(boss, '/api/memories')).memories.find((item) => item.id === saved.id).version, 2,
      'successful mutation persists even when subsequent turn fails');
    const retry = await json(boss, `/api/chats/${sourceChat.id}/thread-recovery`, {
      method: 'POST', body: { action: 'retry' }, expect: 409,
    });
    assert.equal(retry.error.code, 'MEMORY_CONTEXT_INVALIDATED');
    await json(boss, `/api/chats/${sourceChat.id}/thread-recovery`, {
      method: 'POST', body: { action: 'reset', acknowledgeHistoryBreak: true },
    });

    await request(boss, `/api/admin/projects/${targetProject.id}/shares/${grant.access.id}`, { method: 'DELETE' });
    await request(boss, `/api/projects/${targetProject.id}`, { method: 'DELETE' });
    await request(boss, `/api/projects/${sourceProject.id}`, { method: 'DELETE' });
    assert.equal((await json(boss, '/api/memories')).memories.some((item) => item.id === saved.id), false);
  });

  await t.test('running input queue supports edit, cancel, steer, serial dispatch and private replay', async () => {
    const chat = (await json(boss, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Input queue contract' }, expect: 201,
    })).chat;
    const endpoint = `/api/chats/${chat.id}/queue`;
    const enqueue = async (prompt) => (await json(boss, endpoint, { method: 'POST',
      body: { id: randomUUID(), prompt, mode: 'edit', effort: 'low' } })).input;
    const initial = await enqueue('[[hold]] queue initial');
    await waitUntil(async () => (await json(boss, endpoint)).latestTurnRun?.status === 'running', 'queued initial did not start');
    const initialRun = (await json(boss, endpoint)).latestTurnRun.id;
    const a = await enqueue('queue-followup-original');
    const b = await enqueue('queue-cancel-marker');
    const c = await enqueue('queue-steer-private-marker');
    const edited = (await json(boss, `${endpoint}/${a.id}`, { method: 'PATCH',
      body: { revision: a.revision, prompt: 'queue-followup-edited' } })).input;
    await request(boss, `${endpoint}/${a.id}`, { method: 'DELETE', body: { revision: a.revision }, expect: 409 });
    await json(boss, `${endpoint}/${b.id}`, { method: 'DELETE', body: { revision: b.revision } });
    await request(boss, `${endpoint}/${initial.id}`, { method: 'PATCH', body: { revision: initial.revision, prompt: 'too late' }, expect: 409 });
    await request(boss, `${endpoint}/${c.id}/steer`, { method: 'POST',
      body: { revision: c.revision, expectedRunId: 'stale-run' }, expect: 409 });
    const employee = await login('gatefirst', passwords.first);
    await request(employee, endpoint, { expect: 403 });
    for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['POST', '/steer'], ['POST', '/resume']]) {
      await request(employee, `${endpoint}/${c.id}${suffix}`, { method, body: { revision: c.revision, prompt: 'forbidden', expectedRunId: initialRun }, expect: 403 });
    }
    await request({ cookie: boss.cookie, csrf: 'invalid' }, endpoint, { method: 'POST', body: { id: randomUUID(), prompt: 'forbidden' }, expect: 403 });
    await json(boss, `${endpoint}/${c.id}/steer`, { method: 'POST', body: { revision: c.revision, expectedRunId: initialRun } });
    const queued = await json(boss, endpoint);
    assert.equal(queued.latestTurnRun.id, initialRun);
    assert.equal(queued.latestTurnRun.status, 'running');
    assert.deepEqual(queued.inputs.map((input) => input.id), [edited.id]);
    assert.equal((await json(boss, `/api/chats/${chat.id}`)).messages.filter((message) => message.content === 'queue-steer-private-marker').length, 1);
    // A disconnected POST retry is idempotent even after a message has been steered.
    await json(boss, endpoint, { method: 'POST', body: { id: c.id, prompt: 'queue-steer-private-marker' } });
    assert.equal((await json(boss, endpoint)).inputs.length, 1);
    const stream = await fetch(`${origin}/api/chats/${chat.id}/turn-runs/${initialRun}/events`, { headers: { cookie: boss.cookie } });
    const liveResult = stream.text();
    const release = await enqueue('[[release]] finish current direction');
    await json(boss, `${endpoint}/${release.id}/steer`, { method: 'POST', body: { revision: release.revision, expectedRunId: initialRun } });
    const liveEvents = parseSse(await liveResult);
    assert.ok(liveEvents.some((event) => event.event === 'assistant_delta' && event.data.delta.includes('FAKE_CODEX_DONE')));
    await waitUntil(async () => {
      const data = await json(boss, endpoint);
      return data.inputs.length === 0 && data.latestTurnRun?.id !== initialRun && data.latestTurnRun?.status === 'completed';
    }, 'next queued message did not finish');
    const history = await json(boss, `/api/chats/${chat.id}`);
    const userMessages = history.messages.filter((message) => message.role === 'user').map((message) => message.content);
    assert.deepEqual(userMessages, ['[[hold]] queue initial', 'queue-steer-private-marker', '[[release]] finish current direction', 'queue-followup-edited']);
    const replay = JSON.stringify((await json(boss, `/api/chats/${chat.id}/events`)).events);
    assert.equal(replay.includes('queue-steer-private-marker'), false);
    assert.equal(replay.includes('queue-followup-edited'), false);
    assert.equal(replay.includes('fake secret diff body'), false);
    const audit = JSON.stringify(await json(boss, '/api/admin/audit'));
    assert.equal(audit.includes('queue-steer-private-marker'), false);

    await enqueue('[[hold]] stop queue');
    await waitUntil(async () => (await json(boss, endpoint)).latestTurnRun?.status === 'running', 'stop fixture did not start');
    const pending = await enqueue('resume pending input');
    await json(boss, `/api/chats/${chat.id}/interrupt`, { method: 'POST' });
    await waitUntil(async () => (await json(boss, endpoint)).latestTurnRun?.status === 'interrupted', 'stop did not drain');
    const paused = (await json(boss, endpoint)).inputs.find((input) => input.id === pending.id);
    assert.equal(paused.status, 'paused');
    await json(boss, `${endpoint}/${paused.id}/resume`, { method: 'POST', body: { revision: paused.revision } });
    await waitUntil(async () => {
      const data = await json(boss, endpoint);
      return data.inputs.length === 0 && data.latestTurnRun.status === 'completed';
    }, 'paused input did not resume');
    await request(boss, `/api/chats/${chat.id}`, { method: 'DELETE' });
  });

  await t.test('role portals reject wrong accounts and shared chat forks keep history and execution private', async () => {
    assert.match(await (await request(null, '/boss/login')).text(), /老板登录/);
    assert.match(await (await request(null, '/employee')).text(), /员工登录/);
    await request(null, '/api/employee/login', { method: 'POST', body: { username: 'gateboss', password: 'GateBossPassword!123' }, expect: 403 });
    await request(null, '/api/boss/login', { method: 'POST', body: { username: 'gatefirst', password: passwords.first }, expect: 403 });
    const first = await login('gatefirst', passwords.first);
    const second = await login('gatesecond', passwords.second);
    const chats = (await json(first, `/api/projects/${project.id}/chats`)).chats;
    assert.equal(chats.length, 2);
    const fork = chats.find((chat) => chat.sourceChatId === ownerChat.id);
    const other = (await json(second, `/api/projects/${project.id}/chats`)).chats.find((chat) => chat.sourceChatId === ownerChat.id);
    const original = (await json(boss, `/api/chats/${ownerChat.id}`)).chat;
    assert.ok(fork.sharedAt);
    assert.equal(fork.preferredMode, 'edit');
    assert.equal(fork.preferredModel, null);
    assert.equal((await json(first, '/api/me')).defaultEffort, 'medium');
    assert.equal((await json(boss, '/api/me')).defaultEffort, 'high');
    assert.equal((await json(first, '/api/me')).models.length, 7);
    assert.equal(fork.preferredEffort, null);
    for (const model of (await json(first, '/api/me')).models) {
      const changed = await json(first, `/api/chats/${fork.id}`, { method: 'PATCH', body: { preferredModel: model.id, preferredEffort: 'max' } });
      assert.equal(changed.chat.preferredModel, model.id); assert.equal(changed.chat.preferredEffort, 'max');
    }
    assert.equal((await json(first, `/api/chats/${fork.id}`)).chat.preferredEffort, 'max');
    await request(first, `/api/chats/${other.id}`, { method: 'PATCH', body: { preferredEffort: 'low' }, expect: 403 });
    await request(first, `/api/chats/${fork.id}`, { method: 'PATCH', body: { preferredEffort: 'invalid' }, expect: 400 });
    await request(first, `/api/chats/${fork.id}`, { method: 'PATCH', body: { preferredModel: 'invalid' }, expect: 400 });
    await request(first, `/api/chats/${fork.id}/turns`, { method: 'POST', body: { prompt: 'invalid options', effort: 'invalid' }, expect: 400 });
    await request(first, '/api/admin/token-usage', { expect: 403 });
    const usage = await json(boss, '/api/admin/token-usage');
    assert.ok(usage.totals.gpt.totalTokens > 0);
    assert.equal(usage.timezone, 'Asia/Shanghai'); assert.ok(usage.startedAt);
    assert.equal(usage.totals.gpt.totalTokens, usage.totals.bossGpt.totalTokens + usage.totals.employeeGpt.totalTokens);
    assert.equal(JSON.stringify(usage).includes('finalReplySnapshot'), false);
    await request(boss, '/api/admin/token-usage?from=2026-02-30', { expect: 400 });
    assert.notEqual(fork.id, original.id);
    assert.notEqual(fork.codexThreadId, original.codexThreadId);
    assert.notEqual(fork.codexThreadId, other.codexThreadId);
    const before = (await json(first, `/api/chats/${fork.id}`)).messages;
    assert.equal(before.length, 2);
    assert.match(before[0].content, /Before sharing design context/);
    assert.ok(before.every((message) => !message.metadata.turnRunId && !message.metadata.taskId));
    await request(first, `/api/chats/${ownerChat.id}`, { expect: 403 });
    await request(boss, `/api/chats/${fork.id}`, { expect: 403 });
    await request(second, `/api/chats/${fork.id}`, { expect: 403 });
    await request(first, `/api/chats/${fork.id}/turns`, { method: 'POST', body: { prompt: 'Employee private continuation', mode: 'edit' } });
    await request(boss, `/api/chats/${ownerChat.id}/turns`, { method: 'POST', body: { prompt: 'Owner private continuation', mode: 'edit' } });
    const continued = (await json(first, `/api/chats/${fork.id}`)).messages;
    assert.equal(continued.length, 4, 'inherited history must not duplicate on read or continue');
    assert.doesNotMatch(JSON.stringify(continued), /Owner private continuation/);
    assert.doesNotMatch(JSON.stringify((await json(boss, `/api/chats/${ownerChat.id}`)).messages), /Employee private continuation/);
    assert.equal((await json(second, `/api/chats/${other.id}`)).messages.length, 2);
  });

  await t.test('sharing rejects active owner turns before taking any file or history snapshot', async () => {
    const busyProject = (await json(boss, '/api/projects', { method: 'POST', body: { name: 'Busy share boundary' }, expect: 201 })).project;
    const source = (await json(boss, `/api/projects/${busyProject.id}/chats`, { method: 'POST', body: { title: 'Busy owner' }, expect: 201 })).chat;
    const running = request(boss, `/api/chats/${source.id}/turns`, { method: 'POST', body: { prompt: '[[hold]] owner working', mode: 'edit' } });
    await waitUntil(async () => (await json(boss, `/api/chats/${source.id}`)).latestTurnRun?.status === 'running', 'owner turn not running');
    await request(boss, `/api/chats/${source.id}`, { method: 'PATCH', body: { preferredModel: 'gpt-6-astra', preferredEffort: 'low' }, expect: 409 });
    const rejected = await json(boss, `/api/admin/projects/${busyProject.id}/shares`, { method: 'POST', body: { userId: firstUser.id }, expect: 409 });
    assert.equal(rejected.error.code, 'WORKSPACE_BUSY');
    await request(boss, `/api/chats/${source.id}/interrupt`, { method: 'POST' });
    await (await running).text();
    assert.equal((await json(boss, '/api/admin/dashboard')).projects.find((item) => item.id === busyProject.id).sharedAccesses.length, 0);
    await request(boss, `/api/projects/${busyProject.id}`, { method: 'DELETE' });
  });

  await t.test('clean revoke and new share list only the new access chat copies', async () => {
    const cleanProject = (await json(boss, '/api/projects', { method: 'POST', body: { name: 'Clean regrant' }, expect: 201 })).project;
    await json(boss, `/api/projects/${cleanProject.id}/chats`, { method: 'POST', body: { title: 'Empty share history' }, expect: 201 });
    const grant = async () => (await json(boss, `/api/admin/projects/${cleanProject.id}/shares`, { method: 'POST', body: { userId: secondUser.id }, expect: 201 })).access;
    const previous = await grant();
    const second = await login('gatesecond', passwords.second);
    const oldChats = (await json(second, `/api/projects/${cleanProject.id}/chats`)).chats;
    assert.equal(oldChats.length, 1);
    await request(boss, `/api/admin/projects/${cleanProject.id}/shares/${previous.id}`, { method: 'DELETE' });
    const next = await grant();
    assert.notEqual(next.id, previous.id);
    const currentChats = (await json(second, `/api/projects/${cleanProject.id}/chats`)).chats;
    assert.equal(currentChats.length, 1);
    assert.notEqual(currentChats[0].id, oldChats[0].id);
    await request(second, `/api/chats/${oldChats[0].id}`, { expect: 403 });
    await request(boss, `/api/admin/projects/${cleanProject.id}/shares/${next.id}`, { method: 'DELETE' });
    await request(boss, `/api/projects/${cleanProject.id}`, { method: 'DELETE' });
  });

  await t.test('fork failure rolls back authorization and owner remains usable', async () => {
    const failedProject = (await json(boss, '/api/projects', { method: 'POST', body: { name: 'Fork failure isolation' }, expect: 201 })).project;
    const source = (await json(boss, `/api/projects/${failedProject.id}/chats`, { method: 'POST', body: { title: 'Failing fork' }, expect: 201 })).chat;
    await request(boss, `/api/chats/${source.id}/turns`, { method: 'POST', body: { prompt: '[[fork-fail]]', mode: 'edit' } });
    await request(boss, `/api/admin/projects/${failedProject.id}/shares`, { method: 'POST', body: { userId: firstUser.id }, expect: 502 });
    assert.equal((await json(boss, '/api/admin/dashboard')).projects.find((item) => item.id === failedProject.id).sharedAccesses.length, 0);
    const first = await login('gatefirst', passwords.first);
    await request(first, `/api/projects/${failedProject.id}/chats`, { expect: 403 });
    await request(boss, `/api/chats/${source.id}/turns`, { method: 'POST', body: { prompt: 'Owner still works', mode: 'edit' } });
    await request(boss, `/api/projects/${failedProject.id}`, { method: 'DELETE' });
  });

  await t.test('reserved path matching ignores case and recoverable trash remains quota-accounted', async () => {
    const first = await login('gatefirst', passwords.first);
    const before = (await json(first, '/api/me')).usage;
    await request(first, `/api/projects/${project.id}/file?path=.GIT/config`, { expect: 403 });
    const payload = Buffer.alloc(4096, 5);
    await request(first, `/api/projects/${project.id}/file?path=trash-quota.bin&overwrite=0`, {
      method: 'PUT', body: payload, headers: { 'content-type': 'application/octet-stream' },
    });
    const afterWrite = (await json(first, '/api/me')).usage;
    assert.equal(afterWrite.bytes, before.bytes + payload.length);
    await request(first, `/api/projects/${project.id}/file?path=trash-quota.bin`, { method: 'DELETE' });
    const afterTrash = (await json(first, '/api/me')).usage;
    assert.equal(afterTrash.bytes, afterWrite.bytes);
    assert.equal(afterTrash.files, afterWrite.files);
  });

  await t.test('same-project chats run concurrently while browser mutations stay locked until all turns terminate', async () => {
    const first = await login('gatefirst', passwords.first);
    const heldChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Held turn' }, expect: 201,
    })).chat;
    const queuedChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Queued turn' }, expect: 201,
    })).chat;
    assert.equal(heldChat.preferredMode, 'execute');
    assert.equal(queuedChat.preferredMode, 'execute');
    const heldMode = (await json(first, `/api/chats/${heldChat.id}`, {
      method: 'PATCH', body: { preferredMode: 'edit' },
    })).chat;
    assert.equal(heldMode.preferredMode, 'edit');
    assert.equal((await json(first, `/api/chats/${queuedChat.id}`)).chat.preferredMode, 'execute');
    const heldResponsePromise = request(first, `/api/chats/${heldChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[hold]] keep workspace leased', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(first, `/api/chats/${heldChat.id}`)).latestTurnRun?.status === 'running', 'held turn never started');
    const blockedWrite = await (await request(first, `/api/projects/${project.id}/file?path=blocked.txt&overwrite=0`, {
      method: 'PUT', body: 'must not write', headers: { 'content-type': 'application/octet-stream' }, expect: 409,
    })).json();
    assert.equal(blockedWrite.error.code, 'WORKSPACE_BUSY');

    const concurrentResponse = await request(first, `/api/chats/${queuedChat.id}/turns`, {
      method: 'POST', body: { prompt: 'run concurrently with the held turn', mode: 'edit', effort: 'low' },
    });
    assert.ok(parseSse(await concurrentResponse.text()).some((event) => event.event === 'turn_completed'));
    assert.equal((await json(first, `/api/chats/${heldChat.id}`)).latestTurnRun?.status, 'running');
    await request(first, `/api/chats/${heldChat.id}/interrupt`, { method: 'POST' });
    const heldResponse = await heldResponsePromise;
    assert.ok(parseSse(await heldResponse.text()).some((event) => event.event === 'turn_error'));
    await request(first, `/api/projects/${project.id}/file?path=after-drain.txt&overwrite=0`, {
      method: 'PUT', body: 'write succeeds after drain', headers: { 'content-type': 'application/octet-stream' },
    });
    const opened = await json(first, `/api/projects/${project.id}/file?path=after-drain.txt`);
    assert.match(opened.version, /^[0-9a-f]{64}$/);
    await request(first, `/api/projects/${project.id}/file?path=after-drain.txt&overwrite=1`, {
      method: 'PUT', body: 'new editor version',
      headers: { 'content-type': 'application/octet-stream', 'if-match': `"${opened.version}"` },
    });
    const conflict = await (await request(first, `/api/projects/${project.id}/file?path=after-drain.txt&overwrite=1`, {
      method: 'PUT', body: 'stale overwrite',
      headers: { 'content-type': 'application/octet-stream', 'if-match': `"${opened.version}"` }, expect: 409,
    })).json();
    assert.equal(conflict.error.code, 'FILE_VERSION_CONFLICT');
    assert.equal((await json(first, `/api/projects/${project.id}/file?path=after-drain.txt`)).content, 'new editor version');
  });

  await t.test('an owner project cannot be deleted until its active turn reaches a terminal state', async () => {
    const disposableProject = (await json(boss, '/api/projects', {
      method: 'POST', body: { name: 'Busy delete gate', description: 'project lifecycle barrier' }, expect: 201,
    })).project;
    const disposableChat = (await json(boss, `/api/projects/${disposableProject.id}/chats`, {
      method: 'POST', body: { title: 'Busy project turn' }, expect: 201,
    })).chat;
    const heldTurn = request(boss, `/api/chats/${disposableChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[hold]] keep project lifecycle busy', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(boss, `/api/chats/${disposableChat.id}`)).latestTurnRun?.status === 'running',
      'owner project turn never started');
    const blocked = await (await request(boss, `/api/projects/${disposableProject.id}`, {
      method: 'DELETE', expect: 409,
    })).json();
    assert.equal(blocked.error.code, 'PROJECT_BUSY');
    await request(boss, `/api/chats/${disposableChat.id}/interrupt`, { method: 'POST' });
    assert.ok(parseSse(await (await heldTurn).text()).some((event) => event.event === 'turn_error'));
    await request(boss, `/api/projects/${disposableProject.id}`, { method: 'DELETE' });
  });

  await t.test('task turn, immutable Git submission, owner delivery, review, and cursor replay form one auditable workflow', async () => {
    const roadmap = (await json(boss, '/api/admin/roadmaps', {
      method: 'POST', expect: 201, body: {
        projectId: project.id, title: 'Two-person release', status: 'ready',
        steps: [
          { assigneeUserId: firstUser.id, title: 'Implement gate one', acceptance: 'Return a completed Codex final item.' },
          { assigneeUserId: secondUser.id, title: 'Verify gate two', acceptance: 'Second employee becomes active.' },
        ],
      },
    })).roadmap;
    await request(boss, `/api/admin/roadmaps/${roadmap.id}/activate`, { method: 'POST' });
    const first = await login('gatefirst', passwords.first);
    const activeTask = (await json(first, '/api/tasks')).tasks.find((item) => item.status === 'active');
    taskChat = (await json(first, `/api/tasks/${activeTask.id}/chat`, { method: 'POST' })).chat;
    const turnResponse = await request(first, `/api/chats/${taskChat.id}/turns`, {
      method: 'POST', body: { prompt: 'gate private prompt', mode: 'edit', effort: 'low' },
    });
    const liveEvents = parseSse(await turnResponse.text());
    assert.ok(liveEvents.some((event) => event.event === 'turn_completed'));
    const chatData = await json(first, `/api/chats/${taskChat.id}`);
    const assistant = [...chatData.messages].reverse().find((message) => message.role === 'assistant');
    completedRun = chatData.latestTurnRun;
    assert.equal(completedRun.status, 'completed');
    const submission = (await json(first, `/api/tasks/${activeTask.id}/submissions`, {
      method: 'POST', expect: 201, body: {
        taskVersion: activeTask.version, chatId: taskChat.id, turnRunId: assistant.metadata.turnRunId,
        itemId: assistant.metadata.finalItemId, note: 'gate evidence',
      },
    })).submission;
    assert.equal(submission.projectAccessId, firstAccess.id);
    assert.match(submission.snapshotCommitSha, /^[0-9a-f]{40,64}$/);
    assert.match(submission.snapshotTreeSha, /^[0-9a-f]{40,64}$/);
    await request(boss, `/api/projects/${project.id}/file?path=employee-one-only.txt`, { expect: 404 });
    const blockedDelete = await (await request(first, `/api/chats/${taskChat.id}`, { method: 'DELETE', expect: 409 })).json();
    assert.equal(blockedDelete.error.code, 'CHAT_HAS_SUBMISSION');
    const review = await json(boss, `/api/admin/task-submissions/${submission.id}/review`, { method: 'POST', body: { verdict: 'passed' } });
    assert.match(review.submission.deliveryCommitSha, /^[0-9a-f]{40,64}$/);
    assert.equal((await json(boss, `/api/projects/${project.id}/file?path=employee-one-only.txt`)).content, 'private work in progress');
    const second = await login('gatesecond', passwords.second);
    assert.equal((await json(second, '/api/tasks')).tasks.some((task) => task.status === 'active'), true);

    const unrelatedChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Cross-chat replay denial' }, expect: 201,
    })).chat;
    await request(first, `/api/chats/${unrelatedChat.id}/turn-runs/${completedRun.id}/events`, { expect: 403 });
    await request(second, `/api/chats/${taskChat.id}/turn-runs/${completedRun.id}/events`, { expect: 403 });

    const replayResponse = await request(first, `/api/chats/${taskChat.id}/turn-runs/${completedRun.id}/events`, {
      headers: { 'last-event-id': '0' },
    });
    const replayText = await replayResponse.text();
    const replay = parseSse(replayText);
    assert.ok(replay.length > 0);
    assert.ok(replay.every((event, index) => index === 0 || event.id > replay[index - 1].id));
    assert.equal(replayText.includes('gate private prompt'), false);
    assert.equal(replayText.includes('fake secret diff body'), false);
    const afterFirst = await request(first, `/api/chats/${taskChat.id}/turn-runs/${completedRun.id}/events?after=${replay[0].id}`);
    assert.ok(parseSse(await afterFirst.text()).every((event) => event.id > replay[0].id));
    const auditText = JSON.stringify(await json(boss, '/api/admin/audit?limit=1000'));
    assert.equal(auditText.includes('gate private prompt'), false);
    assert.equal(auditText.includes('fake secret diff body'), false);
  });

  await t.test('password reset revokes sessions and drains the employee turn before returning', async () => {
    const second = await login('gatesecond', passwords.second);
    const resetChat = (await json(second, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Password reset drain' }, expect: 201,
    })).chat;
    const heldTurn = request(second, `/api/chats/${resetChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[hold]] password reset must drain', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(second, `/api/chats/${resetChat.id}`)).latestTurnRun?.status === 'running',
      'password reset test turn never started');
    const nextPassword = 'EmployeeTwoReset!123';
    await request(boss, `/api/admin/users/${secondUser.id}`, { method: 'PATCH', body: { password: nextPassword } });
    assert.ok(parseSse(await (await heldTurn).text()).some((event) => event.event === 'turn_error'));
    await request(second, '/api/me', { expect: 401 });
    passwords.second = nextPassword;
    await login('gatesecond', passwords.second);
  });

  await t.test('revocation preserves a dirty tree and regrant restores the same access', async () => {
    const firstBeforeRevoke = await login('gatefirst', passwords.first);
    const inheritedBefore = (await json(firstBeforeRevoke, `/api/projects/${project.id}/chats`)).chats.filter((chat) => chat.sharedAt);
    await request(firstBeforeRevoke, `/api/projects/${project.id}/file?path=retained-quota.bin&overwrite=0`, {
      method: 'PUT', body: Buffer.alloc(1024 ** 2 + 1, 7), headers: { 'content-type': 'application/octet-stream' },
    });
    const drainingChat = (await json(firstBeforeRevoke, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Revoke drain gate' }, expect: 201,
    })).chat;
    const drainingTurn = request(firstBeforeRevoke, `/api/chats/${drainingChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[hold]] revoke must drain this turn', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(firstBeforeRevoke, `/api/chats/${drainingChat.id}`)).latestTurnRun?.status === 'running', 'revoke test turn never started');
    const revoked = await json(boss, `/api/admin/projects/${project.id}/shares/${firstAccess.id}`, { method: 'DELETE' });
    assert.ok(parseSse(await (await drainingTurn).text()).some((event) => event.event === 'turn_error'));
    assert.equal(revoked.cleanup.dirty, true);
    const first = await login('gatefirst', passwords.first);
    await request(first, `/api/projects/${project.id}`, { expect: 403 });
    await request(boss, `/api/admin/users/${firstUser.id}`, {
      method: 'PATCH', body: { maxStorageBytes: 1024 ** 2 },
    });
    const quotaBlocked = await (await request(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id }, expect: 413,
    })).json();
    assert.equal(quotaBlocked.error.code, 'STORAGE_QUOTA');
    await request(first, `/api/projects/${project.id}`, { expect: 403 });
    await request(boss, `/api/admin/users/${firstUser.id}`, {
      method: 'PATCH', body: { maxStorageBytes: 1024 ** 3 },
    });
    const restored = await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id },
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.access.id, firstAccess.id);
    const relogged = await login('gatefirst', passwords.first);
    const inheritedAfter = (await json(relogged, `/api/projects/${project.id}/chats`)).chats.filter((chat) => chat.sharedAt);
    assert.deepEqual(inheritedAfter.map((chat) => chat.id).sort(), inheritedBefore.map((chat) => chat.id).sort());
    assert.equal((await json(relogged, `/api/projects/${project.id}/file?path=employee-one-only.txt`)).content, 'private work in progress');
  });

  await t.test('revocation during an in-flight upload prevents the final write and preserves the original access binding', async () => {
    const first = await login('gatefirst', passwords.first);
    const upload = startChunkedUpload(first, `/api/projects/${project.id}/file?path=revoked-upload.txt&overwrite=0`, 'partial-');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await json(boss, `/api/admin/projects/${project.id}/shares/${firstAccess.id}`, { method: 'DELETE' });
    upload.req.end('must-not-land');
    const response = await upload.response;
    assert.equal(response.status, 403, response.body);
    assert.equal(JSON.parse(response.body).error.code, 'PROJECT_FORBIDDEN');

    const restored = await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id },
    });
    assert.equal(restored.restored, true);
    assert.equal(restored.access.id, firstAccess.id);
    const relogged = await login('gatefirst', passwords.first);
    await request(relogged, `/api/projects/${project.id}/file?path=revoked-upload.txt`, { expect: 404 });
  });

  await t.test('restart resume failure preserves mapping and requires an acknowledged recovery', async () => {
    const first = await login('gatefirst', passwords.first);
    const recoveryChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Recovery gate chat' }, expect: 201,
    })).chat;
    await (await request(first, `/api/chats/${recoveryChat.id}/turns`, {
      method: 'POST', body: { prompt: 'establish native thread', mode: 'edit', effort: 'low' },
    })).text();
    const before = (await json(first, `/api/chats/${recoveryChat.id}`)).chat;
    await stopServer();
    await startServer({ failResume: true });
    const failedTurn = await request(first, `/api/chats/${recoveryChat.id}/turns`, {
      method: 'POST', body: { prompt: 'must not silently replace thread', mode: 'edit', effort: 'low' },
    });
    assert.ok(parseSse(await failedTurn.text()).some((event) => event.event === 'turn_error'));
    const failed = (await json(first, `/api/chats/${recoveryChat.id}`)).chat;
    assert.equal(failed.codexThreadId, before.codexThreadId);
    assert.equal(failed.threadState, 'resume_failed');
    await request(first, `/api/chats/${recoveryChat.id}/thread/recover`, {
      method: 'POST', body: { action: 'reset', acknowledgeContextReset: false }, expect: 409,
    });
    const recovered = await json(first, `/api/chats/${recoveryChat.id}/thread/recover`, {
      method: 'POST', body: { action: 'reset', acknowledgeContextReset: true },
    });
    assert.notEqual(recovered.chat.codexThreadId, before.codexThreadId);
    assert.equal(recovered.chat.threadState, 'ready');
    assert.deepEqual(recovered.recoveries.map((item) => item.oldThreadId), [before.codexThreadId]);
  });
});
