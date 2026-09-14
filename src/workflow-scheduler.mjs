const MODEL_JOBS = ['plan.generate', 'submission.review'];
const WAIT_CODES = new Set(['WORKSPACE_BUSY', 'CODEX_BUSY', 'CODEX_NOT_READY', 'USER_CONCURRENCY_LIMIT']);
const STOP_CODES = new Set(['WORKFLOW_CHANGED', 'WORKFLOW_AUTHORIZATION_CHANGED', 'PROJECT_ACCESS_REVOKED',
  'MEMBER_POLICY_CHANGED', 'USER_DISABLED', 'REWORK_LIMIT_REACHED', 'INDEPENDENT_VALIDATION_REQUIRED',
  'DELIVERY_SCOPE_REVIEW_REQUIRED', 'MODEL_BUDGET_EXCEEDED', 'MODEL_DELIVERY_UNCERTAIN', 'WORKFLOW_RESULT_MISSING',
  'AUTO_REVIEW_DISABLED', 'INPUT_BASE_DIVERGED', 'DELIVERY_MERGE_CONFLICT', 'REVIEW_NEEDS_OWNER']);

export class WorkflowScheduler {
  constructor({ store, handlers, onLeaseLost = async () => {}, intervalMs = 1000, reconcileMs = 30_000, leaseMs = 120_000 }) {
    Object.assign(this, { store, handlers, onLeaseLost, intervalMs, reconcileMs, leaseMs });
    this.inFlight = new Map(); this.lastSweep = 0; this.stopped = false;
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    this.wake();
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = null; }
  wake() { if (!this.stopped) queueMicrotask(() => { this.tick().catch(() => {}); }); }

  sweep() {
    const now = Date.now();
    if (now - this.lastSweep < this.reconcileMs) return;
    this.lastSweep = now;
    for (const run of this.store.runs({ activeOnly: true }).filter((r) => r.status === 'running')) {
      const job = this.store.enqueue({ projectId: run.projectId, ownerId: run.ownerId, runId: run.id, generation: run.generation,
        type: 'workflow.reconcile', dedupeKey: `periodic:${run.id}:${run.generation}` });
      if (job.status === 'succeeded') this.store.sql.prepare(`UPDATE workflow_jobs SET status='queued',attempt=0,due_at=?,
        result_json=NULL,updated_at=? WHERE id=? AND status='succeeded'`).run(now, new Date().toISOString(), job.id);
      for (const task of this.store.tasks(run.id)) {
        if (task.status !== 'passed' && task.dueAt && Date.parse(task.dueAt) <= now) {
          this.store.enqueue({ projectId: run.projectId, ownerId: run.ownerId, runId: run.id, generation: run.generation,
            type: 'task.overdue', dedupeKey: `overdue:${task.id}:${task.version}`, taskId: task.id, taskVersion: task.version });
        }
      }
    }
    // Expired leases may follow a stalled process; native calls must be reconciled, never blindly replayed.
    for (const row of this.store.sql.prepare("SELECT id FROM workflow_jobs WHERE status='leased' AND lease_until<=?").all(now)) {
      const job = this.store.job(row.id);
      this.store.retryJob(job.id, job.leaseToken, job.turnRunId ? 'MODEL_DELIVERY_UNCERTAIN' : 'JOB_LEASE_EXPIRED',
        { permanent: Boolean(job.turnRunId) });
      this.onLeaseLost(job).catch(() => {});
    }
  }

  async tick() {
    if (this.stopped) return;
    this.sweep();
    const launched = [];
    while (!this.stopped && this.inFlight.size < 4) {
      const modelActive = [...this.inFlight.values()].some((entry) => MODEL_JOBS.includes(entry.job.type));
      const job = this.store.claimJob(Date.now(), this.leaseMs, modelActive ? MODEL_JOBS : []);
      if (!job) break;
      const entry = { job, promise: null };
      this.inFlight.set(job.id, entry);
      entry.promise = this.execute(job).finally(() => this.inFlight.delete(job.id));
      launched.push(entry.promise);
    }
    await Promise.allSettled(launched);
  }

  async execute(job) {
    const heartbeat = setInterval(() => {
      if (!this.store.heartbeat(job.id, job.leaseToken, this.leaseMs)) this.onLeaseLost(job).catch(() => {});
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    heartbeat.unref?.();
    try {
      this.store.assertJob(job.id, job.leaseToken);
      let result;
      if (job.type === 'task.overdue') {
        const task = this.store.db.getTask(job.taskId);
        if (task && task.version === job.taskVersion && task.status !== 'passed') {
          this.store.event({ projectId: job.projectId, runId: job.runId, taskId: task.id,
            recipientId: task.assigneeUserId, type: 'task.overdue', payload: { version: task.version } });
        }
        result = { checked: true };
      } else {
        if (!this.handlers[job.type]) throw Object.assign(new Error('Unknown workflow job'), { code: 'UNKNOWN_WORKFLOW_JOB' });
        result = await this.handlers[job.type](job);
      }
      this.store.finishJob(job.id, job.leaseToken, result);
    } catch (error) {
      if (WAIT_CODES.has(error.code)) this.store.deferJob(job.id, job.leaseToken, error.code);
      else {
        this.store.retryJob(job.id, job.leaseToken, error.code || 'WORKFLOW_JOB_FAILED',
          { permanent: STOP_CODES.has(error.code) || error.status === 400 || error.status === 403,
            waitMs: Math.min(60_000, 1000 * 2 ** Math.min(job.attempt, 6)) });
        if (this.store.job(job.id)?.status === 'needs_attention') {
          this.store.event({ projectId: job.projectId, runId: job.runId, taskId: job.taskId, recipientId: job.ownerId,
            type: 'workflow.needs_attention', payload: { reason: this.store.job(job.id).errorCode } });
        }
      }
    } finally { clearInterval(heartbeat); }
  }
}
