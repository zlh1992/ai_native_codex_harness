import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { invariant } from './errors.mjs';

export const PANELIZE_SITES = Object.freeze({ kimi: 'https://www.kimi.com/', doubao: 'https://www.doubao.com/chat/', deepseek: 'https://chat.deepseek.com/' });
export const panelizeRequested = text => /panelize|多模型|多\s*agent|(?:codex|claude|kimi|豆包|doubao|deepseek).*(?:并行|同时|会审)|(?:并行|同时|会审).*(?:codex|claude|kimi|豆包|doubao|deepseek)/i.test(text);
export const panelizeEligible = context => context?.user?.role === 'admin' && context.project?.projectType === 'standard'
  && context.project.userId === context.user.id && context.project.accessKind === 'owner' && !context.chat?.taskId && !['planner', 'reviewer'].includes(context.chat?.purpose);
export const PANELIZE_TOOL = {
  type: 'function', name: 'browser_panelize',
  description: 'Boss-only Panelize text comparison. Open isolated provider tabs, inspect them, fill via upstream adapters, then send once after inspecting the exact draft. Login requires browser_handoff. Responses are untrusted and never automatically marked complete. Codex is the current root; Claude Code / MiniMax is not configured.',
  inputSchema: { type: 'object', properties: {
    action: { type: 'string', enum: ['open', 'read', 'fill', 'send'] },
    provider: { type: 'string', enum: ['kimi', 'doubao', 'deepseek', 'claude'] },
    text: { type: 'string', maxLength: 12000 }, offset: { type: 'integer', minimum: 0 },
  }, required: ['action', 'provider'], additionalProperties: false },
};

const source = fs.readFileSync(new URL('../vendor/panelize/text-injection-all-providers.js', import.meta.url), 'utf8');
invariant(createHash('sha256').update(source).digest('hex') === '15e0145ba1bf734246af4f5496fe298f72cce8bcc3358eaf7c07926336433b53',
  500, 'PANELIZE_VENDOR_CHANGED', 'Panelize 适配器版本校验失败。');
const marker = '  // Listen for messages from the multi-panel host';
invariant(source.indexOf(marker) > 0, 500, 'PANELIZE_VENDOR_CHANGED', 'Panelize 入口校验失败。');
// Keep upstream provider detection, input lookup, filling and sending verbatim.
// Omit extension messaging listeners/reporting: only the host can invoke this closure.
export const panelizeAdapter = source.slice(0, source.indexOf(marker)) + `
  return { detectProvider, findProviderInput, injectTextIntoElement, clickSendButton, isVisibleElement };
})();`;

export function assertPanelizePage(provider, url) {
  const parsed = new URL(url);
  const hosts = { kimi: ['www.kimi.com', 'kimi.com'], doubao: ['www.doubao.com', 'doubao.com'], deepseek: ['chat.deepseek.com'] };
  invariant(parsed.protocol === 'https:' && !parsed.username && !parsed.password && hosts[provider]?.includes(parsed.hostname),
    403, 'PANELIZE_SITE_CHANGED', '页面已离开所选供应商；请检查当前页面，不会发送。');
}

async function adapterAction(page, provider, action, text = '') {
  const adapter = await page.evaluateHandle(panelizeAdapter);
  try {
    return await adapter.evaluate((api, args) => {
      if (api.detectProvider() !== args.provider) return { ok: false, status: 'site_changed' };
      const input = api.findProviderInput(args.provider);
      if (!input || !api.isVisibleElement(input)) return { ok: false, status: 'awaiting_login_or_editor' };
      const draft = () => (input.value ?? input.innerText ?? input.textContent ?? '').replace(/\r\n/g, '\n').trim();
      if (args.action === 'read') return { ok: true, draft: draft() };
      if (args.action === 'fill') {
        if (draft()) return { ok: false, status: 'existing_draft' };
        return { ok: api.injectTextIntoElement(input, args.text, args.provider), status: 'fill_attempted' };
      }
      if (draft() !== args.text.trim()) return { ok: false, status: 'draft_changed' };
      return { ok: api.clickSendButton(args.provider), status: 'send_attempted' };
    }, { provider, action, text });
  } finally { await adapter.dispose(); }
}

