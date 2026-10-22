import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, limit = 30000) { const end = Date.now() + limit; while (Date.now() < end) { const value = await fn(); if (value) return value; await delay(100); } throw new Error('dispatch acceptance timed out'); }

test('dispatch HTTP and Chrome: old conversation upgrade, ACL, immutable inputs, login deep link, refresh and read receipt', { timeout: 150000 }, async t => {
  assert.equal(process.platform, 'darwin');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dispatch-e2e-'));
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = `http://127.0.0.1:${port}`;
  let server, browser, logs = '';
  const stop = async () => { if (!server || server.exitCode !== null) return; const done = new Promise(r => server.once('exit', r)); server.kill('SIGTERM'); await done; };
  const start = async enabled => {
    server = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env,
      HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false', COOKIE_SECURE: 'false', TRUST_PROXY_PROVIDER: 'generic',
      PUBLIC_ORIGIN: '', PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '',
      DATA_DIR: base, DATABASE_PATH: path.join(base, 'db.sqlite'), WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'), RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash'),
      ADMIN_USERNAME: 'dispatchboss', ADMIN_PASSWORD: 'DispatchFixture!123', CODEX_BIN: path.join(ROOT, 'test/fixtures/fake-codex.mjs'),
      TASK_DISPATCH_ENABLED: String(enabled), WEIXIN_ENABLED: 'false', PORTAL_MEMORY_ENABLED: 'false', LOCAL_QWEN_ENABLED: 'false',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
    await until(async () => { if (server.exitCode !== null) throw new Error(`server exited: ${logs.slice(-2000)}`); try { return (await (await fetch(`${origin}/api/health`)).json()).codex; } catch { return false; } });
  };
  t.after(async () => { await browser?.close(); await stop(); fs.rmSync(base, { force: true, recursive: true }); });
  const request = async (session, url, { method = 'GET', body, status = 200, headers = {} } = {}) => {
    if (session) Object.assign(headers, { cookie: session.cookie, 'x-csrf-token': session.csrf || '' });
    if (body && !Buffer.isBuffer(body)) { headers['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const res = await fetch(`${origin}${url}`, { method, headers, body });
    assert.equal(res.status, status, `${method} ${url}: ${await res.clone().text()}`); return res;
  };
  const json = async (...args) => (await request(...args)).json();
  const login = async (username, boss = false) => {
    const res = await request(null, `/api/${boss ? 'boss' : 'employee'}/login`, { method: 'POST', body: { username, password: 'DispatchFixture!123' } });
    const session = { cookie: res.headers.get('set-cookie').split(';')[0] }; session.csrf = (await json(session, '/api/me')).csrfToken; return session;
  };
  await start(false); const boss = await login('dispatchboss', true);
  const { user: employee } = await json(boss, '/api/admin/users', { method: 'POST', status: 201, body: { username: 'dispatchstaff', displayName: '张三', password: 'DispatchFixture!123', maxStorageBytes: 1024 ** 3 } });
  const { user: other } = await json(boss, '/api/admin/users', { method: 'POST', status: 201, body: { username: 'dispatchother', displayName: '李四', password: 'DispatchFixture!123' } });
  const staff = await login('dispatchstaff'), stranger = await login(other.username);
  const { project } = await json(boss, '/api/projects', { method: 'POST', status: 201, body: { name: '老板收件箱' } });
  const { chat } = await json(boss, `/api/projects/${project.id}/chats`, { method: 'POST', status: 201, body: { title: '现有对话' } });
  const bytes = Buffer.from('客户方案背景资料');
  await request(boss, `/api/projects/${project.id}/file?path=brief.txt`, { method: 'PUT', body: bytes });
  await request(boss, `/api/projects/${project.id}/file?path=private.txt`, { method: 'PUT', body: Buffer.from('Do not share') });
  await (await request(boss, `/api/chats/${chat.id}/turns`, { method: 'POST', body: { prompt: '上一轮资料在 brief.txt，先记住，不派发。', mode: 'edit' } })).text();
  await stop(); await start(true);
  const prompt = `把上一轮资料派发给张三 [[dispatch-upgrade]]${JSON.stringify({ projectId: project.id, employeeId: employee.id, captureKey: randomUUID(), dispatchKey: randomUUID() })}`;
  const turn = await (await request(boss, `/api/chats/${chat.id}/turns`, { method: 'POST', body: { prompt, mode: 'execute' } })).text();
  assert.doesNotMatch(turn, /Dispatch fixture failed|SKILL_NOT_FOUND/);
  const receipt = await until(async () => { const r = (await json(boss, `/api/task-dispatches?chat=${chat.id}`)).dispatches[0]; return r?.status === 'published' && r; });
  assert.notEqual(receipt.projectId, project.id); assert.equal(receipt.tasks.length, 1); assert.equal(receipt.attachmentCount, 1);
  assert.equal(receipt.tasks[0].weixin, 'not_bound');
  const taskId = receipt.tasks[0].id;
  await until(async () => (await json(staff, `/api/tasks/${taskId}`)).task.status === 'active');
  const { inputs } = await json(staff, `/api/tasks/${taskId}/inputs`); assert.equal(inputs.files.length, 1);
  const download = Buffer.from(await (await request(staff, `/api/tasks/${taskId}/inputs/${inputs.files[0].id}?revision=1&download=1`)).arrayBuffer());
  assert.deepEqual(download, bytes); assert.equal(createHash('sha256').update(download).digest('hex'), inputs.files[0].sha256);
  await request(stranger, `/api/tasks/${taskId}/inputs/${inputs.files[0].id}?download=1`, { status: 403 });
  await request(staff, `/api/projects/${project.id}/materials`, { status: 403 });
  assert.equal((await json(staff, '/api/task-notifications')).notifications[0].readAt, null);
  browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${origin}/employee?view=tasks&task=${taskId}`);
  await page.locator('#login-username').fill('dispatchstaff'); await page.locator('#login-password').fill('DispatchFixture!123');
  await page.locator('#login-form button').click();
  await page.locator('#work-graph-drawer[open]').waitFor();
  assert.match(await page.locator('#work-graph-drawer').innerText(), /输入资料.*第 1 版/s);
  assert.match(await page.locator('#work-graph-drawer').innerText(), /brief.txt/);
  assert.equal(new URL(page.url()).searchParams.get('task'), taskId);
  await until(async () => (await json(staff, '/api/task-notifications')).notifications[0].readAt);
  await page.reload(); await page.locator('#work-graph-drawer[open]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'), taskId);
  await page.getByRole('button', { name: '进入任务对话', exact: true }).click();
  await until(async () => new URL(page.url()).searchParams.get('chat'));
  assert.equal((await json(staff, `/api/tasks/${taskId}`)).task.status, 'active');
  await page.goBack(); await page.locator('#work-graph-drawer[open]').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('task'), taskId); assert.deepEqual(errors, []);
  const { material: second } = await json(boss, `/api/projects/${project.id}/materials?chat=${chat.id}&name=extra.zip`, { method: 'POST', status: 201, headers: { 'idempotency-key': randomUUID() }, body: Buffer.from('opaque ZIP') });
  const task = (await json(staff, `/api/tasks/${taskId}`)).task;
  await json(boss, `/api/tasks/${taskId}/inputs`, { method: 'POST', status: 201, body: { taskVersion: task.version, expectedRevision: 1, attachmentIds: [second.id], idempotencyKey: randomUUID() } });
  assert.equal((await json(staff, `/api/tasks/${taskId}/inputs`)).inputs.revision, 2);
  assert.deepEqual(Buffer.from(await (await request(staff, `/api/tasks/${taskId}/inputs/${inputs.files[0].id}?revision=1&download=1`)).arrayBuffer()), bytes);
});
