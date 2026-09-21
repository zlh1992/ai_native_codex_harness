import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { WorkGraphUI } from '../public/work-graph.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const graph = (id = 'A') => ({ id, projectId: id, owner: false, run: { status: 'passed' }, nodes: [{ key: id,
  taskId: id, title: id, assigneeName: 'Synthetic employee', status: 'passed', version: 1,
  task: { id, status: 'passed', acceptance: 'Synthetic task', checklist: [] }, submissions: [] }] });
function fixture(t, api) {
  const previous = globalThis.document;
  const { document } = parseHTML('<dialog id="work-graph-drawer"></dialog>');
  globalThis.document = document;
  const ui = new WorkGraphUI({ api, toast: () => {} });
  ui.drawer = document.querySelector('dialog'); ui.initialized = true;
  ui.drawer.showModal = () => { ui.drawer.open = true; };
  ui.drawer.close = () => { ui.drawer.open = false; };
  t.after(() => { ui.dispose(); globalThis.document = previous; });
  return { ui, document };
}
test('latest task inspection wins even when an older request arrives last', async t => {
  const first = deferred(); const second = deferred();
  const { ui, document } = fixture(t, url => url.includes('/A/') ? first.promise : second.promise);
  const a = ui.inspect({ id: 'A', projectId: 'A' });
  const b = ui.inspect({ id: 'B', projectId: 'B' });
  second.resolve({ graphs: [graph('B')] }); await b;
  first.resolve({ graphs: [graph('A')] }); await a;
  assert.equal(document.querySelector('h2').textContent, 'B');
});
for (const action of ['closeDetail', 'dispose']) {
  test(`${action} invalidates pending task inspections`, async t => {
    const pending = deferred(); const { ui } = fixture(t, () => pending.promise);
    const opening = ui.inspect({ id: 'A', projectId: 'A' });
    ui[action](); pending.resolve({ graphs: [graph()] }); await opening;
    assert.ok(!ui.drawer.open); assert.equal(ui.detail, null);
  });
}
test('late artifact response cannot appear in another task or a closed drawer', async t => {
  const pending = deferred(); const { ui, document } = fixture(t, () => pending.promise);
  ui.showNode(graph(), 'A');
  const button = document.createElement('button'); button.dataset.previewSubmission = 'submission'; button.dataset.path = 'a.txt';
  const opening = ui.drawerAction({ target: button });
  ui.showNode(graph('B'), 'B');
  pending.resolve({ file: { path: 'a.txt', content: 'Synthetic artifact' } });
  await opening;
  assert.equal(document.querySelector('#graph-artifact-preview'), null);
  assert.equal(document.querySelector('h2').textContent, 'B');
});
test('latest attachment preview wins within the same task', async t => {
  const a = deferred(); const b = deferred(); const { ui, document } = fixture(t, url => url.includes('a.txt') ? a.promise : b.promise);
  const proto = Object.getPrototypeOf(document.createElement('section')); const scroll = proto.scrollIntoView;
  proto.scrollIntoView = () => {}; t.after(() => { proto.scrollIntoView = scroll; });
  ui.showNode(graph(), 'A');
  const open = path => { const button = document.createElement('button'); button.dataset.previewSubmission = 'submission'; button.dataset.path = path; return ui.drawerAction({ target: button }); };
  const first = open('a.txt'); const second = open('b.txt');
  b.resolve({ file: { path: 'b.txt', content: 'Second' } }); await second;
  a.resolve({ file: { path: 'a.txt', content: 'First' } }); await first;
  assert.match(document.querySelector('#graph-artifact-preview h3').textContent, /^b.txt/);
});
test('closing and reopening a task does not accept the previous preview response', async t => {
  const pending = deferred(); const { ui, document } = fixture(t, () => pending.promise);
  ui.showNode(graph(), 'A');
  const button = document.createElement('button'); button.dataset.previewSubmission = 'submission'; button.dataset.path = 'a.txt';
  const opening = ui.drawerAction({ target: button });
  ui.closeDetail(); ui.showNode(graph(), 'A');
  pending.resolve({ file: { path: 'a.txt', content: 'Old preview' } }); await opening;
  assert.equal(document.querySelector('#graph-artifact-preview'), null);
});
test('both login forms prevent native GET credential submission before scripts initialize', () => {
  for (const page of ['index.html', 'boss-login.html']) {
    const { document } = parseHTML(fs.readFileSync(new URL(`../public/${page}`, import.meta.url), 'utf8'));
    const form = document.querySelector('#login-form');
    assert.equal(form.getAttribute('method'), 'post');
    assert.ok(form.querySelector('button[type=submit]').hasAttribute('disabled'));
  }
});

