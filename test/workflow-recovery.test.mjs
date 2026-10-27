import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowRecovery } from '../src/workflow-recovery.mjs';
import { jobAttentionMarkup, jobProgress, reviewProgressLabel } from '../public/work-graph.js';

const job = { id: 'job', type: 'plan.generate', turnRunId: 'turn', projectId: 'project', ownerId: 'boss', result: null };
const run = { id: 'turn', projectId: 'project', userId: 'boss', status: 'failed', codexTurnId: 'native',
  errorMessage: 'stream disconnected before completion: Transport error: network error: error decoding response body' };

test('only confirmed terminal planner network failures without receipts can automatically retry', () => {
  assert.equal(workflowRecovery(job, run), 'retry');
  for (const status of ['running', 'starting', 'queued']) assert.equal(workflowRecovery(job, { ...run, status }), 'blocked');
  assert.equal(workflowRecovery(job, null), 'blocked');
  assert.equal(workflowRecovery(job, { ...run, userId: 'other' }), 'blocked');
  assert.equal(workflowRecovery(job, { ...run, status: 'interrupted' }), 'confirm');
  assert.equal(workflowRecovery(job, { ...run, codexTurnId: null }), 'confirm');
  assert.equal(workflowRecovery(job, { ...run, errorMessage: 'arbitrary failure' }), 'confirm');
  assert.equal(workflowRecovery({ ...job, type: 'submission.review' }, run), 'confirm');
});

test('persisted receipts resume and cannot be discarded by acknowledging uncertainty', () => {
  const receipt = { ...job, result: { planId: 'plan' } };
  assert.equal(workflowRecovery(receipt, run), 'resume');
  assert.equal(workflowRecovery(receipt, { ...run, status: 'completed' }), 'resume');
  assert.equal(workflowRecovery(receipt, { ...run, status: 'interrupted' }), 'blocked');
  assert.equal(workflowRecovery({ ...receipt, turnRunId: null }, null), 'blocked');
  assert.equal(workflowRecovery({ ...receipt, type: 'submission.review' }, run), 'blocked');
});

test('recovery UI distinguishes safe retry, receipt resume and uncertainty; escapes diagnostics', () => {
  const base = { ...job, chatId: 'chat', progress: { configuredModel: '<unsafe>', modelCalls: 2 }, errorCode: 'PLANNER_TRANSIENT_NETWORK' };
  assert.match(jobProgress(base), /已调用 2 次/);
  assert.doesNotMatch(jobAttentionMarkup({ ...base, recovery: 'retry' }), /data-ack|<unsafe>/);
  assert.match(jobAttentionMarkup({ ...base, recovery: 'retry' }), /查看后台记录/);
  assert.match(jobAttentionMarkup({ ...base, recovery: 'confirm' }), /data-ack/);
  assert.match(jobAttentionMarkup({ ...base, recovery: 'resume' }), /恢复后续步骤/);
  assert.match(jobAttentionMarkup({ ...base, recovery: 'blocked' }), /disabled/);
});


test('delivery recovery is distinct from model review and never claims completion before apply', () => {
  const apply = { type: 'review.apply', status: 'needs_attention', errorCode: 'DELIVERY_UNSUPPORTED_ENTRY', attempt: 1, maxAttempts: 5, recovery: 'retry' };
  assert.match(jobProgress(apply), /此步骤不调用模型/);
  assert.doesNotMatch(jobProgress(apply), /配置模型/);
  assert.match(jobAttentionMarkup(apply), /不会重新调用审核模型/);
  assert.match(reviewProgressLabel({ status: 'submitted', reviewJob: apply }), /应用受阻/);
  assert.match(reviewProgressLabel({ status: 'passed', reviewJob: apply }), /已通过并完成交付/);
  assert.match(reviewProgressLabel({ status: 'submitted', reviewMode: 'assisted' }), /随后由老板决定/);
  assert.doesNotMatch(reviewProgressLabel({ status: 'submitted', reviewMode: 'assisted' }), /自动交付/);
});
