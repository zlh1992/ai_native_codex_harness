import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('fixed role hosts enforce ingress before routes and preserve role login and local HTTP', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-ingress-e2e-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: 'ignore', env: {
    ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: data,
    DATABASE_PATH: path.join(data, 'db.sqlite'), WORKSPACES_ROOT: path.join(data, 'workspaces'),
    TREES_ROOT: path.join(data, 'trees'), RUNTIME_ROOT: path.join(data, 'runtime'), TRASH_ROOT: path.join(data, 'trash'),
    PUBLIC_ORIGIN: '', PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: 'https://boss.example.com',
    EMPLOYEE_PUBLIC_ORIGIN: 'https://staff.example.com', TRUST_PROXY: 'true', TRUST_PROXY_PROVIDER: 'cloudflare', COOKIE_SECURE: 'false',
    CODEX_BIN: path.join(root, 'test/fixtures/fake-codex.mjs'), PORTAL_MEMORY_ENABLED: 'false', WORK_GRAPH_DISPATCH_ENABLED: 'false',
    ADMIN_USERNAME: 'ingressboss', ADMIN_PASSWORD: 'IngressFixturePassword!123',
  } });
  const request = (url, headers = {}, body) => new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: url, method: body ? 'POST' : 'GET', headers: {
      host: 'boss.example.com', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9',
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.setTimeout(3000, () => r.destroy(new Error('HTTP timeout')));
    r.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, 'Portal should remain running');
      try { ready = JSON.parse((await request('/api/health')).text).codex === true; } catch { /* starting */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true);
    for (const [host, destination] of [['boss.example.com', '/boss/login'], ['staff.example.com', '/employee']]) {
      const redirect = await request('/', { host });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.location, destination);
      assert.equal((await request(destination, { host })).status, 200);
      assert.equal((await request('/api/me', { host })).status, 401);
    }
    assert.equal((await request('/api/health', { host: 'evil.example.com' })).status, 421);
    assert.equal((await request('/api/health', { 'cf-connecting-ip': 'spoofed' })).status, 400);
    const credentials = { username: 'ingressboss', password: 'IngressFixturePassword!123' };
    assert.equal((await request('/api/boss/login', { origin: 'https://staff.example.com' }, credentials)).status, 403);
    const login = await request('/api/boss/login', { origin: 'https://boss.example.com', 'x-forwarded-for': '198.51.100.2' }, credentials);
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /HttpOnly; SameSite=Strict/);
    assert.doesNotMatch(cookie, /Domain=/i);
    assert.equal((await request('/api/me', { cookie: cookie.split(';')[0] })).status, 200);
    assert.equal((await request('/api/employee/login', { host: 'staff.example.com', origin: 'https://staff.example.com' }, credentials)).status, 403);
    const local = await request('/api/boss/login', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }, credentials);
    assert.equal(local.status, 200);
    assert.doesNotMatch(local.headers['set-cookie'][0], /; Secure/);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
