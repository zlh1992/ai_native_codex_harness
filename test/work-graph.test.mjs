import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessDatabase } from '../src/db.mjs';
import { WorkGraphStore } from '../src/work-graph-store.mjs';
import { validateGraph, graphRelativePath, deliveryRelativePath, nodeReviewMode } from '../src/work-graph-contract.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { WorktreeService } from '../src/worktree-service.mjs';
import { ProjectShareService } from '../src/project-share-service.mjs';
import { WorkGraphService } from '../src/work-graph-service.mjs';
import { ensureSubmissionSchema } from '../src/work-graph-schema.mjs';
import { WorkflowScheduler } from '../src/workflow-scheduler.mjs';
import { TaskReviewService } from '../src/task-review-service.mjs';
import { ProjectContextService } from '../src/project-context-service.mjs';
import { WorkGraphRuntime } from '../src/work-graph-runtime.mjs';
import { createWorkGraphRoutes, workflowJobView } from '../src/work-graph-routes.mjs';
import { Readable } from 'node:stream';

test('planner network retries drain, preserve history, respect attempt budget and reuse saved receipts', async t => {
  const f = fixture(t); let calls = 0;
  const queued = f.store.enqueue({ projectId: f.project.id, ownerId: f.boss.id, type: 'plan.generate', dedupeKey: 'network-test',
    maxAttempts: 2, payload: { ownerEpoch: f.store.policyEpoch(f.boss.id) } });
  const codex = { status: () => ({ ready: true }), runTurn: async ({ chat, project, user }) => {
    calls++;
    const run = f.db.createTurnRun({ chat, project, userId: user.id, mode: 'edit' });
    f.store.sql.prepare('UPDATE workflow_jobs SET turn_run_id=? WHERE id=?').run(run.id, queued.id);
    f.db.updateTurnRun(run.id, { status: 'failed', codexTurnId: `native-${calls}`,
      errorMessage: 'stream disconnected before completion: Transport error: network error: error decoding response body' });
    throw new Error('synthetic upstream failure');
  } };
  const runtime = new WorkGraphRuntime({ ...f, codex });
  const scheduler = new WorkflowScheduler({ store: f.store, handlers: { 'plan.generate': j => runtime.runModel(j, 'planner', 'synthetic') } });
  for (let attempt = 0; attempt < 2; attempt++) {
    f.store.sql.prepare('UPDATE workflow_jobs SET due_at=0 WHERE id=?').run(queued.id);
    await scheduler.execute(f.store.claimJob());
  }
  assert.equal(calls, 2);
  assert.equal(f.store.job(queued.id).status, 'needs_attention');
  assert.equal(f.store.job(queued.id).errorCode, 'PLANNER_TRANSIENT_NETWORK');
  const view = workflowJobView(f.store.job(queued.id), f.db, { codexModel: 'gpt-5.6-sol', codexReasoningEffort: 'high' });
  assert.equal(view.progress.modelCalls, 2); assert.equal(view.recovery, 'retry');
  assert.equal(JSON.stringify(view).includes('response body'), false);
  const saved = f.plan();
  f.store.sql.prepare("UPDATE workflow_jobs SET status='queued',due_at=0,result_json=? WHERE id=?")
    .run(JSON.stringify({ planId: saved.id }), queued.id);
  const leased = f.store.claimJob();
  assert.deepEqual(await runtime.runModel(leased, 'planner', 'synthetic'), { planId: saved.id });
  assert.equal(calls, 2);
  f.store.sql.prepare('UPDATE workflow_jobs SET lease_until=0 WHERE id=?').run(queued.id);
  await assert.rejects(runtime.runModel(leased, 'planner', 'synthetic'));
});

