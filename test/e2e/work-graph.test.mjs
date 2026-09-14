import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FAKE_CODEX = path.join(ROOT, 'test/fixtures/fake-codex.mjs');
const FAKE_CODEX_FAIL_RESUME = path.join(ROOT, 'test/fixtures/fake-codex-fail-resume.mjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-work-graph-e2e-'));
let port;
let origin;
let serverProcess;
let logs = '';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port;
      server.close((error) => error ? reject(error) : resolve(value));
    });
  });
}

async function startServer({ failResume = false } = {}) {
  logs = '';
  serverProcess = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY: 'false', COOKIE_SECURE: 'false', PUBLIC_ORIGIN: '',
      PUBLIC_ORIGINS: '', BOSS_PUBLIC_ORIGIN: '', EMPLOYEE_PUBLIC_ORIGIN: '', TRUST_PROXY_PROVIDER: 'generic',
      DATA_DIR: base, DATABASE_PATH: path.join(base, 'harness.sqlite'),
      WORKSPACES_ROOT: path.join(base, 'workspaces'), TREES_ROOT: path.join(base, 'trees'),
      RUNTIME_ROOT: path.join(base, 'runtime'), TRASH_ROOT: path.join(base, 'trash'),
      ADMIN_USERNAME: 'gateboss', ADMIN_PASSWORD: 'GateBossPassword!123',
      CODEX_BIN: failResume ? FAKE_CODEX_FAIL_RESUME : FAKE_CODEX,
      CODEX_MODEL: 'gpt-5.6-sol', CODEX_MODEL_PROVIDER: 'openai_http',
      CODEX_REQUEST_TIMEOUT_MS: '30000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { logs += String(chunk); });
  serverProcess.stderr.on('data', (chunk) => { logs += String(chunk); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`Portal exited during startup:\n${logs}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      const health = await response.json();
      if (health.ok && health.codex) {
        assert.equal(health.codexState, 'ready');
        return;
      }
    } catch { /* keep waiting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portal did not become ready:\n${logs}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Portal did not stop:\n${logs}`)), 8000)),
  ]);
}

