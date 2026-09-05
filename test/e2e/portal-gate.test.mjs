import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
  const response = await request(null, '/api/login', { method: 'POST', body: { username, password } });
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
    firstAccess = (await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: firstUser.id }, expect: 201,
    })).access;
    const secondAccess = (await json(boss, `/api/admin/projects/${project.id}/shares`, {
      method: 'POST', body: { userId: secondUser.id }, expect: 201,
    })).access;
    assert.notEqual(firstAccess.id, secondAccess.id);
    const dashboard = await json(boss, '/api/admin/dashboard');
    assert.equal(dashboard.projects.find((item) => item.id === project.id).sharedAccesses.length, 2);

    const first = await login('gatefirst', passwords.first);
    const second = await login('gatesecond', passwords.second);
    assert.equal((await json(first, `/api/projects/${project.id}/file?path=owner-snapshot.txt`)).content, 'owner uncommitted snapshot');
    await request(first, `/api/projects/${project.id}/file?path=employee-one-only.txt&overwrite=0`, {
      method: 'PUT', body: 'private work in progress', headers: { 'content-type': 'application/octet-stream' },
    });
    await request(second, `/api/projects/${project.id}/file?path=employee-one-only.txt`, { expect: 404 });
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

  await t.test('same-worktree turns serialize and browser mutations stay locked until terminal state', async () => {
    const first = await login('gatefirst', passwords.first);
    const heldChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Held turn' }, expect: 201,
    })).chat;
    const queuedChat = (await json(first, `/api/projects/${project.id}/chats`, {
      method: 'POST', body: { title: 'Queued turn' }, expect: 201,
    })).chat;
    const heldResponsePromise = request(first, `/api/chats/${heldChat.id}/turns`, {
      method: 'POST', body: { prompt: '[[hold]] keep workspace leased', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(first, `/api/chats/${heldChat.id}`)).latestTurnRun?.status === 'running', 'held turn never started');
    const blockedWrite = await (await request(first, `/api/projects/${project.id}/file?path=blocked.txt&overwrite=0`, {
      method: 'PUT', body: 'must not write', headers: { 'content-type': 'application/octet-stream' }, expect: 409,
    })).json();
    assert.equal(blockedWrite.error.code, 'WORKSPACE_BUSY');

    const queuedResponsePromise = request(first, `/api/chats/${queuedChat.id}/turns`, {
      method: 'POST', body: { prompt: 'run only after the held turn', mode: 'edit', effort: 'low' },
    });
    await waitUntil(async () => (await json(first, `/api/chats/${queuedChat.id}`)).latestTurnRun?.status === 'queued', 'second turn did not queue');
    await request(first, `/api/chats/${heldChat.id}/interrupt`, { method: 'POST' });
    const heldResponse = await heldResponsePromise;
    const queuedResponse = await queuedResponsePromise;
    assert.ok(parseSse(await heldResponse.text()).some((event) => event.event === 'turn_error'));
    assert.ok(parseSse(await queuedResponse.text()).some((event) => event.event === 'turn_completed'));
    await request(first, `/api/projects/${project.id}/file?path=after-drain.txt&overwrite=0`, {
      method: 'PUT', body: 'write succeeds after drain', headers: { 'content-type': 'application/octet-stream' },
    });
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

  await t.test('task turn, immutable submission, review, and cursor replay form one auditable workflow', async () => {
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
    const blockedDelete = await (await request(first, `/api/chats/${taskChat.id}`, { method: 'DELETE', expect: 409 })).json();
    assert.equal(blockedDelete.error.code, 'CHAT_HAS_SUBMISSION');
    await request(boss, `/api/admin/task-submissions/${submission.id}/review`, { method: 'POST', body: { verdict: 'passed' } });
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
    assert.equal((await json(relogged, `/api/projects/${project.id}/file?path=employee-one-only.txt`)).content, 'private work in progress');
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
