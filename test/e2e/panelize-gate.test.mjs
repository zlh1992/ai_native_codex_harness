import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserService } from '../../src/browser-service.mjs';

const rootDir = fileURLToPath(new URL('../../', import.meta.url));
test('Panelize real Seatbelt Chrome: upstream fill/send, parallel tabs, drafts, replay fence, takeover and teardown', { timeout: 90000 }, async t => {
  assert.equal(process.platform, 'darwin');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'panelize-gate-')));
  const user = { id: 'boss', role: 'admin', status: 'active', networkAccess: true };
  const project = { id: 'project', userId: user.id, accessId: 'access', accessKind: 'owner', projectType: 'standard' };
  const chat = { id: 'chat', userId: user.id, projectAccessId: project.accessId };
  const db = { getUserById: () => user, getChat: () => chat, getProjectForUser: () => project, getSession: () => ({}) };
  const browser = new BrowserService({ config: { rootDir, browserEnabled: true, outboundProxy: 'direct', browserBin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', browserSessionsRoot: path.join(base, 'sessions') }, db });
  const active = { user, project, chat, mode: 'execute', turnRunId: 'run' };
  t.after(async () => { await browser.stop(); fs.rmSync(base, { recursive: true, force: true }); });
  // Bootstrap without external network. Real browser + upstream DOM adapters,
  // controlled provider pages: deliberately not a claim of live account acceptance.
  await browser.open(active, 'http://127.0.0.1:1').catch(error => assert.equal(error.code, 'BROWSER_NAVIGATION_FAILED'));
  const s = browser.get(active);
  await s.context.route('https://**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><p>Controlled provider</p><div contenteditable="true" role="textbox" class="chat-input-editor" style="width:400px;height:80px;border:1px solid" id="chat-input"></div><button type="submit" aria-label="发送" class="send-button">Send</button><p id="answer"></p><script>window.sends=0;document.querySelector('button').onclick=()=>{window.sends++;document.querySelector('#answer').textContent='completed controlled answer';document.querySelector('[contenteditable]').textContent='';};</script>` }));
  const call = args => browser.call(active, 'browser_panelize', args);
  for (const provider of ['kimi', 'doubao', 'deepseek']) {
    const opened = await call({ action: 'open', provider });
    assert.equal(opened.provider, provider); assert.equal(opened.completed, false);
    const entry = s.panelize.get(provider);
    await entry.page.locator('[contenteditable]').fill('preserve existing draft');
    assert.equal((await call({ action: 'fill', provider, text: 'new question' })).status, 'existing_draft', provider);
    assert.equal(await entry.page.locator('[contenteditable]').innerText(), 'preserve existing draft');
    await entry.page.locator('[contenteditable]').fill('');
    assert.equal((await call({ action: 'fill', provider, text: 'new question' })).ok, true);
    await assert.rejects(call({ action: 'send', provider }), { code: 'PANELIZE_INSPECT_REQUIRED' });
    const read = await call({ action: 'read', provider }); assert.equal(read.draft, 'new question');
    const sent = await call({ action: 'send', provider }); assert.equal(sent.ok, true, provider); assert.equal(sent.completed, false);
    assert.equal(await entry.page.evaluate(() => window.sends), 1, provider);
    await assert.rejects(call({ action: 'send', provider }), { code: 'PANELIZE_ALREADY_ATTEMPTED' });
    assert.match((await call({ action: 'read', provider })).text, /completed controlled answer/);
  }
  assert.equal(s.panelize.size, 3);
  const first = s.panelize.get('kimi').page;
  await first.goto('https://example.invalid/');
  await assert.rejects(call({ action: 'read', provider: 'kimi' }), { code: 'PANELIZE_SITE_CHANGED' });
  user.networkAccess = false;
  await assert.rejects(call({ action: 'open', provider: 'claude' }), { code: 'NETWORK_DISABLED' });
  user.networkAccess = true;
  await browser.control(active, 'takeover', 'session');
  let returned = false;
  const pending = call({ action: 'send', provider: 'deepseek' }).then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(returned, false);
  await browser.control(active, 'continue', 'session');
  assert.equal((await pending).errorCode, 'BROWSER_PAGE_CHANGED');
  const profile = s.root;
  active.interruptRequested = true;
  await assert.rejects(call({ action: 'read', provider: 'deepseek' }), { code: 'BROWSER_RUN_REQUIRED' });
  await browser.close(chat.id); assert.equal(fs.existsSync(profile), false);
});