test('job retry route preserves receipts, refuses active/unknown results and enforces owner access', async t => {
  const f = fixture(t);
  const job = f.store.enqueue({ projectId: f.project.id, ownerId: f.boss.id, type: 'plan.generate', dedupeKey: 'route-test' });
  const project = f.store.owner(f.project.id, f.boss.id);
  const chat = f.db.createChat({ projectId: project.id, userId: f.boss.id, projectAccessId: project.accessId, treePath: project.treePath, title: 'Synthetic planner' });
  f.store.sql.prepare("UPDATE chats SET purpose='planner',workflow_job_id=? WHERE id=?").run(job.id, chat.id);
  const run = f.db.createTurnRun({ chat, project: f.project, userId: f.boss.id, mode: 'edit' });
  const route = createWorkGraphRoutes({ ...f, config: { codexModel: 'gpt-5.6-sol' }, scheduler: { wake() {} },
    requireMutation() {}, refreshSession: session => session });
  const invoke = async (body = {}, user = f.boss) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.headers = {};
    let result;
    await route(req, { writeHead() {}, end: b => { result = JSON.parse(b); } }, new URL(`http://localhost/api/work-graph-jobs/${job.id}/retry`), { user });
    return result;
  };
  const set = (status, result = null) => {
    f.db.updateTurnRun(run.id, { status });
    f.store.sql.prepare("UPDATE workflow_jobs SET status='needs_attention',turn_run_id=?,result_json=? WHERE id=?")
      .run(run.id, result ? JSON.stringify(result) : null, job.id);
  };
  set('running'); await assert.rejects(invoke({ acknowledgeUncertain: true }), { code: 'WORKFLOW_RECOVERY_BLOCKED' });
  set('failed'); await assert.rejects(invoke(), { code: 'MODEL_DELIVERY_UNCERTAIN' });
  await assert.rejects(invoke({ acknowledgeUncertain: true }, f.a));
  set('failed', { planId: 'receipt' });
  const resumed = await invoke();
  assert.equal(resumed.job.status, 'queued');
  assert.deepEqual(f.store.job(job.id).result, { planId: 'receipt' });
  assert.equal(f.store.job(job.id).turnRunId, run.id);
  set('failed');
  f.db.updateTurnRun(run.id, { codexTurnId: 'native', errorMessage: 'stream disconnected before completion: Transport error: network error: synthetic' });
  await invoke();
  assert.equal(f.store.job(job.id).turnRunId, null);
});

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-work-graph-'));
  const config = { dataDir: base, databasePath: path.join(base, 'db.sqlite'), workspacesRoot: path.join(base, 'workspaces'),
    fileMaxBytes: 1024 * 1024, uploadMaxBytes: 1024 * 1024 };
  const db = new HarnessDatabase(config);
  t.after(() => { db.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const add = (name, role = 'user') => db.createUser({ username: name, displayName: name, passwordHash: 'test',
    role, maxProjects: 100, maxStorageBytes: 1024 ** 3, maxConcurrentTurns: 2, networkAccess: false });
  const boss = add('boss', 'admin');
  const a = add('alice'); const b = add('bob'); const c = add('charlie');
  const project = db.createProject({ userId: boss.id, slug: 'graph', name: 'Graph' });
  const store = new WorkGraphStore(db);
  const node = (key, user, dependsOn = [], completionGate = false) => ({ key, assigneeUserId: user.id,
    title: key, acceptance: 'The result meets the specified requirements.', dependsOn, checklist: ['Produce the result'], outputs: [], completionGate });
  const graph = { schemaVersion: 1, title: 'Team delivery', nodes: [node('requirements', a),
    node('design', b, ['requirements']), node('implementation', c, ['requirements']), node('delivery', a, ['design', 'implementation'], true)] };
  const plan = () => store.savePlan({ projectId: project.id, ownerId: boss.id, graph });
  const start = (saved = plan()) => store.start({ roadmapId: saved.roadmapId, ownerId: boss.id,
    expectedVersion: saved.version, idempotencyKey: randomUUID() });
  return { db, store, boss, a, b, c, project, graph, plan, start, config };
}

test('graph validates a human fan-out/join and rejects cycles, missing employees and bypassed completion gates', (t) => {
  const f = fixture(t);
  assert.deepEqual(validateGraph(f.graph).nodes.map((n) => n.key), ['requirements', 'design', 'implementation', 'delivery']);
  const invalid = structuredClone(f.graph);
  invalid.nodes[0].dependsOn = ['delivery'];
  assert.throws(() => validateGraph(invalid), { code: 'GRAPH_CYCLE' });
  invalid.nodes[0].dependsOn = ['missing'];
  assert.throws(() => validateGraph(invalid), { code: 'INVALID_DEPENDENCIES' });
  invalid.nodes[0].dependsOn = [];
  invalid.nodes[3].dependsOn = ['design'];
  assert.throws(() => validateGraph(invalid), { code: 'COMPLETION_GATE_REQUIRED' });
  assert.throws(() => validateGraph(f.graph, { candidateIds: [f.a.id] }), { code: 'INVALID_ASSIGNEE' });
  f.db.updateUser(f.b.id, { status: 'disabled' });
  assert.throws(() => f.plan(), { code: 'INVALID_ASSIGNEE' });
  for (const file of ['../secret', '/etc/passwd', '.GiT/config', 'safe/../other', 'C:\\secret']) {
    assert.throws(() => graphRelativePath(file), { code: 'INVALID_GRAPH_PATH' });
  }
});

test('absolute delivery input is confined to this workspace; node overrides are explicit and validated', (t) => {
  const f = fixture(t);
  assert.equal(deliveryRelativePath('/workspace/member/report.pdf', '/workspace/member'), 'report.pdf');
  assert.equal(deliveryRelativePath('report.pdf', '/workspace/member'), 'report.pdf');
  assert.equal(deliveryRelativePath('/private/var/work/report.pdf', '/var/work', '/private/var/work'), 'report.pdf');
  for (const value of ['/workspace/member-other/report.pdf', '/etc/passwd', '/workspace/member/../secret', '/workspace/member/.GiT/config']) {
    assert.throws(() => deliveryRelativePath(value, '/workspace/member'), { code: 'INVALID_GRAPH_PATH' });
  }
  f.graph.nodes[0].reviewMode = 'assisted';
  const graph = validateGraph(f.graph);
  assert.equal(nodeReviewMode(graph.nodes[0], { mode: 'auto' }), 'assisted');
  assert.equal(nodeReviewMode(graph.nodes[1], { mode: 'auto' }), 'auto');
  f.graph.nodes[0].reviewMode = 'manual';
  assert.equal(nodeReviewMode(validateGraph(f.graph).nodes[0], { mode: 'auto' }), 'manual');
  f.graph.nodes[0].reviewMode = 'unknown';
  assert.throws(() => validateGraph(f.graph), { code: 'INVALID_REVIEW_POLICY' });
});

test('manual review policy waits for the owner without scheduling an AI review', (t) => {
  const f = fixture(t); const s = services(f);
  const run = f.store.start({ roadmapId: f.plan().roadmapId, ownerId: f.boss.id, expectedVersion: 1,
    idempotencyKey: randomUUID(), policy: { mode: 'manual', finalMode: 'manual' } });
  const preparation = f.store.claimJob(); s.shares.prepareWorkflow(preparation); f.store.finishJob(preparation.id, preparation.leaseToken);
  s.graphs.reconcile(run.id);
  let task = f.store.tasks(run.id)[0];
  task = s.graphs.updateChecklist(task.id, task.assigneeUserId, { taskVersion: 1, revision: task.checklistRevision,
    items: task.checklist.map(item => ({ id: item.id, done: true })) });
  const submission = s.graphs.submit(task.id, task.assigneeUserId, { kind: 'manual', taskVersion: 1,
    checklistRevision: task.checklistRevision, resultSummary: 'owner review', idempotencyKey: randomUUID() });
  assert.equal(f.store.sql.prepare("SELECT COUNT(*) AS n FROM workflow_jobs WHERE type='submission.review' AND submission_id=?").get(submission.id).n, 0);
  const review = s.reviews.proposal({ submissionId: submission.id, ownerId: f.boss.id, verdict: 'passed' });
  assert.equal(s.reviews.apply(review.id, { ownerId: f.boss.id }).verdict, 'passed');
});

function services(f) {
  const workspace = new WorkspaceService(f.config);
  const worktrees = new WorktreeService(f.config);
  const busy = new Set();
  const codex = { sharingAccesses: new Set(), workspaceBusy: (id) => busy.has(id),
    prepareSharedChats: () => { throw new Error('A workflow must not fork private history'); } };
  workspace.createProject(f.project);
  const graphs = new WorkGraphService({ ...f, workspace, worktrees, codex });
  const shares = new ProjectShareService({ ...f, workspace, worktrees, codex });
  const reviews = new TaskReviewService({ ...f, workspace, worktrees, codex, graphs });
  return { workspace, worktrees, codex, busy, graphs, shares, reviews };
}

test('delivery validates ordinary files and extraction rechecks authorization after await', async (t) => {
  const f = fixture(t); const s = services(f); const run = f.start();
  const preparation = f.store.claimJob(); s.shares.prepareWorkflow(preparation); f.store.finishJob(preparation.id, preparation.leaseToken);
  s.graphs.reconcile(run.id);
  let task = f.store.tasks(run.id)[0];
  const project = f.db.getProjectForUser(f.project.id, task.assigneeUserId);
  s.workspace.writeFile(project, 'evidence.md', 'fixed text');
  const absolute = path.join(s.workspace.projectRoot(project), 'evidence.md');
  assert.equal(s.graphs.deliveryFiles(task.id, task.assigneeUserId, { taskVersion: 1, outputs: [absolute] })[0].path, 'evidence.md');
  fs.symlinkSync('/etc/passwd', path.join(s.workspace.projectRoot(project), 'outside'));
  assert.throws(() => s.graphs.deliveryFiles(task.id, task.assigneeUserId, { taskVersion: 1, outputs: ['outside'] }), { code: 'SYMLINK_NOT_ALLOWED' });
  fs.unlinkSync(path.join(s.workspace.projectRoot(project), 'outside'));
  task = s.graphs.updateChecklist(task.id, task.assigneeUserId, { taskVersion: 1, revision: task.checklistRevision, items: task.checklist.map(i => ({ id: i.id, done: true })) });
  s.busy.add(project.accessId);
  assert.throws(() => s.graphs.submit(task.id, task.assigneeUserId, { taskVersion: 1, checklistRevision: task.checklistRevision, idempotencyKey: randomUUID(), kind: 'manual', resultSummary: 'done' }), { code: 'WORKSPACE_BUSY' });
  s.busy.clear();
  const submission = s.graphs.submit(task.id, task.assigneeUserId, { taskVersion: 1, checklistRevision: task.checklistRevision,
    idempotencyKey: randomUUID(), kind: 'manual', resultSummary: 'done', outputs: [absolute] });
  const context = new ProjectContextService({ ...f, ...s, extractText: async () => {
    await Promise.resolve(); f.db.updateUser(f.a.id, { status: 'disabled' });
    return { content: 'must not escape', complete: true, reason: null };
  } });
  await assert.rejects(() => context.review(submission.id, f.boss.id), { code: 'MEMBER_POLICY_CHANGED' });
});

test('review includes frozen upstream bytes, qualified citations and complete auto-apply coverage', async (t) => {
  const f = fixture(t); const s = services(f);
  f.graph.nodes = [f.graph.nodes[0], { ...f.graph.nodes[1], completionGate: true }];
  for (const node of f.graph.nodes) node.outputs = ['report.md'];
  const plan = f.plan();
  const run = f.store.start({ roadmapId: plan.roadmapId, ownerId: f.boss.id, expectedVersion: 1,
    idempotencyKey: randomUUID(), policy: { mode: 'auto', finalMode: 'auto' } });
  const prepare = f.store.claimJob(); s.shares.prepareWorkflow(prepare); f.store.finishJob(prepare.id, prepare.leaseToken);
  s.graphs.reconcile(run.id);
  const submit = (index, content) => {
    let task = f.store.tasks(run.id)[index];
    s.workspace.writeFile(f.db.getProjectForUser(f.project.id, task.assigneeUserId), 'report.md', content);
    task = s.graphs.updateChecklist(task.id, task.assigneeUserId, { taskVersion: 1, revision: task.checklistRevision,
      items: task.checklist.map(item => ({ id: item.id, done: true })) });
    return s.graphs.submit(task.id, task.assigneeUserId, { kind: 'manual', taskVersion: 1,
      checklistRevision: task.checklistRevision, resultSummary: 'delivery', idempotencyKey: randomUUID() });
  };
  const source = submit(0, 'approved source');
  const first = s.reviews.proposal({ submissionId: source.id, ownerId: f.boss.id, verdict: 'passed' });
  s.reviews.apply(first.id, { ownerId: f.boss.id }); s.graphs.reconcile(run.id);
  const final = submit(1, 'integrated result');
  const task = f.db.getTask(final.taskId);
  // Neither a later owner edit nor either employee working copy is review evidence.
  s.workspace.writeFile(f.db.getProjectForUser(f.project.id, f.boss.id), 'report.md', 'owner changed');
  s.workspace.writeFile(f.db.getProjectForUser(f.project.id, f.a.id), 'report.md', 'source changed');
  s.workspace.writeFile(f.db.getProjectForUser(f.project.id, f.b.id), 'report.md', 'result changed');
  const context = new ProjectContextService({ ...f, ...s });
  const evidence = await context.review(final.id, f.boss.id);
  const ref = `upstream:${source.id}:report.md`;
  assert.deepEqual(evidence.files.map(file => [file.evidenceRef || file.path, file.content]),
    [['report.md', 'integrated result'], [ref, 'approved source']]);
  assert.ok(evidence.coverage.every(file => file.complete));
  const detail = { feedback: 'Compared immutable outputs', items: task.checklist.map(item => ({ id: item.id,
    status: 'passed', comment: 'Compared', evidence: ['report.md', ref] })) };
  assert.throws(() => s.reviews.proposal({ submissionId: final.id, ownerId: f.boss.id, source: 'ai', verdict: 'passed',
    detail: { ...detail, items: [{ ...detail.items[0], evidence: ['upstream:unrelated:report.md'] }] } }), { code: 'INVALID_REVIEW_EVIDENCE' });
  const review = s.reviews.proposal({ submissionId: final.id, ownerId: f.boss.id, source: 'ai', verdict: 'passed', detail });
  const job = { runId: run.id, generation: run.generation, submissionId: final.id, taskVersion: 1 };
  const assertJob = f.store.assertJob; f.store.assertJob = () => job;
  try {
    for (const coverage of [evidence.coverage.slice(0, 1), evidence.coverage.slice(1)]) {
      f.db.db.prepare('UPDATE task_reviews SET detail_json=? WHERE id=?').run(JSON.stringify({ ...detail, coverage }), review.id);
      assert.throws(() => s.reviews.apply(review.id, { ownerId: f.boss.id, job }), { code: 'REVIEW_NEEDS_OWNER' });
    }
  } finally { f.store.assertJob = assertJob; }
  assert.equal(f.db.getSubmission(final.id).verdict, 'pending');
  const bounded = new ProjectContextService({ ...f, ...s, extractText: async () => ({ content: 'x'.repeat(64 * 1024), complete: true }) });
  const limited = await bounded.review(final.id, f.boss.id);
  assert.deepEqual(limited.omitted, [ref]);
  assert.equal(limited.coverage[1].reason, 'REVIEW_BUDGET');
  assert.throws(() => s.graphs.reviewInputs({ ...task, inputManifest: [] }), { code: 'UPSTREAM_EVIDENCE_CHANGED' });
  assert.throws(() => s.graphs.reviewInputs({ ...task, projectId: 'unrelated' }), { code: 'UPSTREAM_EVIDENCE_CHANGED' });
  const raced = new ProjectContextService({ ...f, ...s, extractText: async () => {
    f.db.db.prepare("UPDATE task_submissions SET verdict='rework' WHERE id=?").run(source.id);
    return { content: 'must not escape', complete: true };
  } });
  await assert.rejects(() => raced.review(final.id, f.boss.id), { code: 'UPSTREAM_EVIDENCE_CHANGED' });
});

test('three humans deliver a fan-out/join with rework, fixed evidence, and real downstream Git inputs', (t) => {
  const f = fixture(t); const s = services(f);
  for (const node of f.graph.nodes) node.outputs = [`${node.key}.md`];
  const run = f.start();
  const preparation = f.store.claimJob();
  s.shares.prepareWorkflow(preparation);
  f.store.finishJob(preparation.id, preparation.leaseToken);
  assert.equal(f.db.listProjectAccess(f.project.id, { activeOnly: true }).length, 4);
  assert.equal(f.db.listChats({ projectId: f.project.id }).length, 0);
  s.graphs.reconcile(run.id);
  const task = (key) => f.store.tasks(run.id).find((n) => n.nodeKey === key);
  const submit = (key, content) => {
    let current = task(key);
    const employeeProject = f.db.getProjectForUser(f.project.id, current.assigneeUserId);
    s.workspace.writeFile(employeeProject, `${key}.md`, content);
    current = s.graphs.updateChecklist(current.id, current.assigneeUserId, { taskVersion: current.version,
      revision: current.checklistRevision, items: current.checklist.map((i) => ({ id: i.id, done: true })) });
    const options = { kind: 'manual', taskVersion: current.version, checklistRevision: current.checklistRevision,
      idempotencyKey: randomUUID(), resultSummary: content };
    const result = s.graphs.submit(current.id, current.assigneeUserId, options);
    assert.equal(s.graphs.submit(current.id, current.assigneeUserId, options).id, result.id);
    assert.equal(result.codexThreadId, null);
    assert.equal(result.kind, 'manual');
    assert.equal(result.outputsManifest.length, 1);
    return result;
  };
  const review = (submission, verdict = 'passed') => {
    const proposal = s.reviews.proposal({ submissionId: submission.id, ownerId: f.boss.id, verdict,
      detail: { feedback: verdict === 'rework' ? 'Add concrete evidence and address the missing case.' : '' } });
    s.reviews.apply(proposal.id, { ownerId: f.boss.id });
    s.graphs.reconcile(run.id);
    return proposal;
  };
  assert.deepEqual(f.store.tasks(run.id).map((n) => n.status), ['active', 'ready', 'ready', 'ready']);
  const requirements = submit('requirements', 'Shared input v1');
  assert.throws(() => f.db.reviewSubmission({ submissionId: requirements.id, verdict: 'passed', deliveryCommitSha: 'a'.repeat(40) }), /DAG/);
  assert.equal(s.graphs.artifact(requirements.id, f.boss.id, 'requirements.md').content, 'Shared input v1');
  assert.throws(() => s.graphs.artifact(requirements.id, f.b.id, 'requirements.md'), { code: 'ARTIFACT_FORBIDDEN' });
  review(requirements);
  assert.equal(s.graphs.artifact(requirements.id, f.b.id, 'requirements.md').content, 'Shared input v1');
  assert.deepEqual(f.store.tasks(run.id).map((n) => n.status), ['passed', 'active', 'active', 'ready']);
  for (const employee of [f.b, f.c]) {
    assert.equal(s.workspace.readFile(f.db.getProjectForUser(f.project.id, employee.id), 'requirements.md').content, 'Shared input v1');
  }
  const firstDesign = submit('design', 'Incomplete design');
  review(firstDesign, 'rework');
  assert.equal(task('design').version, 2);
  assert.equal(task('design').checklist[0].done, false);
  review(submit('implementation', 'Completed implementation'));
  assert.equal(task('delivery').status, 'ready');
  review(submit('design', 'Completed design with evidence'));
  assert.equal(f.db.getSubmission(firstDesign.id).resultSummary, 'Incomplete design');
  assert.equal(task('delivery').status, 'active');
  const finalProject = f.db.getProjectForUser(f.project.id, f.a.id);
  assert.equal(s.workspace.readFile(finalProject, 'design.md').content, 'Completed design with evidence');
  assert.equal(s.workspace.readFile(finalProject, 'implementation.md').content, 'Completed implementation');
  assert.equal(s.graphs.handoffs(task('delivery').id, f.a.id).length, 2);
  assert.throws(() => s.graphs.handoffs(task('delivery').id, f.b.id), { code: 'TASK_FORBIDDEN' });
  review(submit('delivery', 'Accepted integrated delivery'));
  assert.equal(f.store.run(run.id).status, 'passed');
  assert.equal(f.store.run(run.id).nextCheckAt, null);
  assert.equal(f.db.db.prepare('SELECT COUNT(*) AS count FROM task_handoffs').get().count, 4);
  assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(), []);
  const view = s.graphs.view(run.roadmapId, f.b.id);
  assert.equal(view.plan, null);
  assert.equal(view.nodes.find((n) => n.key === 'implementation').submissions, undefined);
  assert.doesNotMatch(JSON.stringify(view), /ownerAccessId|treePath|authorization|codexThreadId/);
});