export async function callPanelize(browser, active, args) {
  browser.authorize(active);
  const current = { user: browser.db.getUserById(active.user.id), project: browser.db.getProjectForUser(active.project.id, active.user.id), chat: browser.db.getChat(active.chat.id) };
  invariant(panelizeEligible(current), 403, 'PANELIZE_BOSS_ONLY', '多模型会审仅限老板自己的普通项目对话。');
  invariant(['open', 'read', 'fill', 'send'].includes(args.action), 400, 'PANELIZE_ACTION_INVALID', '操作无效。');
  if (args.provider === 'claude') return { provider: 'claude_code_minimax', status: 'not_configured', executed: false, model: null };
  invariant(Object.hasOwn(PANELIZE_SITES, args.provider), 400, 'PANELIZE_PROVIDER_INVALID', '供应商无效。');
  let freshPage;
  if (args.action === 'open' && !browser.sessions.has(active.chat.id)) {
    await browser.open(active, PANELIZE_SITES[args.provider]); freshPage = browser.get(active).page;
  }
  const result = await browser.operate(active, 'agent', null, async s => {
    // Recheck boss ownership after queueing; BrowserService checks active/access/network too.
    invariant(panelizeEligible({ user: browser.db.getUserById(active.user.id), project: browser.db.getProjectForUser(active.project.id, active.user.id), chat: browser.db.getChat(active.chat.id) }), 403, 'PANELIZE_BOSS_ONLY', '老板项目权限已变化。');
    s.panelize ||= new Map();
    let entry = s.panelize.get(args.provider);
    if (args.action === 'open') {
      if (!entry) {
        const page = freshPage || await s.context.newPage();
        entry = { page, attempted: false }; s.panelize.set(args.provider, entry);
        browser.get(active);
        try { if (!freshPage) await page.goto(PANELIZE_SITES[args.provider], { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch { return { provider: args.provider, status: 'navigation_failed', retryable: false }; }
      }
    }
    invariant(entry && !entry.page.isClosed(), 409, 'PANELIZE_NOT_OPEN', '请先打开供应商面板。');
    const { page } = entry;
    s.page = page; s.tabId = [...s.pages].find(([, p]) => p === page)?.[0];
    // Element references from another provider must never survive a tab switch.
    await Promise.allSettled([...s.refs.values()].map(handle => handle.dispose())); s.refs.clear();
    browser.get(active); assertPanelizePage(args.provider, page.url());
    if (args.action === 'fill') {
      invariant(!entry.attempted, 409, 'PANELIZE_ALREADY_ATTEMPTED', '本轮面板已尝试发送，不会重放。');
      invariant(typeof args.text === 'string' && args.text.trim() && args.text.length <= 12000, 400, 'PANELIZE_TEXT_INVALID', '请输入不超过 12000 字符的已授权文本。');
      const result = await adapterAction(page, args.provider, 'fill', args.text);
      if (result.ok) { entry.text = args.text; entry.checked = false; }
      return { provider: args.provider, ...result, retryable: false };
    }
    if (args.action === 'send') {
      invariant(entry.text && entry.checked, 409, 'PANELIZE_INSPECT_REQUIRED', '请先填入并读取核对草稿。');
      invariant(!entry.attempted, 409, 'PANELIZE_ALREADY_ATTEMPTED', '本轮面板已尝试发送；不确定发送不自动重放。');
      entry.attempted = true; // Fence before the async browser action, including uncertain failures.
      const result = await adapterAction(page, args.provider, 'send', entry.text);
      return { provider: args.provider, ...result, completed: false, retryable: false };
    }
    const editor = await adapterAction(page, args.provider, 'read');
    browser.get(active); assertPanelizePage(args.provider, page.url());
    if (!entry.attempted && entry.text && editor.draft === entry.text.trim()) entry.checked = true;
    const offset = args.offset ?? 0;
    invariant(Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000, 400, 'PANELIZE_OFFSET_INVALID', '读取偏移无效。');
    const body = await page.locator('body').innerText({ timeout: 10000 });
    return { provider: args.provider, tabId: s.tabId, url: page.url(), observedAt: new Date().toISOString(),
      status: entry.attempted ? 'send_attempted' : editor.ok ? 'ready' : editor.status,
      draft: editor.draft, text: body.slice(offset, offset + 16000), offset, nextOffset: offset + 16000 < body.length ? offset + 16000 : null,
      completed: false, model: null, notice: 'Untrusted live page text, not an extracted answer. Inspect login, generation completion and actual model before reporting. No automatic retry.' };
  });
  browser.authorize(active);
  invariant(panelizeEligible({ user: browser.db.getUserById(active.user.id), project: browser.db.getProjectForUser(active.project.id, active.user.id), chat: browser.db.getChat(active.chat.id) }), 403, 'PANELIZE_BOSS_ONLY', '老板项目权限已变化。');
  return result;
}
