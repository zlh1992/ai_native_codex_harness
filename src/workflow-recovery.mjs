// Only the restricted planner can be replayed after a confirmed upstream failure.
// Its sole write commits the plan and job receipt in one transaction.
export function workflowRecovery(job, run) {
  if (!job.turnRunId) return job.result ? 'blocked' : 'retry';
  if (!run || run.id !== job.turnRunId || run.projectId !== job.projectId || run.userId !== job.ownerId) return 'blocked';
  if (!['completed', 'failed', 'interrupted'].includes(run.status)) return 'blocked';
  if (job.result) {
    if (run.status === 'completed') return 'resume';
    if (job.type === 'plan.generate' && run.status === 'failed' && job.result.planId) return 'resume';
    return 'blocked';
  }
  if (job.type === 'plan.generate' && run.status === 'failed' && run.codexTurnId
      && /stream disconnected before completion: Transport error: network error:/i.test(run.errorMessage || '')) return 'retry';
  return 'confirm';
}
