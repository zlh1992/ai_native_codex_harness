import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkGraphRuntime } from '../src/work-graph-runtime.mjs';

function fixture(purpose = 'reviewer') {
  const job = { id: 'job', runId: 'run', projectId: 'project', ownerId: 'boss', submissionId: 'submission',
    taskId: 'task', turnRunId: 'turn', payload: {}, result: null };
  let saved;
  const store = { job: () => job, assertJob: () => job, owner: () => ({}), transaction: fn => fn(),
    savePlan: input => { saved = input.graph; return { id: 'plan', roadmapId: 'roadmap', version: 1 }; },
    sql: { prepare: query => ({ run: value => {
      if (query.includes('payload_json')) job.payload = JSON.parse(value);
      if (query.includes('result_json')) job.result = JSON.parse(value);
    } }) } };
  const active = { chat: { purpose, workflowJobId: 'job', userId: 'boss', projectId: 'project' },
    workflowLeaseToken: 'lease', turnRunId: 'turn', threadId: 'root' };
  const runtime = new WorkGraphRuntime({ store, db: { getTask: () => ({}) }, graphs: { member: () => ({}) },
    context: { review: async () => ({ coverage: [{ path: 'report.md', complete: true }], files: [{ path: 'report.md', content: 'fixed evidence' }] }) },
    reviews: { proposal: () => ({ id: 'review' }) } });
  return { runtime, active, job, saved: () => saved };
}

test('reviewer must read evidence in the same root turn and cannot cite unread files', async () => {
  const { runtime, active, job } = fixture();
  const args = { verdict: 'passed', items: [{ evidence: ['report.md'] }] };
  await assert.rejects(() => runtime.call(active, 'work_graph_submit_review', args, 'root'), { code: 'REVIEW_CONTEXT_REQUIRED' });
  await runtime.call(active, 'work_graph_context', {}, 'child');
  assert.equal(job.payload.reviewEvidence, undefined);
  await runtime.call(active, 'work_graph_context', {}, 'root');
  assert.equal(job.payload.reviewEvidence.turnRunId, 'turn');
  assert.equal(JSON.stringify(job.payload).includes('fixed evidence'), false);
  await assert.rejects(() => runtime.call(active, 'work_graph_submit_review', { items: [{ evidence: ['unread.pdf'] }] }, 'root'), { code: 'INVALID_REVIEW_EVIDENCE' });
  assert.deepEqual(await runtime.call(active, 'work_graph_submit_review', args, 'root'), { reviewId: 'review' });
});

test('model-generated plans cannot escalate a node to automatic review', async () => {
  const f = fixture('planner'); f.job.payload.inputs = { files: [] };
  await f.runtime.call(f.active, 'work_graph_submit_plan', { graph: { nodes: [{ key: 'delivery', reviewMode: 'auto' }] } }, 'root');
  assert.equal(f.saved().nodes[0].reviewMode, undefined);
});

test('reviewer can cite only upstream snapshot references actually read by this root', async () => {
  const { runtime, active, job } = fixture();
  const ref = 'upstream:approved-submission:report.md';
  runtime.context.review = async () => ({ coverage: [{ path: 'report.md', evidenceRef: ref, complete: true }],
    files: [{ path: 'report.md', evidenceRef: ref, content: 'upstream fixed text' }] });
  await runtime.call(active, 'work_graph_context', {}, 'root');
  assert.deepEqual(job.payload.reviewEvidence.readablePaths, [ref]);
  assert.equal(JSON.stringify(job.payload).includes('upstream fixed text'), false);
  for (const unread of ['report.md', 'upstream:another-submission:report.md']) {
    await assert.rejects(() => runtime.call(active, 'work_graph_submit_review', { items: [{ evidence: [unread] }] }, 'root'),
      { code: 'INVALID_REVIEW_EVIDENCE' });
  }
  assert.deepEqual(await runtime.call(active, 'work_graph_submit_review', { items: [{ evidence: [ref] }] }, 'root'), { reviewId: 'review' });
});
