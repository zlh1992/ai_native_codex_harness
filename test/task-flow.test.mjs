import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { taskConversationState } from '../public/task-flow.js';
import { WorkGraphUI } from '../public/work-graph.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = name => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const chat = { id: 'C', taskId: 'T', taskVersion: 1, threadState: 'ready' };
const task = { id: 'T', version: 1, workflowRunId: 'G', workflowStatus: 'running', status: 'active', reviewMode: 'auto' };

test('task guidance distinguishes automatic review, owner review, delivery, and workflow completion', () => {
  assert.equal(taskConversationState(null, { id: 'ordinary' }).canWork, true);
  assert.equal(taskConversationState(task, chat).canWork, true);
  assert.equal(taskConversationState({ ...task, status: 'rework' }, chat).canWork, true);
  for (const status of ['submitted', 'passed', 'ready']) assert.equal(taskConversationState({ ...task, status }, chat).canWork, false);
  assert.match(taskConversationState({ ...task, status: 'submitted' }, chat).message, /AI 正在审核/);
  assert.match(taskConversationState({ ...task, status: 'submitted', reviewMode: 'assisted' }, chat).message, /老板决定/);
  assert.match(taskConversationState({ ...task, status: 'submitted', blockedReason: 'WAITING_OWNER_REVIEW' }, chat).message, /需要老板/);
  assert.match(taskConversationState({ ...task, status: 'passed', workflowStatus: 'passed' }, chat).message, /整张工作图已完成/);
});

test('old task conversations and paused or inaccessible workflows cannot accept work', () => {
  assert.equal(taskConversationState(null, chat).canWork, false);
  for (const workflowStatus of ['paused', 'cancelled', 'superseded', undefined]) {
    assert.equal(taskConversationState({ ...task, workflowStatus }, chat).canWork, false);
  }
  const current = taskConversationState({ ...task, version: 2, status: 'rework' }, chat);
  assert.equal(current.canWork, false); assert.equal(current.canOpenCurrent, true);
  assert.match(current.message, /V2.*V1/);
  assert.equal(taskConversationState({ ...task, version: 2, workflowStatus: 'paused' }, chat).canOpenCurrent, false);
});

test('polling updates a selected task and immediately hides obsolete submission actions without erasing drafts', () => {
  const { document } = parseHTML('<textarea id="prompt-input">unsent draft</textarea><button class="submit-task-button" data-task-version="1"></button>');
  const state = { selectedChat: { ...chat }, selectedTask: { ...task }, tasks: [{ ...task, status: 'submitted' }] };
  let updates = 0;
  const sync = Function('state', '$$', 'taskConversationState', 'setComposer', `${source('syncSelectedTask')}; return syncSelectedTask;`)(
    state, selector => [...document.querySelectorAll(selector)], taskConversationState, () => updates++);
  sync(); assert.equal(state.selectedTask.status, 'submitted');
  assert.equal(document.querySelector('button').hidden, true); assert.equal(document.querySelector('button').disabled, true);
  state.tasks = [{ ...task, status: 'rework', version: 2 }]; sync(); assert.equal(document.querySelector('button').hidden, true);
  assert.equal(document.querySelector('textarea').value, 'unsent draft'); assert.equal(updates, 2);
});

test('task composer disables stale work while retaining a clear route to review and the current version', () => {
  const { document } = parseHTML('<section id="task-flow-notice"></section><textarea id="prompt-input">draft</textarea><button id="send-button"></button><button id="stop-turn"></button><div id="composer-context"></div>');
  const state = { selectedChat: { ...chat }, selectedTask: { ...task, status: 'submitted' }, selectedProject: { name: 'P' }, queueSending: false };
  const $ = selector => document.querySelector(selector);
  const render = Function('state', '$', 'escapeHtml', `${source('renderTaskNotice')}; return renderTaskNotice;`)(state, $, value => value);
  const set = Function('state', '$', 'taskConversationState', 'renderTaskNotice', 'selectedChatRunning', 'renderInputQueue', 'updateModelSelect', `${source('setComposer')}; return setComposer;`)(state, $, taskConversationState, render, () => false, () => {}, () => {});
  set(true); assert.equal($('#send-button').disabled, true); assert.equal($('#prompt-input').disabled, true);
  assert.match($('#task-flow-notice').textContent, /AI 正在审核/); assert.ok($('[data-task-detail]')); assert.ok($('[data-task-board]'));
  state.selectedTask = { ...task, version: 2, status: 'rework' }; set(true); assert.ok($('[data-task-current]'));
  state.selectedChat.taskVersion = 2; set(true); assert.equal($('#send-button').disabled, false);
  assert.equal($('#prompt-input').value, 'draft');
});

