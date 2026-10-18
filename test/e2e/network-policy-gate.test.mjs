import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 15000; while (Date.now() < end) { if (await check()) return; await wait(50); } throw new Error('Policy gate timed out'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }

test('network defaults preserve old restrictions and a boss toggle takes effect in the same employee chat/session', { timeout: 60000 }, async t => {
  assert.equal(process.platform, 'darwin', 'Network release gate requires Seatbelt');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-policy-'));
  let hits = 0, child;
  const proxy = http.createServer((req, res) => { hits++; res.end('PROXY_DOWNLOAD_OK'); });
  const proxyPort = await listen(proxy);
  const reserved = http.createServer(), port = await listen(reserved); await new Promise(resolve => reserved.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const stop = async () => { if (!child || child.exitCode !== null) return; const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; };
  t.after(async () => { await stop(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  const start = async () => {
    child = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env,
      HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false', TRUST_PROXY_PROVIDER: 'generic', COOKIE_SECURE: 'false',
      PUBLIC_ORIGIN: '', PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '',
      DATA_DIR: base, DATABASE_PATH: path.join(base, 'harness.sqlite'), WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'),
      RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash'), DEFAULT_NETWORK_ACCESS: 'true',
      OUTBOUND_PROXY: `http://127.0.0.1:${proxyPort}`, ADMIN_USERNAME: 'policyboss', ADMIN_PASSWORD: 'PolicyFixturePassword!123',
      CODEX_BIN: path.join(ROOT, 'test/fixtures/fake-codex.mjs'), CODEX_MODEL_PROVIDER: 'openai_http', PORTAL_MEMORY_ENABLED: 'false',
    }, stdio: 'ignore' });
    await until(async () => { try { return (await (await fetch(origin + '/api/health')).json()).codex; } catch { return false; } });
  };
  const json = async (session, route, method = 'GET', body, expected = 200) => {
    const response = await fetch(origin + route, { method, headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, expected, `${method} ${route}`); return response.json();
  };
  const login = async (username, boss = false) => {
    const response = await fetch(origin + (boss ? '/api/boss/login' : '/api/employee/login'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: 'PolicyFixturePassword!123' }) });
    assert.equal(response.status, 200); const session = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: '' };
    const me = await json(session, '/api/me'); session.csrf = me.csrfToken; return session;
  };
  await start();
  const boss = await login('policyboss', true);
  assert.equal((await json(boss, '/api/me')).user.networkAccess, true);
  assert.equal((await json(boss, '/api/admin/dashboard')).defaults.networkAccess, true);
  const create = body => json(boss, '/api/admin/users', 'POST', { password: 'PolicyFixturePassword!123', ...body }, 201);
  const old = (await create({ username: 'policyold', networkAccess: false })).user;
  const fresh = (await create({ username: 'policynew' })).user;
  assert.equal(old.networkAccess, false); assert.equal(fresh.networkAccess, true);
  const employee = await login('policyold');
  const { project } = await json(employee, '/api/projects', 'POST', { name: 'Policy fixture' }, 201);
  const { chat } = await json(employee, `/api/projects/${project.id}/chats`, 'POST', { title: 'Same chat' }, 201);
  const run = async command => {
    const response = await fetch(origin + `/api/chats/${chat.id}/turns`, { method: 'POST', headers: { cookie: employee.cookie, 'x-csrf-token': employee.csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'execute', prompt: '[[workspace-exec]]' + JSON.stringify({ command }) }) });
    assert.equal(response.status, 200); await response.text();
    const details = await json(employee, `/api/chats/${chat.id}/tool-calls`);
    const item = details.items.find(item => item.name === 'workspace_exec'); assert.ok(item, 'Actual command evidence required'); return item;
  };
  const command = 'curl -fsS --max-time 3 http://download.proxy.test/repository';
  assert.notEqual((await run(`curl --proxy http://127.0.0.1:${proxyPort} -fsS --max-time 3 http://download.proxy.test/repository`)).exitCode, 0);
  assert.equal(hits, 0);
  // Restart must not migrate existing account flags to the new default.
  await stop(); await start();
  assert.equal((await json(employee, '/api/me')).user.networkAccess, false);
  assert.equal((await json(boss, '/api/admin/users')).users.find(user => user.id === fresh.id).networkAccess, true);
  await json(boss, '/api/admin/users/' + old.id, 'PATCH', { networkAccess: true });
  const allowed = await run(command); assert.equal(allowed.exitCode, 0); assert.match(allowed.output, /PROXY_DOWNLOAD_OK/); assert.equal(hits, 1);
  assert.equal((await json(employee, '/api/chats/' + chat.id)).chat.id, chat.id);
  const held = fetch(origin + `/api/chats/${chat.id}/turns`, { method: 'POST', headers: { cookie: employee.cookie, 'x-csrf-token': employee.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '[[hold]]', mode: 'execute' }) });
  await until(async () => ['starting', 'running'].includes((await json(employee, '/api/chats/' + chat.id)).latestTurnRun?.status));
  await json(boss, '/api/admin/users/' + old.id, 'PATCH', { networkAccess: false });
  assert.equal((await held).status, 200); await (await held).text();
  assert.equal((await json(employee, '/api/chats/' + chat.id)).latestTurnRun.status, 'interrupted');
  const before = hits;
  const denied = await run(`curl --proxy http://127.0.0.1:${proxyPort} -fsS --max-time 3 http://download.proxy.test/repository`);
  assert.notEqual(denied.exitCode, 0); assert.equal(hits, before);
});
