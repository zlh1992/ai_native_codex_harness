import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { pageRoute } from '../src/page-routes.mjs';
import { safeReturnTo, loginPage, readView, viewUrl, SelectionClock } from '../public/navigation.js';
import { createSessionClient } from '../public/session-ui.js';
import { KanbanBoard, taskColumn, taskColumns, orderedCards } from '../public/kanban.js';
import { WorkGraphUI } from '../public/work-graph.js';

const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = name => app.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const json = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

test('return destinations retain safe role routes and reject external or login-loop targets', () => {
  assert.equal(safeReturnTo('/boss/workbench?view=memories&project=P&chat=C&secret=drop', 'admin'), '/boss/workbench?view=memories&project=P&chat=C');
  for (const url of ['https://other.test', '//other.test', '/\\other.test', '/boss/login', '/employee', '/boss/workbench\n']) assert.equal(safeReturnTo(url, 'admin'), '/boss/workbench?view=tasks');
  assert.equal(safeReturnTo('/boss', 'user'), '/employee?view=tasks');
  assert.equal(safeReturnTo('/boss#people', 'admin'), '/boss#people');
  assert.match(loginPage('/boss/workbench', '/boss/workbench?project=P&chat=C'), /^\/boss\/login\?returnTo=/);
  assert.deepEqual(readView('?view=memories&project=P&chat=C'), { view: 'memories', project: 'P', chat: 'C' });
  assert.equal(viewUrl('/employee', { view: 'workbench', project: 'P', chat: 'C' }), '/employee?view=workbench&project=P&chat=C');
});

test('canonical routes respect boss host for query roots and normalize trailing slashes', () => {
  const config = { bossPublicOrigin: 'https://boss.test' }; const ingress = { configured: config.bossPublicOrigin };
  const route = path => pageRoute(new URL(path, 'https://boss.test'), config, ingress);
  assert.equal(route('/?project=P').redirect, '/boss/login?project=P');
  assert.equal(route('/index.html').redirect, '/boss/login');
  assert.equal(route('/?workbench=1&project=P').redirect, '/boss/workbench?workbench=1&project=P');
  assert.deepEqual(route('/boss/login/'), { redirect: '/boss/login', status: 308 });
  assert.equal(route('/boss/workbench/').redirect, '/boss/workbench');
  assert.equal(route('/nonexistent').file, null);
});

test('network failures and 503 never expire a session; 401 does, failed login does not', async () => {
  let expired = 0; let response = () => { throw new TypeError('fixture offline'); };
  const client = createSessionClient({ getCsrf: () => 'fixture', onExpired: () => expired++, fetcher: (...args) => response(...args) });
  await assert.rejects(client.request('/api/me'), /offline/); assert.equal(expired, 0);
  response = () => json(503, { error: { code: 'UNAVAILABLE' } });
  await assert.rejects(client.request('/api/me'), error => error.status === 503); assert.equal(expired, 0);
  response = () => json(401, { error: { code: 'AUTH_REQUIRED' } });
  await assert.rejects(client.request('/api/me', { sessionCheck: true }), error => error.status === 401); assert.equal(expired, 0);
  await assert.rejects(client.request('/api/employee/login'), error => error.status === 401); assert.equal(expired, 0);
  await assert.rejects(client.request('/api/projects'), error => error.status === 401); assert.equal(expired, 1);
});

test('old identity responses cannot overwrite a new session or log the new user out', async () => {
  for (const status of [200, 401]) {
    const pending = deferred(); let expired = 0;
    const client = createSessionClient({ getCsrf: () => '', onExpired: () => expired++, fetcher: () => pending.promise });
    const request = client.request('/api/projects'); client.reset();
    pending.resolve(json(status, { projects: [{ id: 'old-private-project' }] }));
    await assert.rejects(request, error => error.name === 'AbortError'); assert.equal(expired, 0);
  }
});

test('workbench bootstrap renders connection errors rather than login on transient failure', async () => {
  for (const error of [new TypeError('offline'), Object.assign(new Error('unavailable'), { status: 503 }), new DOMException('timeout', 'AbortError')]) {
    const phases = []; let logins = 0;
    const restore = Function('api', 'setAuthState', 'showLogin', 'bootstrap', 'document', `${source('restoreSession')}; return restoreSession;`)(
      async () => { throw error; }, (...args) => phases.push(args), () => logins++, () => {}, { body: { dataset: { auth: 'checking' } } });
    await restore(); assert.equal(logins, 0); assert.equal(phases.at(-1)[0], 'error');
  }
});