test('newly shared task projects appear without switching the current editor or chat', async () => {
  const state = { tasks: [], projects: [], selectedChat: { id: 'keep' }, selectedFile: { path: 'draft.md' } };
  const calls = []; let renders = 0;
  const load = Function('state', 'api', 'syncSelectedTask', 'renderProjects', 'renderTasks', 'workGraphUI', `${source('loadTasks')}; return loadTasks;`)(
    state, async path => { calls.push(path); return path === '/api/tasks' ? { tasks: [{ projectId: 'new' }] } : { projects: [{ id: 'new' }] }; },
    () => {}, () => renders++, () => {}, { initialized: false });
  await load(); assert.deepEqual(calls, ['/api/tasks', '/api/projects']); assert.equal(renders, 1);
  assert.equal(state.projects[0].id, 'new'); assert.equal(state.selectedChat.id, 'keep'); assert.equal(state.selectedFile.path, 'draft.md');
});

test('an older task poll cannot undo a newer review transition', async () => {
  const state = { tasks: [], projects: [{ id: 'P' }] }; const pending = []; let synced = 0;
  const load = Function('state', 'api', 'syncSelectedTask', 'renderProjects', 'renderTasks', 'workGraphUI', `${source('loadTasks')}; return loadTasks;`)(
    state, () => new Promise(resolve => pending.push(resolve)), () => synced++, () => {}, () => {}, { initialized: false });
  const old = load(); const recent = load(); pending[1]({ tasks: [{ projectId: 'P', status: 'passed' }] }); await recent;
  pending[0]({ tasks: [{ projectId: 'P', status: 'submitted' }] }); await old;
  assert.equal(state.tasks[0].status, 'passed'); assert.equal(synced, 1);
});

test('an open employee review follows automatic approval without replacing delivery drafts', async () => {
  const { document } = parseHTML('<dialog></dialog>');
  const node = { key: 'T', status: 'submitted' };
  const graph = { id: 'G', owner: false, run: { status: 'running' }, nodes: [{ key: 'T', status: 'passed' }] };
  let requests = 0, shown = 0;
  const ui = new WorkGraphUI({ refreshTasks: async () => {}, api: async () => { requests++; return { graph }; } });
  ui.drawer = document.querySelector('dialog'); ui.drawer.open = true; ui.drawer.scrollTop = 45;
  ui.detail = { graph: { id: 'G', owner: false, run: { status: 'running' } }, node };
  ui.showNode = (fresh, key) => { shown++; ui.detail = { graph: fresh, node: fresh.nodes.find(n => n.key === key) }; };
  await ui.refreshEmployee(); assert.equal(ui.detail.node.status, 'passed'); assert.equal(shown, 1); assert.equal(ui.drawer.scrollTop, 45);
  await ui.refreshEmployee(); assert.equal(shown, 1, 'unchanged polls retain the existing detail DOM');
  ui.drawer.innerHTML = '<form id="graph-submit-form"><textarea>unsent delivery</textarea></form>';
  await ui.refreshEmployee(); assert.equal(requests, 2); assert.match(ui.drawer.textContent, /unsent delivery/);
});

test('late employee review refresh cannot reopen a closed or newly selected detail', async () => {
  const { document } = parseHTML('<dialog></dialog>'); let resolve; let shown = 0;
  const ui = new WorkGraphUI({ refreshTasks: async () => {}, api: () => new Promise(done => { resolve = done; }) });
  ui.drawer = document.querySelector('dialog'); ui.drawer.open = true;
  ui.detail = { graph: { id: 'G', owner: false }, node: { key: 'T', status: 'submitted' } };
  ui.showNode = () => shown++;
  const pending = ui.refreshEmployee(); await Promise.resolve();
  ui.detail = { graph: { id: 'Other' }, node: { key: 'Other' } }; ui.drawer.open = false;
  resolve({ graph: { nodes: [{ key: 'T', status: 'passed' }] } }); await pending;
  assert.equal(shown, 0); assert.equal(ui.detail.graph.id, 'Other');
});