test('same-version live refresh retains an open preview and an in-flight preview request', async t => {
  const pending = deferred(); const { ui, document } = fixture(t, () => pending.promise);
  const proto = Object.getPrototypeOf(document.createElement('section')); const scroll = proto.scrollIntoView;
  proto.scrollIntoView = () => {}; t.after(() => { proto.scrollIntoView = scroll; });
  ui.showNode(graph(), 'A');
  const button = document.createElement('button'); button.dataset.previewSubmission = 'submission'; button.dataset.path = 'a.txt';
  const opening = ui.drawerAction({ target: button });
  const updated = graph(); updated.nodes[0].reviewJob = { status: 'succeeded' };
  ui.showNode(updated, 'A', null, true);
  pending.resolve({ file: { path: 'a.txt', content: 'Synthetic artifact' } }); await opening;
  const preview = document.querySelector('#graph-artifact-preview');
  assert.ok(preview);
  ui.showNode(updated, 'A', null, true);
  assert.equal(document.querySelector('#graph-artifact-preview'), preview);
  updated.nodes[0].version++;
  // Server responses are distinct objects; never mutate the currently rendered node.
  ui.detail.node = { ...ui.detail.node, version: 1 };
  ui.showNode(updated, 'A', null, true);
  assert.equal(document.querySelector('#graph-artifact-preview'), null);
});

function editable(t, api) {
  const result = fixture(t, api); const g = graph();
  g.run.status = 'running'; g.nodes[0].status = 'active';
  Object.assign(g.nodes[0].task, { status: 'active', version: 1, checklistRevision: 1 });
  result.ui.showNode(g, 'A');
  const previous = globalThis.FormData;
  globalThis.FormData = class { get(key) { return key === 'summary' ? 'Synthetic delivery' : ''; } };
  t.after(() => { globalThis.FormData = previous; });
  return result;
}
test('late delivery-file validation does not write into another task form', async t => {
  const pending = deferred(); const { ui, document } = editable(t, () => pending.promise);
  const checking = ui.checkDeliveryFiles(); ui.showNode(graph('B'), 'B');
  pending.resolve({ files: [{ path: 'a.txt', size: 1 }] }); await checking;
  assert.equal(document.querySelector('#graph-files-result'), null);
});
test('logout during submission stops the remaining writes and leaves new task controls alone', async t => {
  const pending = deferred(); const calls = [];
  const { ui, document } = editable(t, url => { calls.push(url); return pending.promise; });
  const submitting = ui.submitDetail(document.querySelector('form'));
  ui.dispose(); ui.showNode(graph('B'), 'B');
  pending.resolve({ task: { id: 'A', version: 1, status: 'active' } });
  await assert.rejects(submitting, { name: 'AbortError' });
  assert.deepEqual(calls, ['/api/tasks/A']);
  assert.equal(document.querySelector('h2').textContent, 'B');
});
test('successful submission can clear the drawer before the board refresh completes', async t => {
  const calls = [];
  const { ui, document } = editable(t, async url => {
    calls.push(url); return { task: { id: 'A', version: 1, status: 'active', checklistRevision: 2 } };
  });
  ui.refreshTasks = async () => { assert.equal(ui.detail, null); assert.equal(ui.drawer.open, false); };
  await ui.submitDetail(document.querySelector('form'));
  assert.equal(calls.at(-1), '/api/tasks/A/submissions');
  assert.equal(ui.detail, null);
});
