import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { BrowserService, browserProfile } from '../../src/browser-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await check(); if (value) return value; await delay(80); } throw new Error('Browser gate timed out'); }
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }

test('real isolated Chrome: Portal display/input/takeover, roles, ACL, recovery and cleanup', { timeout: 150000 }, async t => {
  assert.equal(process.platform, 'darwin', 'Browser release gate requires macOS Seatbelt');
  assert.ok(fs.existsSync(binary), 'Chrome must be installed for the release gate');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-browser-gate-')));
  const sessionsRoot = path.join(base, 'browser-sessions');
  let processHandle, ui, logs = '', origin, verified = 0, dragged = 0, scrolled = 0;
  const site = http.createServer((req, res) => {
    if (req.url === '/verified') { verified++; res.end('ok'); return; }
    if (req.url === '/dragged') { dragged++; res.end('ok'); return; }
    if (req.url === '/scrolled') { scrolled++; res.end('ok'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Controlled verification</title><style>body{margin:30px}#name{position:absolute;left:70px;top:80px;height:30px}#password{position:absolute;left:300px;top:80px;height:30px}#verify{position:absolute;left:550px;top:80px;height:30px}a{position:absolute;left:550px;top:140px}#drag{position:absolute;left:70px;top:170px;width:100px;height:50px;background:lightblue}</style>
      <p id="body">Verification required</p><label>Name<input id="name" aria-label="姓名"></label><label>Password<input id="password" type="password"></label>
      <button id="verify">Verify</button><a target="_blank" href="/second">Second tab</a><div id="drag" draggable="true">Drag</div><div style="height:1500px"></div>
      <script>if(document.cookie.includes('verified=1')||localStorage.getItem('login'))document.querySelector('#body').textContent='Verified article body';drag.ondragend=()=>fetch('/dragged',{method:'POST'});onscroll=()=>fetch('/scrolled',{method:'POST'});verify.onclick=()=>{if(document.querySelector('#name').value==='中文输入'&&password.value==='human-private-marker'){document.cookie='verified=1';localStorage.setItem('login','yes');document.querySelector('#body').textContent='Verified article body';fetch('/verified',{method:'POST'});}};</script>`);
  });
  const siteOrigin = await listen(site);
  const reserve = http.createServer(); origin = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const start = async () => {
    processHandle = spawn(process.execPath, ['src/server.mjs'], { cwd: ROOT, env: { ...process.env,
      HOST: '127.0.0.1', PORT: new URL(origin).port, TRUST_PROXY: 'false', TRUST_PROXY_PROVIDER: 'generic', COOKIE_SECURE: 'false',
      PUBLIC_ORIGIN: '', PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '',
      DATA_DIR: base, DATABASE_PATH: path.join(base, 'harness.sqlite'), WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'),
      RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash'), DEFAULT_NETWORK_ACCESS: 'true', ADMIN_USERNAME: 'browserboss', ADMIN_PASSWORD: 'BrowserTestPassword!123',
      CODEX_BIN: path.join(ROOT, 'test/fixtures/fake-codex.mjs'), CODEX_MODEL_PROVIDER: 'openai_http',
      PORTAL_BROWSER_ENABLED: 'true', PORTAL_BROWSER_HANDOFF_TIMEOUT_MS: '60000', MEMORY_ENABLED: 'false',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    processHandle.stdout.on('data', bytes => { logs += bytes; }); processHandle.stderr.on('data', bytes => { logs += bytes; });
    await until(async () => { try { return (await (await fetch(origin + '/api/health')).json()).codex; } catch { return false; } });
  };
  const stop = async () => { if (!processHandle || processHandle.exitCode !== null) return; const done = new Promise(resolve => processHandle.once('exit', resolve)); processHandle.kill('SIGTERM'); await done; };
  t.after(async () => { await ui?.close(); await stop(); await new Promise(resolve => site.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
  await start();
  const req = async (session, url, method = 'GET', body, expected = 200, extra = {}) => {
    const response = await fetch(origin + url, { method, headers: { ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf, ...(session.selector ? { 'x-portal-session': session.selector } : {}) } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, expected, `${method} ${url}: ${await response.clone().text()}`); return response;
  };
  const json = async (...args) => (await req(...args)).json();
  const login = async (username, password, selector) => {
    const response = await req(null, username === 'browserboss' ? '/api/boss/login' : '/api/employee/login', 'POST', { username, password, ...(selector ? { sessionSelector: selector } : {}) });
    const session = { cookie: response.headers.get('set-cookie').split(';')[0], csrf: '', selector };
    const me = await json(session, '/api/me'); session.csrf = me.csrfToken; return session;
  };
  const boss = await login('browserboss', 'BrowserTestPassword!123');
  const employeeData = await json(boss, '/api/admin/users', 'POST', { username: 'browserstaff', displayName: 'Browser Staff', password: 'BrowserStaffPassword!123', networkAccess: true }, 201);
  // Boss network is explicit too.
  const me = await json(boss, '/api/me');
  if (!me.user.networkAccess) await json(boss, '/api/admin/users/' + me.user.id, 'PATCH', { networkAccess: true });
  const employee = await login('browserstaff', 'BrowserStaffPassword!123', 'abcdef0123456789abcdef0123456789');
  const makeChat = async (session, name) => {
    const { project } = await json(session, '/api/projects', 'POST', { name }, 201);
    const { chat } = await json(session, `/api/projects/${project.id}/chats`, 'POST', { title: name }, 201); return { project, chat };
  };
  const b = await makeChat(boss, 'Browser boss'), e = await makeChat(employee, 'Browser staff');
  const endpoint = chat => `/api/chats/${chat.id}/browser`;
  const run = (session, chat) => req(session, `/api/chats/${chat.id}/turns`, 'POST', { mode: 'execute', prompt: '[[browser]]' + JSON.stringify({ url: siteOrigin }) });
  const bossTurn = run(boss, b.chat), employeeTurn = run(employee, e.chat);
  await until(async () => (await json(boss, endpoint(b.chat))).handoff && (await json(employee, endpoint(e.chat))).handoff);
  assert.equal(fs.readdirSync(sessionsRoot).length, 2);
  await req(employee, endpoint(b.chat), 'GET', undefined, 403);
  await req(null, endpoint(b.chat) + '/frame', 'GET', undefined, 401);
  await req(boss, endpoint(b.chat) + '/control', 'POST', { decision: 'takeover' }, 403, { 'x-csrf-token': 'wrong' });
  await req(boss, endpoint(b.chat), 'GET', undefined, 403, { origin: 'https://untrusted.invalid' });
  const jpeg = Buffer.from(await (await req(boss, endpoint(b.chat) + '/frame')).arrayBuffer()); assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
  const profiles = fs.readdirSync(sessionsRoot).map(name => path.join(sessionsRoot, name));
  const outside = path.join(base, 'host-secret'); fs.writeFileSync(outside, 'must-not-read');
  const probe = spawnSync('/usr/bin/sandbox-exec', ['-p', browserProfile(profiles[0], binary).replaceAll('__PORTAL_BROWSER_PID__', '999999'), '/bin/sh', '-c',
    'test ! -r "$1" && test ! -r "$2" && test ! -r "$3" && echo ISOLATED', 'probe', outside, path.join(profiles[1], 'profile/Local State'), path.join(os.homedir(), '.codex/auth.json')], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr); assert.match(probe.stdout, /ISOLATED/);
  // Drive the actual Portal drawer, including canvas coordinates and Chinese IME.
  const uiRoot = path.join(base, 'ui'); fs.mkdirSync(uiRoot);
  ui = await chromium.launchPersistentContext(path.join(uiRoot, 'profile'), { executablePath: path.join(ROOT, 'bin/browser-launch.sh'), chromiumSandbox: false,
    headless: true, viewport: { width: 1400, height: 1100 }, env: { PATH: '/usr/bin:/bin', HOME: uiRoot, CFFIXED_USER_HOME: uiRoot, TMPDIR: uiRoot + '/', MAC_CHROMIUM_TMPDIR: uiRoot,
      PORTAL_BROWSER_BIN: binary, PORTAL_BROWSER_PROFILE: browserProfile(uiRoot, binary) }, args: ['--disable-gpu', '--password-store=basic', '--use-mock-keychain'] });
  const page = ui.pages()[0];
  await ui.addCookies([{ name: boss.cookie.split('=')[0], value: boss.cookie.split('=')[1], url: origin }]);
  await page.goto(`${origin}/boss/workbench?view=workbench&project=${b.project.id}&chat=${b.chat.id}`);
  const drawer = page.locator('.browser-drawer');
  await drawer.waitFor({ state: 'visible' });
  await drawer.locator('[data-takeover]').click();
  await until(async () => (await json(boss, endpoint(b.chat))).control === 'human');
  await until(() => drawer.locator('[data-keyboard]').isEnabled());
  const canvas = drawer.locator('canvas');
  const clickAt = async (x, y) => { const box = await canvas.boundingBox(); await page.mouse.click(box.x + x * box.width / 1100, box.y + y * box.height / 760); };
  await clickAt(180, 95);
  const input = drawer.locator('[data-keyboard]');
  await input.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionstart')); el.value = '中文输入'; el.dispatchEvent(new CompositionEvent('compositionend', { data: '中文输入' })); });
  await clickAt(420, 95); await input.fill('human-private-marker');
  await clickAt(570, 95);
  await until(() => verified === 1, 10000);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 100 * box.width / 1100, box.y + 190 * box.height / 760); await page.mouse.down();
  for (let step = 1; step <= 5; step++) { await page.mouse.move(box.x + (100 + step * 30) * box.width / 1100, box.y + (190 + step * 10) * box.height / 760); await delay(100); }
  await page.mouse.up(); await until(() => dragged > 0, 10000);
  await canvas.hover(); await page.mouse.wheel(0, 400); await until(() => scrolled > 0, 10000);
  await page.mouse.wheel(0, -2000); await delay(300);
  const firstTab = (await json(boss, endpoint(b.chat))).tabId;
  await clickAt(590, 150); await until(async () => (await json(boss, endpoint(b.chat))).tabs.length === 2);
  await until(async () => (await drawer.locator('[data-tabs] option').count()) === 2);
  await drawer.locator('[data-tabs]').selectOption(firstTab);
  // HTTP also enforces ownership when another login attempts input.
  const anotherBoss = await login('browserboss', 'BrowserTestPassword!123');
  await req(anotherBoss, endpoint(b.chat) + '/actions', 'POST', { action: 'text', text: 'must-not-insert' }, 409);
  // Refresh keeps the same browser and handoff state.
  const before = (await json(boss, endpoint(b.chat))).id; await page.reload(); await drawer.waitFor({ state: 'visible' });
  assert.equal((await json(boss, endpoint(b.chat))).id, before);
  await drawer.locator('[data-continue]').click();
  const result = await (await bossTurn).text(); assert.match(result, /Verified article body/); assert.doesNotMatch(result, /human-private-marker/);
  assert.equal((await json(boss, endpoint(b.chat))).state, 'closed');
  // Employee profile never received the boss login cookie/storage.
  await json(employee, endpoint(e.chat) + '/control', 'POST', { decision: 'takeover' });
  await json(employee, endpoint(e.chat) + '/actions', 'POST', { action: 'reload' });
  await json(employee, endpoint(e.chat) + '/control', 'POST', { decision: 'continue' });
  assert.match(await (await employeeTurn).text(), /Verification required/);
  const events = await json(boss, `/api/chats/${b.chat.id}/events`);
  assert.doesNotMatch(JSON.stringify(events.events), /human-private-marker|Verified article body/);
  const details = await json(boss, `/api/chats/${b.chat.id}/tool-calls`);
  assert.doesNotMatch(JSON.stringify(details), /human-private-marker|Verified article body/);
  assert.equal(fs.readdirSync(sessionsRoot).length, 0);
  assert.equal(spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout.includes(sessionsRoot), false, 'Chrome helpers must exit');
  const restricted = (await json(boss, '/api/admin/users', 'POST', { username: 'browserrestricted', password: 'BrowserRestricted!123', networkAccess: false }, 201)).user;
  const management = await ui.newPage(); await management.goto(origin + '/boss');
  await management.locator('#new-user').click();
  assert.equal(await management.locator('[name=networkAccess]').isChecked(), true);
  await management.keyboard.press('Escape');
  await management.locator(`[data-card="${restricted.id}"] [data-open-card]`).click();
  assert.equal(await management.locator('[name=networkAccess]').isChecked(), false);
  await management.close();
  // Stop and restart close real Chrome and discard state.
  const finalTurn = run(employee, e.chat);
  await until(async () => (await json(employee, endpoint(e.chat))).handoff);
  await stop(); await finalTurn.catch(() => {});
  assert.equal(fs.readdirSync(sessionsRoot).length, 0);
  await start(); assert.equal((await json(employee, endpoint(e.chat))).state, 'closed');
  assert.doesNotMatch(logs, /human-private-marker/);
  assert.ok(employeeData.user.id);
});

test('real browser retains login across upstream node changes and temporary proxy interruption', { timeout: 60000 }, async t => {
  assert.equal(process.platform, 'darwin');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-proxy-gate-')));
  let node = 'A', offline = false;
  const hits = [];
  const proxy = http.createServer((req, res) => {
    hits.push(node);
    if (offline) { req.socket.destroy(); return; }
    const loggedIn = req.headers.cookie?.includes('test-login=yes');
    res.writeHead(200, { 'content-type': 'text/html', ...(loggedIn ? {} : { 'set-cookie': 'test-login=yes; Path=/; HttpOnly' }) });
    res.end(`<title>Controlled proxy</title><p>NODE_${node}_${loggedIn ? 'LOGIN_RETAINED' : 'LOGIN_STARTED'}</p>`);
  });
  const proxyOrigin = await listen(proxy);
  const user = { id: 'proxy-user', status: 'active', networkAccess: true };
  const project = { id: 'proxy-project', accessId: 'proxy-access', projectType: 'standard' };
  const chat = { id: 'proxy-chat', userId: user.id, projectAccessId: project.accessId };
  const browser = new BrowserService({ config: { rootDir: ROOT, browserEnabled: true, browserBin: binary, browserSessionsRoot: root, outboundProxy: proxyOrigin },
    db: { getUserById: () => user, getChat: () => chat, getProjectForUser: () => project } });
  const active = { user, project, chat, mode: 'execute', turnRunId: 'proxy-run' };
  t.after(async () => { await browser.stop(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const url = 'http://article.proxy.test/';
  const open = async suffix => {
    try { return await browser.open(active, url + suffix); }
    catch (error) { throw new Error(`Browser proxy stage ${suffix || 'initial'} failed; observed nodes ${hits.join(',')}`, { cause: error }); }
  };
  assert.match((await open('')).text, /NODE_A_LOGIN_STARTED/);
  const page = browser.sessions.get(chat.id).page;
  const id = browser.state(chat.id).id;
  node = 'B';
  assert.match((await open('next')).text, /NODE_B_LOGIN_RETAINED/);
  offline = true;
  const errorPage = page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
  await assert.rejects(browser.open(active, url + 'offline'), { code: 'BROWSER_OPERATION_FAILED' });
  await errorPage; await page.waitForLoadState('domcontentloaded');
  assert.equal(browser.state(chat.id).id, id);
  offline = false;
  assert.match((await open('recovered')).text, /NODE_B_LOGIN_RETAINED/);
  assert.equal(browser.state(chat.id).id, id); assert.ok(hits.includes('A') && hits.includes('B'));
});