test('project A→B→A discards old chat and tree responses, not just unequal project IDs', async () => {
  for (const name of ['loadChats', 'loadFiles']) {
    const clock = new SelectionClock(); const requests = [];
    const state = { selectedProject: { id: 'A' }, chats: [], fileEntries: [] };
    const { document } = parseHTML('<div id="file-tree"></div>');
    const load = Function('state', 'projectClock', 'api', 'renderChats', '$', '$$', 'escapeHtml', 'formatBytes', `${source(name)}; return ${name};`)(
      state, clock, () => { const d = deferred(); requests.push(d); return d.promise; }, () => {}, selector => document.querySelector(selector), () => [], value => value, value => value);
    clock.next(); const first = load(); clock.next(); state.selectedProject = { id: 'B' }; clock.next(); state.selectedProject = { id: 'A' }; const current = load();
    requests[1].resolve({ chats: [{ id: 'new' }], entries: [{ name: 'new', path: 'new', type: 'file' }] }); await current;
    requests[0].resolve({ chats: [{ id: 'stale' }], entries: [{ name: 'stale', path: 'stale', type: 'file' }] }); await first;
    assert.equal(name === 'loadChats' ? state.chats[0].id : state.fileEntries[0].name, 'new');
  }
});

test('logout clears private state, aborts streams, resets pending forms and disposes boards', () => {
  const { document } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  let aborted = 0, disposed = 0, reset = 0;
  for (const form of document.querySelectorAll('form')) form.reset = () => reset++;
  const state = { me: { id: 'previous' }, csrf: 'fixture', drafts: new Map([['C', 'fixture-private']]), selectedProject: { id: 'P' }, memories: [{}], runningTurns: new Map([['C', { controller: { abort: () => aborted++ } }]]) };
  const initial = () => ({ me: null, csrf: '', drafts: new Map(), selectedProject: null, memories: [], runningTurns: new Map() });
  const vars = { state, initialState: initial, sessionClient: { reset: () => reset++ }, projectClock: new SelectionClock(), chatClock: new SelectionClock(), taskClock: new SelectionClock(), routeClock: new SelectionClock(), fileClock: new SelectionClock(),
    workGraphUI: { dispose: () => disposed++ }, taskBoard: undefined, $: selector => document.querySelector(selector), $$: selector => [...document.querySelectorAll(selector)], closeViewer: () => {}, setComposer: () => {} };
  Function(...Object.keys(vars), `${source('clearPrivateState')}; clearPrivateState();`)(...Object.values(vars));
  assert.equal(aborted, 1); assert.equal(disposed, 1); assert.ok(reset > 1); assert.equal(state.me, null); assert.equal(state.csrf, ''); assert.equal(state.drafts.size, 0); assert.equal(state.selectedProject, null);
});

test('Trello-style board escapes titles, uses isolated ordering, and never moves across state columns', async () => {
  const previous = globalThis.document;
  const { document, Event } = parseHTML('<div id="board"></div>'); globalThis.document = document;
  const calls = []; const opened = []; const saved = new Map();
  const storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  class Sortable { constructor(list, options) { calls.push(options); } destroy() {} }
  const board = new KanbanBoard(document.querySelector('#board'), { key: 'user-A:tasks', storage, loadSortable: async () => ({ default: Sortable }), onOpen: id => opened.push(id) });
  const cards = [{ id: 'A', column: 'active', title: '<img src=x onerror=alert(1)>', person: '员工一', search: 'first', tag: '项目', description: '完整标题与内容' }, { id: 'B', column: 'active', title: 'Second', person: '员工二', search: 'second' }];
  try {
    board.render(taskColumns, cards); await Promise.resolve();
    assert.equal(document.querySelectorAll('.kanban-column').length, 5);
    assert.equal(document.querySelectorAll('img').length, 0);
    assert.ok(calls.every(call => call.group.put === false && call.group.pull === false));
    const first = document.querySelector('[data-card="A"]');
    board.render(taskColumns, cards); assert.equal(document.querySelector('[data-card="A"]'), first, 'unchanged polls preserve DOM');
    first.querySelector('[data-open-card]').dispatchEvent(new Event('click', { bubbles: true })); assert.deepEqual(opened, ['A']);
    first.querySelector('[data-move="down"]').dispatchEvent(new Event('click', { bubbles: true }));
    assert.deepEqual(JSON.parse(saved.get('portal-board:user-A:tasks')).active, ['B', 'A']);
    assert.equal(saved.has('portal-board:user-B:tasks'), false);
    board.render(taskColumns, cards, 'second'); assert.equal(document.querySelectorAll('[data-card]').length, 1);
    assert.deepEqual(cards.map(card => card.column), ['active', 'active']);
  } finally { board.destroy(); globalThis.document = previous; }
});