test('batch sharing publishes no partial access on quota failure and resumes its prepared worktrees', (t) => {
  const f = fixture(t); const s = services(f); const run = f.start();
  f.db.updateUser(f.b.id, { maxStorageBytes: 1 });
  const job = f.store.claimJob();
  assert.throws(() => s.shares.prepareWorkflow(job), { code: 'STORAGE_QUOTA' });
  assert.equal(f.db.listProjectAccess(f.project.id, { activeOnly: true }).length, 1);
  const preparedId = f.store.run(run.id).authorization.members[0].prepared.id;
  f.db.updateUser(f.b.id, { maxStorageBytes: 1024 ** 3 });
  s.shares.prepareWorkflow(job);
  assert.equal(f.db.getProjectForUser(f.project.id, f.a.id).accessId, preparedId);
  assert.equal(f.db.listProjectAccess(f.project.id, { activeOnly: true }).length, 4);
});

test('dirty downstream trees remain untouched and cannot receive an actionable task', (t) => {
  const f = fixture(t); const s = services(f); const run = f.start();
  s.shares.prepareWorkflow(f.store.claimJob());
  const project = f.db.getProjectForUser(f.project.id, f.a.id);
  s.workspace.writeFile(project, 'private.md', 'unsent work');
  s.graphs.reconcile(run.id);
  const first = f.store.tasks(run.id)[0];
  assert.equal(first.status, 'ready');
  assert.equal(first.blockedReason, 'INPUT_WORKTREE_DIRTY');
  assert.equal(s.workspace.readFile(project, 'private.md').content, 'unsent work');
});

