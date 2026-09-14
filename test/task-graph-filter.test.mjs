import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseHTML } from 'linkedom';
import { selectTaskGraph } from '../public/task-graph-filter.js';

const tasks = [
  { id: 'a', roadmapId: 'one', projectName: 'P1', roadmapTitle: '<img src=x>', status: 'active', title: 'alpha' },
  { id: 'b', roadmapId: 'one', projectName: 'P1', roadmapTitle: '<img src=x>', status: 'passed', title: 'beta' },
  { id: 'c', roadmapId: 'two', projectName: 'P2', roadmapTitle: '<img src=x>', status: 'passed', title: 'gamma' },
  { id: 'd', status: 'ready', title: 'legacy standalone' },
];
test('employee graph choices use IDs, retain completed and legacy tasks, and reset revoked selection', () => {
  assert.equal(selectTaskGraph(tasks).choices.length, 3);
  const selected = selectTaskGraph(tasks, 'graph:one');
  assert.deepEqual(selected.tasks.map(t => t.id), ['a', 'b']);
  assert.equal(selected.choices[0].count, 2);
  assert.match(selected.choices[1].label, /P2/);
  assert.equal(selectTaskGraph([...tasks], selected.id).id, selected.id);
  assert.deepEqual(selectTaskGraph(tasks, 'ungrouped').tasks.map(t => t.id), ['d']);
  assert.equal(selectTaskGraph(tasks.slice(2), selected.id).id, '');
  assert.deepEqual(selectTaskGraph([], selected.id), { id: '', choices: [], tasks: [] });
});

test('employee renderer filters board and counts, combines search, escapes labels and keeps selection on polls', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const body = app.match(/function renderTasks\(\) \{[\s\S]*?\n\}/)[0];
  const { document } = parseHTML(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  const select = document.querySelector('#task-graph-filter');
  // linkedom exposes a getter-only select.value, unlike browsers.
  Object.defineProperty(select, 'value', { value: '', writable: true });
  const state = { me: { id: 'u', role: 'user', displayName: 'U' }, tasks, projects: [{}], taskGraphId: 'graph:one' };
  const rendered = [];
  class Board { render(columns, cards, search) { rendered.push({ cards, search }); } }
  const escapeHtml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const render = Function('state', 'workGraphUI', '$', 'selectTaskGraph', 'escapeHtml', 'KanbanBoard', 'taskColumns', 'taskColumn', 'taskStatusLabel', `let taskBoard; ${body}; return renderTasks;`)(state, {}, s => document.querySelector(s), selectTaskGraph, escapeHtml, Board, [], t => t.status, s => s);
  document.querySelector('#task-search').value = 'beta';
  render(); render();
  assert.deepEqual(rendered.at(-1).cards.map(c => c.id), ['a', 'b']);
  assert.equal(rendered.at(-1).search, 'beta');
  assert.match(rendered.at(-1).cards[0].search, /<img src=x>/);
  assert.equal(select.querySelector('img'), null);
  assert.equal(select.value, 'graph:one');
  assert.equal(document.querySelector('#task-passed-count').textContent, '1');
  state.tasks = tasks.slice(2); render();
  assert.equal(select.value, '');
  assert.deepEqual(rendered.at(-1).cards.map(c => c.id), ['c', 'd']);
  assert.match(app, /task-graph-filter'\)\.addEventListener\('change'/);
  assert.match(app, /delete \$\('#task-graph-filter'\)\.dataset.options/);
});
