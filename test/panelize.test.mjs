import test from 'node:test';
import assert from 'node:assert/strict';
import { panelizeEligible, panelizeRequested, assertPanelizePage, callPanelize } from '../src/panelize.mjs';

const user = { id: 'boss', role: 'admin', status: 'active', networkAccess: true };
const project = { id: 'p', userId: 'boss', accessId: 'a', accessKind: 'owner', projectType: 'standard' };
const chat = { id: 'c', userId: 'boss' };

test('Panelize eligibility rejects employee/shared/private/workflow/task contexts', () => {
  assert.equal(panelizeEligible({ user, project, chat }), true);
  for (const ctx of [
    { user: { ...user, role: 'user' }, project, chat },
    { user, project: { ...project, accessKind: 'shared' }, chat },
    { user, project: { ...project, userId: 'staff' }, chat },
    { user, project: { ...project, projectType: 'local_private' }, chat },
    { user, project, chat: { ...chat, purpose: 'reviewer' } },
    { user, project, chat: { ...chat, purpose: 'planner' } },
    { user, project, chat: { ...chat, taskId: 'task' } },
  ]) assert.equal(panelizeEligible(ctx), false);
});

test('Panelize explicit activation and exact HTTPS provider origin', () => {
  for (const text of ['$panelize-multi-agent 问题', '多模型会审', '同时让 kimi 和豆包回答', 'Codex 和 DeepSeek 并行']) assert.equal(panelizeRequested(text), true);
  assert.equal(panelizeRequested('解释这段代码'), false);
  assert.doesNotThrow(() => assertPanelizePage('kimi', 'https://www.kimi.com/chat/example'));
  for (const url of ['http://www.kimi.com/', 'https://www.kimi.com.evil.invalid/', 'https://user:secret@www.kimi.com/', 'https://www.doubao.com/']) assert.throws(() => assertPanelizePage('kimi', url), { code: 'PANELIZE_SITE_CHANGED' });
});

test('empty Claude configuration never launches a process or browser; current boss is revalidated', async () => {
  let currentUser = user, checks = 0;
  const browser = { authorize: () => { checks++; }, db: { getUserById: () => currentUser, getProjectForUser: () => project, getChat: () => chat } };
  assert.deepEqual(await callPanelize(browser, { user, project, chat }, { action: 'open', provider: 'claude' }), { provider: 'claude_code_minimax', status: 'not_configured', executed: false, model: null });
  currentUser = { ...user, role: 'user' };
  await assert.rejects(callPanelize(browser, { user, project, chat }, { action: 'open', provider: 'claude' }), { code: 'PANELIZE_BOSS_ONLY' });
  assert.equal(checks, 2);
});