test('plan history is immutable, edits require revision, and legacy activation cannot start a DAG', (t) => {
  const f = fixture(t); const first = f.plan();
  const graph = structuredClone(f.graph); graph.title = 'Revised delivery';
  const second = f.store.savePlan({ projectId: f.project.id, ownerId: f.boss.id, graph, roadmapId: first.roadmapId, expectedVersion: 1 });
  assert.equal(f.store.plan(first.id).graph.title, 'Team delivery');
  assert.equal(second.version, 2);
  assert.throws(() => f.store.savePlan({ projectId: f.project.id, ownerId: f.boss.id, graph, roadmapId: first.roadmapId, expectedVersion: 1 }), { code: 'PLAN_CHANGED' });
  assert.throws(() => f.db.activateRoadmap(first.roadmapId), /DAG/);
  f.start(second);
  assert.throws(() => f.store.savePlan({ projectId: f.project.id, ownerId: f.boss.id, graph, roadmapId: first.roadmapId, expectedVersion: 2 }), { code: 'PLAN_FROZEN' });
});

test('start is idempotent, only one graph is active in a project, and restart retains distinct tasks', (t) => {
  const f = fixture(t); const plan = f.plan(); const key = randomUUID();
  const options = { roadmapId: plan.roadmapId, ownerId: f.boss.id, expectedVersion: 1, idempotencyKey: key };
  const run = f.store.start(options);
  assert.equal(f.store.start(options).id, run.id);
  assert.equal(f.store.tasks(run.id).length, 4);
  assert.throws(() => f.start(plan), { code: 'PROJECT_WORKFLOW_ACTIVE' });
  f.store.changeState(run.id, f.boss.id, run.revision, 'cancel');
  const next = f.start(plan);
  assert.notEqual(next.id, run.id);
  assert.equal(f.store.tasks(run.id).length, 4);
  assert.equal(f.store.tasks(next.id).length, 4);
  assert.deepEqual(f.db.db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('pause fences existing jobs; resume is explicit and does not revive stale leases', (t) => {
  const f = fixture(t); const run = f.start(); const job = f.store.claimJob();
  assert.equal(job.type, 'share.prepare');
  const paused = f.store.changeState(run.id, f.boss.id, 1, 'pause');
  assert.throws(() => f.store.assertJob(job.id, job.leaseToken), { code: 'JOB_LEASE_LOST' });
  assert.throws(() => f.store.changeState(run.id, f.boss.id, 1, 'resume'), { code: 'WORKFLOW_CHANGED' });
  const resumed = f.store.changeState(run.id, f.boss.id, paused.revision, 'resume');
  assert.equal(resumed.status, 'preparing');
  assert.equal(resumed.generation, 3);
  assert.equal(f.store.claimJob().generation, 3);
  assert.throws(() => f.store.assertRun(run.id, 1, ['preparing']), { code: 'WORKFLOW_CHANGED' });
});

test('account lifecycle epochs invalidate background authority, ordinary login does not', (t) => {
  const f = fixture(t); const run = f.start();
  f.db.markLogin(f.boss.id);
  assert.equal(f.store.assertRun(run.id, 1, ['preparing']).id, run.id);
  f.db.updateUser(f.boss.id, { passwordHash: 'changed-test-hash' });
  assert.throws(() => f.store.assertRun(run.id, 1, ['preparing']), { code: 'WORKFLOW_AUTHORIZATION_CHANGED' });
  assert.throws(() => f.store.start({ roadmapId: run.roadmapId, ownerId: f.a.id, expectedVersion: 1, idempotencyKey: randomUUID() }), { code: 'PROJECT_OWNER_REQUIRED' });
});

test('profiles are optimistic and cannot grant account privileges', (t) => {
  const f = fixture(t);
  const updated = f.store.updateProfile(f.a.id, f.boss.id, { jobTitle: 'Designer', skills: ['UI', 'UI'], role: 'admin' }, 0);
  assert.equal(updated.revision, 1);
  assert.deepEqual(updated.skills, ['UI']);
  assert.equal(f.db.getUserById(f.a.id).role, 'user');
  assert.throws(() => f.store.updateProfile(f.a.id, f.a.id, {}, 1), { code: 'ADMIN_REQUIRED' });
  assert.throws(() => f.store.updateProfile(f.a.id, f.boss.id, {}, 0), { code: 'PROFILE_CHANGED' });
});

test('project events apply recipient ACL, ordered replay and metadata-only persistence', (t) => {
  const f = fixture(t);
  const share = (user) => f.db.grantProjectAccess({ id: randomUUID(), projectId: f.project.id, userId: user.id,
    treePath: '/test/tree', branchName: 'test' });
  const aAccess = share(f.a); share(f.b);
  f.store.event({ projectId: f.project.id, type: 'task.submitted', recipientId: f.a.id,
    payload: { version: 1, prompt: 'sensitive body', reason: 'contains sensitive body' } });
  f.store.event({ projectId: f.project.id, type: 'workflow.running', payload: { status: 'running' } });
  const a = f.store.events(f.project.id, f.a.id);
  assert.equal(a.length, 2);
  assert.equal(f.store.events(f.project.id, f.b.id).length, 1);
  assert.deepEqual(f.store.events(f.project.id, f.a.id, a[0].id).map((e) => e.id), [a[1].id]);
  assert.doesNotMatch(JSON.stringify(a), /sensitive/);
  f.db.revokeProjectAccess(aAccess.id);
  assert.throws(() => f.store.events(f.project.id, f.a.id), { code: 'PROJECT_FORBIDDEN' });
});

test('maintenance opens retain live job leases; explicit startup recovery never blindly resends a native call', (t) => {
  const f = fixture(t); f.start(); const job = f.store.claimJob();
  const other = new HarnessDatabase(f.config);
  assert.equal(new WorkGraphStore(other).job(job.id).status, 'leased');
  other.close();
  f.store.recoverJobs();
  assert.equal(f.store.job(job.id).status, 'retry_wait');
  const retried = f.store.claimJob();
  assert.notEqual(retried.leaseToken, job.leaseToken);
  assert.throws(() => f.store.finishJob(job.id, job.leaseToken), { code: 'JOB_LEASE_LOST' });
  const chat = f.db.createChat({ projectId: f.project.id, userId: f.boss.id,
    projectAccessId: f.db.getProjectForUser(f.project.id, f.boss.id).accessId, treePath: '/test', title: 'Review' });
  const turn = f.db.createTurnRun({ chat, project: f.project, userId: f.boss.id, mode: 'edit' });
  f.db.db.prepare('UPDATE workflow_jobs SET turn_run_id=? WHERE id=?').run(turn.id, retried.id);
  f.store.recoverJobs();
  assert.equal(f.store.job(job.id).status, 'needs_attention');
  assert.equal(f.store.job(job.id).errorCode, 'MODEL_DELIVERY_UNCERTAIN');
});


test('scheduler serializes model jobs while allowing business progress and defers capacity without exhausting attempts', async t => {
  const f = fixture(t);
  const enqueue = type => f.store.enqueue({ projectId: f.project.id, ownerId: f.boss.id, type, dedupeKey: randomUUID() });
  enqueue('plan.generate'); enqueue('submission.review'); const business = enqueue('workflow.reconcile');
  let release; const blocked = new Promise(r => { release = r; }); const calls = [];
  const scheduler = new WorkflowScheduler({ store: f.store, handlers: {
    'plan.generate': async () => { calls.push('plan'); await blocked; return {}; },
    'submission.review': async () => { calls.push('review'); return {}; },
    'workflow.reconcile': async () => { calls.push('business'); return {}; },
  } });
  t.after(() => scheduler.stop());
  const pending = scheduler.tick();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['plan', 'business']);
  assert.equal(f.store.job(business.id).status, 'succeeded');
  release(); await pending; await scheduler.tick();
  assert.deepEqual(calls, ['plan', 'business', 'review']);
  const capacity = enqueue('plan.generate');
  scheduler.handlers['plan.generate'] = async () => { throw Object.assign(new Error('Busy'), { code: 'CODEX_BUSY' }); };
  for (let i = 0; i < 8; i++) {
    f.store.sql.prepare('UPDATE workflow_jobs SET due_at=0 WHERE id=?').run(capacity.id);
    await scheduler.tick();
    assert.equal(f.store.job(capacity.id).status, 'retry_wait');
    assert.equal(f.store.job(capacity.id).attempt, 0);
  }
  f.store.sql.prepare('UPDATE workflow_jobs SET due_at=0 WHERE id=?').run(capacity.id);
  const leased = f.store.claimJob();
  f.store.retryJob(leased.id, leased.leaseToken, 'DENIED', { permanent: true });
  f.store.deferJob(leased.id, 'stale-token', 'CODEX_BUSY');
  assert.equal(f.store.job(leased.id).status, 'needs_attention');
});

test('cancel cleans only unpublished clean worktrees and preserves unexpected dirty resources', t => {
  const f = fixture(t); const s = services(f); const run = f.start();
  f.db.updateUser(f.b.id, { maxStorageBytes: 1 });
  assert.throws(() => s.shares.prepareWorkflow(f.store.claimJob()), { code: 'STORAGE_QUOTA' });
  const members = f.store.run(run.id).authorization.members;
  const clean = s.worktrees.treePath(members[0].prepared.id);
  const dirty = s.worktrees.treePath(members[1].prepared.id);
  fs.writeFileSync(path.join(dirty, 'unexpected.txt'), 'preserve');
  f.store.changeState(run.id, f.boss.id, run.revision, 'cancel');
  s.shares.cleanupCancelled(run.id);
  assert.equal(fs.existsSync(clean), false);
  assert.equal(fs.readFileSync(path.join(dirty, 'unexpected.txt'), 'utf8'), 'preserve');
  assert.equal(f.db.listProjectAccess(f.project.id, { activeOnly: true }).length, 1);
});


test('populated legacy submission migration retains native evidence and child references across repeated upgrades', t => {
  const f = fixture(t); const run = f.start(); const task = f.store.tasks(run.id)[0];
  const id = randomUUID();
  f.store.sql.prepare(`INSERT INTO task_submissions(id,task_id,task_version,submitter_user_id,codex_thread_id,codex_turn_id,
    final_item_id,final_reply_snapshot,snapshot_commit_sha,snapshot_tree_sha,verdict,created_at)
    VALUES (?,?,1,?,'synthetic-thread','synthetic-turn','synthetic-item','fixed synthetic evidence',?,?,'passed',?)`)
    .run(id, task.id, f.a.id, 'a'.repeat(40), 'b'.repeat(40), new Date().toISOString());
  const reviewId = randomUUID();
  f.store.sql.prepare(`INSERT INTO task_reviews(id,submission_id,task_version,actor_user_id,source,verdict,detail_json,dedupe_key,created_at)
    VALUES (?,?,1,?,'human','passed','{}',?,?)`).run(reviewId, id, f.boss.id, randomUUID(), new Date().toISOString());
  f.store.sql.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE legacy_copy AS SELECT id,task_id,task_version,submitter_user_id,project_access_id,chat_id,turn_run_id,
    codex_thread_id,codex_turn_id,final_item_id,final_reply_snapshot,diff_snapshot,employee_note,
    snapshot_commit_sha,snapshot_tree_sha,delivery_commit_sha,delivered_at,verdict,created_at,reviewed_at FROM task_submissions;
    DROP TABLE task_submissions; ALTER TABLE legacy_copy RENAME TO task_submissions; PRAGMA foreign_keys=ON;`);
  for (let i = 0; i < 2; i++) {
    ensureSubmissionSchema(f.store.sql);
    const evidence = f.db.getSubmission(id);
    assert.equal(evidence.codexThreadId, 'synthetic-thread');
    assert.equal(evidence.finalReplySnapshot, 'fixed synthetic evidence');
    assert.equal(evidence.snapshotCommitSha, 'a'.repeat(40));
    assert.equal(evidence.kind, 'codex');
    assert.equal(f.store.sql.prepare('SELECT submission_id FROM task_reviews WHERE id=?').get(reviewId).submission_id, id);
    assert.deepEqual(f.store.sql.prepare('PRAGMA foreign_key_check').all(), []);
  }
  assert.throws(() => f.store.sql.prepare("UPDATE task_submissions SET kind='manual' WHERE id=?").run(id), /CHECK constraint/);
  assert.equal(f.store.sql.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});
