import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { WorkGraphUI } from '../public/work-graph.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function fixture(t, api) {
  const previous = new Map(['document', 'localStorage', 'FormData'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const { document } = parseHTML(`<section id="panel">
    <form id="graph-generate-form"><button type="submit">Generate</button></form>
    <div id="graph-candidates"></div><select id="graph-select"></select>
    <div id="graph-generation-status">Previous project completed</div>
    <div id="graph-run-bar"></div><div id="graph-board"></div><div id="graph-job-list"></div>
    </section><dialog></dialog>`);
  const saved = new Map();
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key),
  } });
  Object.defineProperty(globalThis, 'FormData', { configurable: true, value: class {
    get(key) { return ({ prompt: 'Synthetic planning request', reviewMode: 'auto', finalMode: 'same', paths: '' })[key]; }
    getAll() { return ['employee']; }
  } });
  const ui = new WorkGraphUI({ api, toast: () => {} });
  ui.panel = document.querySelector('#panel'); ui.drawer = document.querySelector('dialog');
  ui.owner = true; ui.projectId = 'A'; ui.initialized = true;
  ui.render = () => {}; ui.subscribe = () => {};
  const event = { currentTarget: document.querySelector('form'), submitter: document.querySelector('button') };
  t.after(() => {
    ui.dispose();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { ui, document, saved, event };
}

test('switching projects clears previous planning state before the next project responds', async t => {
  const pending = deferred();
  const { ui, document } = fixture(t, () => pending.promise);
  ui.generationJobId = 'old-job'; ui.generationJob = { id: 'old-job', status: 'succeeded' };
  ui.refresh = async () => {};
  const switching = ui.selectProject('B');
  assert.equal(document.querySelector('#graph-generation-status').textContent, '');
  assert.equal(ui.generationJobId, null);
  pending.resolve({ employees: [] }); await switching;
  await ui.selectProject('');
  assert.equal(document.querySelector('#graph-generation-status').textContent, '');
});

test('a late generation receipt is retained for its originating project without replacing the selected project', async t => {
  const pending = deferred();
  const { ui, saved, event } = fixture(t, () => pending.promise);
  let refreshes = 0; ui.refresh = async () => { refreshes++; };
  const generating = ui.generate(event);
  ui.projectId = 'B'; ui.selection++; ui.generationJobId = 'B-job';
  pending.resolve({ job: { id: 'A-job' } }); await generating;
  assert.equal(saved.get('work-graph-job:A'), 'A-job');
  assert.equal(saved.has('work-graph-job:B'), false);
  assert.equal(ui.generationJobId, 'B-job');
  assert.equal(refreshes, 0);
});

test('uncertain planning retries keep their own project idempotency keys', async t => {
  const calls = [];
  const { ui, event } = fixture(t, async (url, options) => {
    calls.push({ url, key: options.body.idempotencyKey }); throw new Error('Connection lost');
  });
  await assert.rejects(ui.generate(event), /Connection lost/);
  ui.projectId = 'B'; ui.selection++;
  await assert.rejects(ui.generate(event), /Connection lost/);
  ui.projectId = 'A'; ui.selection++;
  await assert.rejects(ui.generate(event), /Connection lost/);
  assert.equal(calls[0].key, calls[2].key);
  assert.notEqual(calls[0].key, calls[1].key);
});

test('planning preserves an explicitly selected final review mode', async t => {
  const calls = [];
  const { ui, event } = fixture(t, async (url, options) => {
    if (options?.body) calls.push(options.body);
    if (url.includes('/generate')) return { job: { id: 'A-job' } };
    if (url.includes('/work-graph-jobs/')) return { job: { id: 'A-job', status: 'queued' } };
    return { graphs: [] };
  });
  class SelectedFormData {
    get(key) { return ({ prompt: 'Synthetic planning request', reviewMode: 'auto', finalMode: 'manual', paths: '' })[key]; }
    getAll() { return ['employee']; }
  }
  const prior = globalThis.FormData;
  Object.defineProperty(globalThis, 'FormData', { configurable: true, value: SelectedFormData });
  try { await ui.generate(event); } finally { Object.defineProperty(globalThis, 'FormData', { configurable: true, value: prior }); }
  assert.equal(calls[0].reviewPolicy.mode, 'auto');
  assert.equal(calls[0].reviewPolicy.finalMode, 'manual');
});

test('an obsolete job poll cannot overwrite a newer planning request on the same project', async t => {
  const pending = deferred();
  const { ui, document, saved } = fixture(t, async url => url.includes('/work-graph-jobs/') ? pending.promise : { graphs: [] });
  ui.generationJobId = 'old-job'; saved.set('work-graph-job:A', 'new-job');
  const refreshing = ui.refresh(); await Promise.resolve(); await Promise.resolve();
  ui.generationJobId = 'new-job'; document.querySelector('#graph-generation-status').textContent = 'New request queued';
  pending.resolve({ job: { id: 'old-job', status: 'succeeded' } }); await refreshing;
  assert.equal(ui.generationJobId, 'new-job');
  assert.equal(saved.get('work-graph-job:A'), 'new-job');
  assert.equal(document.querySelector('#graph-generation-status').textContent, 'New request queued');
});

test('a generation receipt arriving after logout cannot recreate cleared session state', async t => {
  const pending = deferred();
  const { ui, event, saved } = fixture(t, () => pending.promise);
  ui.refresh = async () => { assert.fail('logged-out refresh'); };
  const generating = ui.generate(event); ui.dispose();
  pending.resolve({ job: { id: 'A-job' } }); await generating;
  assert.equal(saved.size, 0); assert.equal(ui.generationJobId, null);
});