async function request(session, pathname, { method = 'GET', body, headers = {}, expect = 200 } = {}) {
  const requestHeaders = new Headers(headers);
  if (session?.cookie) requestHeaders.set('cookie', session.cookie);
  if (method !== 'GET' && session?.csrf) requestHeaders.set('x-csrf-token', session.csrf);
  let payload = body;
  if (body !== undefined && !(body instanceof ArrayBuffer) && !Buffer.isBuffer(body) && typeof body !== 'string') {
    requestHeaders.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${origin}${pathname}`, { method, headers: requestHeaders, body: payload });
  assert.equal(response.status, expect, `${method} ${pathname}: ${await response.clone().text()}`);
  return response;
}

async function login(username, password) {
  const endpoint = username === 'gateboss' ? '/api/boss/login' : '/api/employee/login';
  const response = await request(null, endpoint, { method: 'POST', body: { username, password } });
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookie, /^codex_harness_session=/);
  const session = { cookie, csrf: '' };
  const me = await (await request(session, '/api/me')).json();
  session.csrf = me.csrfToken;
  session.user = me.user;
  return session;
}

async function json(session, pathname, options) { return (await request(session, pathname, options)).json(); }
async function until(read, condition) {
  let value;
  for (let i = 0; i < 200; i++) { value = await read(); if (condition(value)) return value; await new Promise(r => setTimeout(r, 100)); }
  assert.fail(`Timed out: ${JSON.stringify(value?.nodes ? { run: value.run, nodes: value.nodes.map(n => ({ key: n.key, status: n.status, blockedReason: n.blockedReason })) } : value)}`);
}

test('human Work Graph HTTP: planner, automatic files-only sharing, review/rework, parallel join and final delivery', { timeout: 90000 }, async t => {
  port = await freePort(); origin = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await stopServer();
    const database = new DatabaseSync(path.join(base, 'harness.sqlite'), { readOnly: true });
    try {
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(database.prepare("SELECT COUNT(*) AS n FROM workflow_jobs WHERE status='leased'").get().n, 0);
    } finally { database.close(); fs.rmSync(base, { recursive: true, force: true }); }
  });
  await startServer();
  const boss = await login('gateboss', 'GateBossPassword!123');
  const staff = [];
  for (let i = 0; i < 3; i++) {
    const password = 'TeamMemberPassword!123';
    const { user } = await json(boss, '/api/admin/users', { method: 'POST', expect: 201,
      body: { username: `graphstaff${i}`, displayName: `Member ${i}`, password } });
    await json(boss, `/api/admin/users/${user.id}/profile`, { method: 'PATCH', body: { revision: 0, jobTitle: 'Researcher', skills: ['writing'] } });
    staff.push(await login(user.username, password));
  }
  const { project } = await json(boss, '/api/projects', { method: 'POST', expect: 201, body: { name: 'Team Graph' } });
  const { job } = await json(boss, `/api/projects/${project.id}/work-graphs/generate`, { method: 'POST', expect: 202,
    body: { prompt: 'Make a team delivery plan', candidateIds: staff.map(s => s.user.id), autoStart: true,
      reviewPolicy: { mode: 'auto', finalMode: 'auto' }, idempotencyKey: randomUUID() } });
  const planned = await until(() => json(boss, `/api/work-graph-jobs/${job.id}`), x => ['succeeded', 'needs_attention'].includes(x.job.status));
  assert.equal(planned.job.status, 'succeeded', JSON.stringify(planned));
  const graphId = planned.job.result.roadmapId;
  const read = async () => (await json(boss, `/api/work-graphs/${graphId}`)).graph;
  let graph = await until(read, g => g.nodes[0].status === 'active');
  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.nodes[0].task.reviewMode, 'auto');
  const { chat: firstTaskChat } = await json(staff[0], `/api/tasks/${graph.nodes[0].taskId}/chat`, { method: 'POST', body: {} });
  const firstTaskContext = await json(staff[0], `/api/chats/${firstTaskChat.id}`);
  assert.equal(firstTaskContext.task.reviewMode, 'auto');
  assert.equal(firstTaskContext.task.workflowStatus, 'running');
  assert.equal(firstTaskContext.task.assignedAccessId, undefined);
  for (const employee of staff) {
    const visible = await json(employee, `/api/work-graphs/${graphId}`);
    assert.equal(visible.graph.plan, null);
    assert.ok(visible.graph.nodes.filter(n => n.assigneeUserId !== employee.user.id).every(n => !n.task && !n.submissions));
  }
  await request(boss, `/api/projects/${project.id}/file?path=forbidden-workflow-write.txt`, { expect: 404 });
  async function submit(key, resultSummary) {
    const current = await read(); const node = current.nodes.find(n => n.key === key);
    const employee = staff.find(s => s.user.id === node.assigneeUserId);
    const { task } = await json(employee, `/api/tasks/${node.taskId}/checklist`, { method: 'PATCH', body: {
      taskVersion: node.task.version, revision: node.task.checklistRevision, items: node.task.checklist.map(i => ({ id: i.id, done: true })) } });
    const body = { taskVersion: task.version, checklistRevision: task.checklistRevision, kind: 'manual', resultSummary, idempotencyKey: randomUUID() };
    const result = await json(employee, `/api/tasks/${task.id}/submissions`, { method: 'POST', expect: 201, body });
    const again = await json(employee, `/api/tasks/${task.id}/submissions`, { method: 'POST', expect: 201, body });
    assert.equal(again.submission.id, result.submission.id);
    assert.equal(result.submission.kind, 'manual');
    return result;
  }
  await submit('requirements', 'needs-rework');
  graph = await until(read, g => g.nodes[0].status === 'rework');
  assert.equal(graph.nodes[0].task.version, 2);
  assert.ok(graph.nodes[0].task.checklist.every(i => !i.done));
  await submit('requirements', 'Completed with supporting evidence');
  graph = await until(read, g => g.nodes.filter(n => n.status === 'active').length === 2);
  assert.deepEqual(graph.nodes.filter(n => n.status === 'active').map(n => n.key), ['design', 'implementation']);
  await stopServer(); await startServer();
  graph = await read();
  assert.equal(graph.run.status, 'running');
  assert.equal(graph.nodes.filter(n => n.status === 'active').length, 2);
  await submit('design', 'Design complete');
  await until(read, g => g.nodes.find(n => n.key === 'design').status === 'passed');
  assert.equal((await read()).nodes.find(n => n.key === 'delivery').status, 'ready');
  await submit('implementation', 'Implementation complete');
  await until(read, g => g.nodes.find(n => n.key === 'delivery').status === 'active');
  await submit('delivery', 'Final delivery complete');
  graph = await until(read, g => g.run.status === 'passed');
  assert.ok(graph.nodes.every(n => n.status === 'passed'));
  const { events } = await json(staff[1], `/api/projects/${project.id}/events?format=json`);
  assert.ok(events.length > 0);
  assert.ok(events.every(e => !JSON.stringify(e).includes('needs-rework')));

  // A second isolated graph exercises real uploads + absolute paths and per-node review policy.
  const { project: deliveryProject } = await json(boss, '/api/projects', { method: 'POST', expect: 201, body: { name: 'Attachment Delivery' } });
  const makeNode = (key, assignee, dependsOn, completionGate, reviewMode) => ({ key, title: key,
    assigneeUserId: assignee.user.id, acceptance: 'Read the submitted evidence', checklist: ['Evidence is complete'],
    outputs: [], dependsOn, completionGate, reviewMode });
  const { graph: draft } = await json(boss, `/api/projects/${deliveryProject.id}/work-graphs`, { method: 'POST', expect: 201,
    body: { graph: { schemaVersion: 1, title: 'Attachments and review modes', nodes: [
      makeNode('human', staff[0], [], false, 'assisted'), makeNode('automatic', staff[1], ['human'], true, 'auto'),
    ] } } });
  await json(boss, `/api/work-graphs/${draft.id}/start`, { method: 'POST', expect: 202,
    body: { expectedVersion: draft.version, idempotencyKey: randomUUID(), reviewPolicy: { mode: 'assisted' } } });
  const readDelivery = async () => (await json(boss, `/api/work-graphs/${draft.id}`)).graph;
  let delivery = await until(readDelivery, g => g.nodes[0].status === 'active');
  const first = delivery.nodes[0];
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTcQAAAAASUVORK5CYII=', 'base64');
  const uploadPath = `deliveries/${first.taskId}/v1/proof.png`;
  for (const [filename, bytes] of [['report.md', Buffer.from('fixed delivery evidence')], [uploadPath, image]]) {
    await json(staff[0], `/api/projects/${deliveryProject.id}/file?path=${encodeURIComponent(filename)}`, { method: 'PUT', body: bytes });
  }
  const database = new DatabaseSync(path.join(base, 'harness.sqlite'), { readOnly: true });
  const treePath = database.prepare('SELECT tree_path FROM project_access WHERE project_id=? AND user_id=? AND status=\'active\'').get(deliveryProject.id, staff[0].user.id).tree_path;
  database.close();
  const absolute = path.join(treePath, 'report.md');
  const checked = await json(staff[0], `/api/tasks/${first.taskId}/delivery-files`, { method: 'POST', body: { taskVersion: 1, outputs: [absolute, 'report.md', uploadPath] } });
  assert.equal(checked.files.length, 2);
  assert.equal(checked.files[0].path, 'report.md');
  for (const unsafe of ['/etc/passwd', path.join(treePath, '.git'), `${treePath}-other/report.md`]) {
    await request(staff[0], `/api/tasks/${first.taskId}/delivery-files`, { method: 'POST', expect: 400, body: { taskVersion: 1, outputs: [unsafe] } });
  }
  await request(staff[1], `/api/tasks/${first.taskId}/delivery-files`, { method: 'POST', expect: 403, body: { taskVersion: 1, outputs: [absolute] } });
  const submitDelivery = async (index, session, outputs, resultSummary = 'Evidence ready') => {
    const node = (await readDelivery()).nodes[index];
    const { task } = await json(session, `/api/tasks/${node.taskId}/checklist`, { method: 'PATCH', body: {
      taskVersion: node.version, revision: node.task.checklistRevision, items: node.task.checklist.map(i => ({ id: i.id, done: true })) } });
    const body = { kind: 'manual', taskVersion: task.version, checklistRevision: task.checklistRevision,
      resultSummary, note: 'Attachment delivery note', outputs, idempotencyKey: randomUUID() };
    const result = await json(session, `/api/tasks/${task.id}/submissions`, { method: 'POST', expect: 201, body });
    const duplicate = await json(session, `/api/tasks/${task.id}/submissions`, { method: 'POST', expect: 201, body });
    assert.equal(result.submission.id, duplicate.submission.id);
    return result.submission;
  };
  const submitted = await submitDelivery(0, staff[0], [absolute, uploadPath]);
  assert.equal(submitted.outputsManifest.length, 2);
  const endpoint = `/api/task-submissions/${submitted.id}/artifact?path=`;
  await json(staff[0], `/api/projects/${deliveryProject.id}/file?path=report.md&overwrite=1`, { method: 'PUT', body: 'later edit' });
  assert.equal((await json(boss, `${endpoint}report.md`)).file.content, 'fixed delivery evidence');
  await request(boss, `/api/projects/${deliveryProject.id}/file?path=report.md`, { expect: 404 });
  const preview = await request(boss, `${endpoint}${encodeURIComponent(uploadPath)}&preview=1`);
  assert.equal(preview.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await preview.arrayBuffer()), image);
  await request(staff[1], `${endpoint}${encodeURIComponent(uploadPath)}&preview=1`, { expect: 403 });
  await request(boss, `${endpoint}report.md&preview=1`, { expect: 415 });
  delivery = await until(readDelivery, g => g.nodes[0].reviewJob?.status === 'succeeded');
  assert.equal(delivery.nodes[0].status, 'submitted');
  assert.equal(delivery.nodes[1].status, 'ready');
  assert.ok(delivery.nodes[0].reviews[0].detail.coverage.some(f => !f.complete));
  await json(boss, `/api/admin/task-submissions/${submitted.id}/review`, { method: 'POST', body: { expectedVersion: 1, verdict: 'passed', feedback: 'Reviewed attachments manually' } });
  delivery = await until(readDelivery, g => g.nodes[1].status === 'active');
  assert.equal(delivery.nodes[1].reviewMode, 'auto');
  assert.equal((await json(boss, `/api/projects/${deliveryProject.id}/file?path=report.md`)).content, 'fixed delivery evidence');
  // An unreadable image prevents even an otherwise-passed automatic proposal from applying.
  const partial = await submitDelivery(1, staff[1], [uploadPath]);
  delivery = await until(readDelivery, g => g.nodes[1].reviewJob?.status === 'succeeded');
  assert.equal(delivery.nodes[1].status, 'submitted');
  await json(boss, `/api/admin/task-submissions/${partial.id}/review`, { method: 'POST', body: { expectedVersion: 1, verdict: 'rework', feedback: 'Provide readable evidence' } });
  await json(staff[1], `/api/projects/${deliveryProject.id}/file?path=final.md`, { method: 'PUT', body: 'final proof' });
  await submitDelivery(1, staff[1], ['final.md'], 'needs-rework');
  delivery = await until(readDelivery, g => g.nodes[1].version === 3 && g.nodes[1].status === 'rework');
  await submitDelivery(1, staff[1], ['final.md']);
  delivery = await until(readDelivery, g => g.run.status === 'passed');
  assert.equal(delivery.nodes[1].submissions.filter(s => s.taskVersion === 3).length, 1);
  assert.equal((await json(boss, `/api/projects/${deliveryProject.id}/file?path=final.md`)).content, 'final proof');
});
