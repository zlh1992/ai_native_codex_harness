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
  const request = (url, headers = {}, body, method = body ? 'POST' : 'GET') => new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: {
      host: 'boss.example.com', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9',
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    r.on('error', reject);
    r.setTimeout(3000, () => r.destroy(new Error('HTTP timeout')));
    r.end(typeof body === 'string' ? body : body ? JSON.stringify(body) : undefined);
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
    assert.equal((await request('/?project=fixture')).headers.location, '/boss/login?project=fixture');
    assert.equal((await request('/index.html')).headers.location, '/boss/login');
    for (const page of ['/boss/login', '/boss/workbench', '/employee']) {
      const canonical = await request(`${page}/`);
      assert.equal(canonical.status, 308); assert.equal(canonical.headers.location, page);
    }
    assert.equal((await request('/missing-page')).status, 404);
    const sortable = await request('/vendor/sortable.js');
    assert.equal(sortable.status, 200); assert.match(sortable.text, /Sortable 1\.15\.7/);
    assert.equal((await request('/vendor/package.json')).status, 404);
    const pageHtml = (await request('/employee')).text;
    const entry = pageHtml.match(/src="(\/assets\/[a-f0-9]{20}\/app\.js)"/)?.[1];
    assert.ok(entry, 'live HTML must use a content-versioned entrypoint');
    const prefix = entry.slice(0, -'/app.js'.length);
    for (const filename of ['app.js', 'navigation.js', 'session-ui.js', 'employee-session.js', 'work-graph.js', 'kanban.js', 'portal-ui.css', 'vendor/sortable.js']) {
      const asset = await request(`${prefix}/${filename}`);
      assert.equal(asset.status, 200, filename); assert.match(asset.headers['cache-control'], /immutable/);
      if (filename === 'kanban.js') assert.ok(asset.text.includes(`import('${prefix}/vendor/sortable.js')`));
    }
    assert.equal((await request('/assets/00000000000000000000/app.js')).status, 404);
    assert.equal((await request(`${prefix}/package.json`)).status, 404);
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
    const authHeaders = { cookie: cookie.split(';')[0], origin: 'https://boss.example.com' };
    const me = JSON.parse((await request('/api/me', authHeaders)).text);
    authHeaders['x-csrf-token'] = me.csrfToken;
    // One browser Cookie jar, two tab selectors, plus a separate device for the same user.
    const staffOrigin = { host: 'staff.example.com', origin: 'https://staff.example.com' };
    const staff = [];
    for (let i = 0; i < 2; i++) {
      const username = `tabemployee${i}`; const password = 'SyntheticTabPassword!123';
      const createdUser = await request('/api/admin/users', authHeaders, { username, password });
      assert.equal(createdUser.status, 201);
      const selector = String(i + 1).repeat(32);
      const response = await request('/api/employee/login', { ...staffOrigin, 'cf-connecting-ip': `203.0.113.${20+i}` }, { username, password, sessionSelector: selector });
      assert.equal(response.status, 200); assert.match(response.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
      assert.doesNotMatch(response.headers['set-cookie'][0], /Domain=/i);
      staff.push({ username, password, selector, cookie: response.headers['set-cookie'][0].split(';')[0] });
    }
    const jar = staff.map(s => s.cookie).join('; '); // Both tabs send ALL cookies, exactly like Chrome.
    for (const s of staff) {
      s.headers = { ...staffOrigin, cookie: jar, 'x-portal-session': s.selector };
      const identity = JSON.parse((await request('/api/me', s.headers)).text);
      assert.equal(identity.user.username, s.username); s.headers['x-csrf-token'] = identity.csrfToken;
      const p = await request('/api/projects', s.headers, { name: `${s.username} private project` });
      assert.equal(p.status, 201); s.project = JSON.parse(p.text).project;
      const c = await request(`/api/projects/${s.project.id}/chats`, s.headers, { title: `${s.username} chat` });
      assert.equal(c.status, 201); s.chat = JSON.parse(c.text).chat;
      assert.equal((await request(`/api/projects/${s.project.id}/file?path=private.txt`, s.headers, s.username, 'PUT')).status, 200);
    }
    for (const [i,s] of staff.entries()) {
      const other = staff[1-i];
      assert.deepEqual(JSON.parse((await request('/api/projects',s.headers)).text).projects.map(p=>p.id),[s.project.id]);
      assert.equal((await request(`/api/chats/${s.chat.id}`,s.headers)).status,200);
      assert.equal((await request(`/api/chats/${other.chat.id}`,s.headers)).status,403);
      assert.equal((await request(`/api/projects/${other.project.id}`,s.headers)).status,403);
      const headers = { ...staffOrigin,cookie:jar };
      assert.equal((await request(`/api/projects/${s.project.id}/raw?path=private.txt&portal_session=${s.selector}`,headers)).text,s.username);
      assert.equal((await request(`/api/projects/${s.project.id}/events?format=json&portal_session=${s.selector}`,headers)).status,200);
      assert.equal((await request(`/api/projects/${other.project.id}/raw?path=private.txt&portal_session=${s.selector}`,headers)).status,403);
    }
    assert.equal((await request('/api/me',{...staff[0].headers,'x-portal-session':'none'})).status,401);
    assert.equal((await request('/api/me',{...staffOrigin,'x-portal-session':staff[0].selector})).status,401,'selector alone is not a credential');
    assert.equal((await request(`/api/me?portal_session=${staff[1].selector}`,staff[0].headers)).status,401,'conflicting selectors fail closed');
    assert.equal((await request('/api/logout',{...staff[0].headers,'x-csrf-token':staff[1].headers['x-csrf-token']},{})).status,403);
    const anotherDevice = await request('/api/employee/login',{...staffOrigin,'cf-connecting-ip':'198.51.100.77'},
      {username:staff[0].username,password:staff[0].password,sessionSelector:'3'.repeat(32)});
    assert.equal(anotherDevice.status,200);
    const deviceHeaders={...staffOrigin,cookie:anotherDevice.headers['set-cookie'][0].split(';')[0],'x-portal-session':'3'.repeat(32)};
    assert.equal((await request(`/api/chats/${staff[0].chat.id}`,deviceHeaders)).status,200);
    const staffLogout=await request('/api/logout',staff[0].headers,{});
    assert.equal(staffLogout.status,200);assert.ok(staffLogout.headers['set-cookie'][0].startsWith(`codex_harness_session_${staff[0].selector}=`));
    assert.equal((await request('/api/me',staff[0].headers)).status,401);
    assert.equal(JSON.parse((await request('/api/me',staff[1].headers)).text).user.username,staff[1].username);
    assert.equal((await request(`/api/chats/${staff[0].chat.id}`,deviceHeaders)).status,200);
    assert.equal((await request('/api/me',authHeaders)).status,200,'employee logout does not revoke boss');
    const created = await request('/api/projects', authHeaders, { name: 'Navigation fixture' });
    assert.equal(created.status, 201);
    const project = JSON.parse(created.text).project;
    const rawPath = `/api/projects/${project.id}/raw?path=range.txt`;
    assert.equal((await request(`/api/projects/${project.id}/file?path=range.txt`, authHeaders, '0123456789', 'PUT')).status, 200);
    for (const [range, expected, contentRange] of [
      ['bytes=0-3', '0123', 'bytes 0-3/10'], ['bytes=-4', '6789', 'bytes 6-9/10'],
      ['bytes=8-', '89', 'bytes 8-9/10'], ['bytes=8-999', '89', 'bytes 8-9/10'],
      ['bytes=-999', '0123456789', 'bytes 0-9/10'],
    ]) {
      const result = await request(rawPath, { ...authHeaders, range });
      assert.equal(result.status, 206); assert.equal(result.text, expected);
      assert.equal(result.headers['content-range'], contentRange);
      assert.equal(Number(result.headers['content-length']), expected.length);
    }
    const invalidRange = await request(rawPath, { ...authHeaders, range: 'bytes=10-' });
    assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers['content-range'], 'bytes */10');
    assert.equal((await request(rawPath, { range: 'bytes=-4' })).status, 401, 'range never bypasses auth');
    const chat = JSON.parse((await request(`/api/projects/${project.id}/chats`, authHeaders, { title: 'Session stream fixture' })).text).chat;
    const live = await new Promise((resolve, reject) => {
      const r = http.request({ hostname: '127.0.0.1', port, path: `/api/chats/${chat.id}/turns`, method: 'POST', headers: {
        ...authHeaders, host: 'boss.example.com', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json',
      } }, res => { res.resume(); resolve(res); });
      r.on('error', reject); r.end(JSON.stringify({ prompt: '[[hold]] navigation fixture', mode: 'edit' }));
    });
    assert.equal(live.statusCode, 200);
    let run;
    for (let i = 0; i < 60; i++) {
      run = JSON.parse((await request(`/api/chats/${chat.id}`, authHeaders)).text).latestTurnRun;
      if (run?.status === 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(run?.status, 'running');
    const replay = await new Promise((resolve, reject) => {
      const r = http.get({ hostname: '127.0.0.1', port, path: `/api/chats/${chat.id}/turn-runs/${run.id}/events`, headers: {
        ...authHeaders, host: 'boss.example.com', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.9',
      } }, res => { res.resume(); resolve(res); }); r.on('error', reject);
    });
    assert.equal(replay.statusCode, 200);
    const ended = Promise.all([once(live, 'end'), once(replay, 'end')]);
    const logout = await request('/api/logout', authHeaders, {});
    assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Max-Age=0/);
    let deadline;
    try { await Promise.race([ended, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('logged-out streams did not close')), 2000); })]); }
    finally { clearTimeout(deadline); live.destroy(); replay.destroy(); }
    assert.equal((await request('/api/me', authHeaders)).status, 401);
    const otherHeaders = { origin: 'https://boss.example.com', cookie: local.headers['set-cookie'][0].split(';')[0] };
    const otherMe = JSON.parse((await request('/api/me', otherHeaders)).text);
    otherHeaders['x-csrf-token'] = otherMe.csrfToken;
    assert.equal(otherMe.user.id, me.user.id, 'other session remains valid');
    assert.equal(JSON.parse((await request(`/api/chats/${chat.id}`, otherHeaders)).text).latestTurnRun.status, 'running', 'logout must not cancel the background task');
    assert.equal((await request(`/api/chats/${chat.id}/interrupt`, otherHeaders, {})).status, 200);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
});