test('task columns preserve real workflow semantics and retain stable default order', () => {
  assert.equal(taskColumn({ status: 'draft' }), 'waiting'); assert.equal(taskColumn({ status: 'ready' }), 'waiting');
  assert.equal(taskColumn({ status: 'active' }), 'active'); assert.equal(taskColumn({ status: 'submitted' }), 'review');
  assert.equal(taskColumn({ status: 'rework' }), 'blocked'); assert.equal(taskColumn({ status: 'passed' }), 'done');
  assert.equal(taskColumn({ status: 'active', blockedReason: 'DELIVERY_MERGE_CONFLICT' }), 'blocked');
  assert.deepEqual(orderedCards([{ id: 'B' }, { id: 'A' }]).map(card => card.id), ['B', 'A']);
});

test('all role pages mask login during verification and expose explicit exit vs navigation', () => {
  for (const file of ['index.html', 'boss.html', 'boss-login.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /data-auth="checking"/); assert.match(html, /id="auth-status"/); assert.match(html, /portal-ui.css/);
  }
  assert.ok(app.includes("window.addEventListener('popstate'"));
  assert.ok(app.includes('state.drafts.get(chat.id)'));
  assert.ok(app.includes('confirmLeaveEditor()'));
  assert.doesNotMatch(app, /finally\s*\{\s*showLogin\(\)/);
});

test('workbench controls wrap as whole labels and narrow screens retain an accessible file panel', () => {
  const css = fs.readFileSync(new URL('../public/portal-ui.css', import.meta.url), 'utf8');
  assert.match(css, /\.stage-header\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.turn-controls\{[^}]*flex-wrap:wrap/);
  assert.match(css, /\.turn-controls label\{[^}]*white-space:nowrap/);
  assert.match(css, /\.project-list,\.chat-list\{align-content:start\}/);
  const narrow = css.slice(css.lastIndexOf('@media(max-width:820px)'));
  assert.match(narrow, /\.files-panel\{display:grid;position:static/);
  assert.match(narrow, /\.workbench\{display:block;overflow:visible\}/);
});

test('a slow history restore cannot switch views after a newer navigation', async () => {
  const pending = deferred(); const routeClock = new SelectionClock(); const views = [];
  const state = { me: { id: 'fixture' }, projects: [{ id: 'A' }, { id: 'B' }], chats: [], selectedProject: null, selectedChat: null };
  const location = { search: '?view=workbench&project=A' };
  const vars = { state, routeClock, location, readView, selectProject: async project => { state.selectedProject = project; if (project.id === 'A') await pending.promise; return true; },
    switchView: view => views.push(view), saveLocation: () => {}, loadChats: async () => {}, selectChat: async () => {} };
  const restore = Function(...Object.keys(vars), `${source('restoreLocation')}; return restoreLocation;`)(...Object.values(vars));
  const old = restore(); location.search = '?view=memories&project=B'; await restore();
  pending.resolve(); await old;
  assert.deepEqual(views, ['memories']); assert.equal(state.selectedProject.id, 'B'); assert.equal(state.navigating, false);
});

test('late project loading never erases a newly selected chat; drafts are keyed per chat', async () => {
  const pending = deferred(); const projectClock = new SelectionClock(); const chatClock = new SelectionClock();
  const state = { selectedProject: { id: 'A' }, selectedChat: { id: 'C', projectId: 'A' }, drafts: new Map(), pendingInputs: new Map(), pendingInput: { id: 'retry-C' } };
  const { document } = parseHTML('<textarea id="prompt-input">Draft C</textarea><div id="project-kicker"></div><div id="chat-title"></div>');
  const $ = selector => document.querySelector(selector); let erased = 0;
  const saveDraft = Function('state', '$', `${source('saveDraft')}; return saveDraft;`)(state, $);
  const vars = { state, $, projectClock, chatClock, taskClock: new SelectionClock(), saveDraft, confirmLeaveEditor: async () => true, closeViewer: () => {}, setComposer: () => {},
    renderProjects: () => {}, clearChatDisplay: () => {}, loadChats: () => pending.promise, loadFiles: async () => {}, refreshUsage: async () => {}, renderMessages: () => erased++, refreshChatMemory: async () => {}, saveLocation: () => {} };
  const select = Function(...Object.keys(vars), `${source('selectProject')}; return selectProject;`)(...Object.values(vars));
  const loading = select({ id: 'A', slug: 'a' }); await Promise.resolve();
  chatClock.next(); state.selectedChat = { id: 'D', projectId: 'A' }; $('#prompt-input').value = 'Draft D'; state.pendingInput = null; saveDraft();
  pending.resolve(); await loading;
  assert.equal(erased, 0); assert.equal(state.drafts.get('C'), 'Draft C'); assert.equal(state.drafts.get('D'), 'Draft D');
  assert.equal(state.pendingInputs.get('C').id, 'retry-C'); assert.equal(state.pendingInputs.has('D'), false);
});

test('work graph renders the default board and retains dependency, list and event projections', async () => {
  const previous = globalThis.document;
  const { document } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')); globalThis.document = document;
  const ui = new WorkGraphUI({ api: async () => ({}), toast: () => {} });
  ui.panel = document.querySelector('#work-graph-panel'); ui.drawer = document.querySelector('#work-graph-drawer'); ui.user = { id: 'fixture' };
  ui.panel.innerHTML = '<details class="graph-generate-details"></details><label id="graph-search-label"><input id="graph-search" value=""></label><p id="graph-view-help"></p><div id="graph-run-bar"></div><div id="graph-board"></div><div id="graph-job-list"></div>' + ['kanban', 'graph', 'list', 'events'].map(mode => `<button data-view-mode="${mode}"></button>`).join('') + '<button data-zoom="1"></button>';
  ui.current = { id: 'G', nodes: [{ key: 'T', title: '完整的长任务标题', assigneeName: '测试员工', status: 'active', dependsOn: [], version: 1 }] };
  try {
    ui.render(); assert.equal(document.querySelectorAll('.kanban-column').length, 5); assert.equal(document.querySelector('[data-view-mode="kanban"]').getAttribute('aria-pressed'), 'true');
    await Promise.resolve();
    ui.mode = 'graph'; ui.render(); assert.ok(document.querySelector('.graph-canvas')); assert.equal(document.querySelector('[data-zoom]').disabled, false);
    ui.mode = 'list'; ui.render(); assert.ok(document.querySelector('.graph-list [data-node="T"]')); assert.equal(document.querySelector('[data-zoom]').disabled, true);
    ui.events = [{ id: 1, type: 'first', payload: {} }, { id: 2, type: 'second', payload: {} }]; ui.mode = 'events'; ui.render();
    assert.equal(document.querySelector('.graph-events b').textContent, 'second');
    ui.render(); assert.equal(document.querySelectorAll('.graph-events article').length, 2);
  } finally { ui.dispose(); globalThis.document = previous; }
});

test('employee board uses profile availability and preserves the account management action', () => {
  const previous = globalThis.document;
  const { document } = parseHTML(fs.readFileSync(new URL('../public/boss.html', import.meta.url), 'utf8')); globalThis.document = document;
  const text = fs.readFileSync(new URL('../public/boss.js', import.meta.url), 'utf8');
  const renderSource = text.match(/function renderEmployees\(\) \{[\s\S]*?\n\}/)[0]; const opened = [];
  const staff = [{ id: 'available', displayName: '甲', username: 'a', status: 'active', profile: { availability: 'available' } }, { id: 'limited', displayName: '乙', username: 'b', status: 'active', profile: { availability: 'limited' } }, { id: 'off', displayName: '丙', username: 'c', status: 'disabled', profile: { availability: 'available' } }];
  let columns, cards, onOpen;
  class Board { constructor(root, options) { onOpen = options.onOpen; } render(a, b) { columns = a; cards = b; } }
  const vars = { state: { me: { id: 'boss' } }, employeeBoard: null, KanbanBoard: Board, employees: () => staff, openUser: user => opened.push(user.id),
    $: selector => document.querySelector(selector), $$: selector => [...document.querySelectorAll(selector)], formatBytes: () => '0 B', formatDate: () => '—', escapeHtml: value => String(value ?? '') };
  try {
    Function(...Object.keys(vars), `${renderSource}; renderEmployees();`)(...Object.values(vars));
    assert.equal(columns.length, 4); assert.deepEqual(cards.map(card => card.column), ['available', 'limited', 'disabled']); onOpen('limited'); assert.deepEqual(opened, ['limited']);
    assert.equal(document.querySelectorAll('[data-edit-user]').length, 3);
  } finally { globalThis.document = previous; }
});

test('logout keeps the button across asynchronous confirmation and stays logged in if POST fails', async () => {
  const code = app.match(/\$\('#logout-button'\)\.addEventListener\('click', async \(event\) => \{[\s\S]*?\n\}\);/)[0];
  for (const status of [200, 401, 503]) {
    let handler; let logins = 0; let cleared = 0; const messages = []; const pending = deferred(); const button = { disabled: false };
    const vars = { $: () => ({ addEventListener: (_, fn) => { handler = fn; } }), confirmLeaveEditor: () => pending.promise,
      api: async () => { if (status !== 200) throw Object.assign(new Error('fixture'), { status }); }, clearEmployeeSession: () => cleared++, sessionChanges: { announce: () => {} }, showLogin: () => logins++, toast: text => messages.push(text) };
    Function(...Object.keys(vars), code)(...Object.values(vars));
    const event = { currentTarget: button }; const action = handler(event); event.currentTarget = null;
    pending.resolve(true); await action;
    assert.equal(logins, status === 503 ? 0 : 1); assert.equal(button.disabled, false); assert.equal(messages.length, status === 503 ? 1 : 0);
    assert.equal(cleared, status === 503 ? 0 : 1);
  }
});
