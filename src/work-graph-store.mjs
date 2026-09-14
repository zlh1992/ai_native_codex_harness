import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';
import { assertStandardProject } from './private-projects.mjs';
import { validateGraph, validateProfile, reviewPolicy } from './work-graph-contract.mjs';

const timestamp = () => new Date().toISOString();
const parse = (text, fallback = null) => { try { return JSON.parse(text); } catch { return fallback; } };
let savepoint = 0;
export function atomic(sql, action) {
  const name = `work_graph_${++savepoint}`;
  sql.exec(`SAVEPOINT ${name}`);
  try { const result = action(); sql.exec(`RELEASE ${name}`); return result; }
  catch (error) { sql.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
}

export class WorkGraphStore {
  constructor(db) { this.db = db; this.sql = db.db; }
  transaction(action) { return atomic(this.sql, action); }
  policyEpoch(userId) { return this.sql.prepare('SELECT workflow_policy_epoch FROM users WHERE id=?').get(userId)?.workflow_policy_epoch; }

  owner(projectId, userId) {
    assertStandardProject(this.db.getProject(projectId));
    const user = this.db.getUserById(userId);
    const project = this.db.getProjectForUser(projectId, userId);
    invariant(user?.status === 'active' && user.role === 'admin' && project?.accessKind === 'owner',
      403, 'PROJECT_OWNER_REQUIRED', '只有当前项目老板可以管理工作图。');
    return project;
  }

  profile(userId) {
    const row = this.sql.prepare('SELECT * FROM employee_profiles WHERE user_id=?').get(userId);
    return { userId, ...validateProfile({}), ...parse(row?.profile_json, {}), revision: row?.revision || 0,
      updatedAt: row?.updated_at || null };
  }

  updateProfile(userId, actorId, input, revision) {
    invariant(this.db.getUserById(actorId)?.role === 'admin' && this.db.getUserById(actorId)?.status === 'active',
      403, 'ADMIN_REQUIRED', '仅管理员可以维护员工资料。');
    invariant(this.db.getUserById(userId)?.role === 'user', 404, 'EMPLOYEE_NOT_FOUND', '员工不存在。');
    const profile = validateProfile(input);
    return this.transaction(() => {
      invariant(this.profile(userId).revision === revision, 409, 'PROFILE_CHANGED', '员工资料已更新，请刷新。');
      this.sql.prepare(`INSERT INTO employee_profiles(user_id,profile_json,revision,updated_by,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET profile_json=excluded.profile_json,revision=excluded.revision,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(userId, JSON.stringify(profile), revision + 1, actorId, timestamp());
      return this.profile(userId);
    });
  }

  savePlan({ projectId, ownerId, graph, context = {}, roadmapId = null, expectedVersion = 0 }) {
    this.owner(projectId, ownerId);
    graph = validateGraph(graph, { candidateIds: context.candidateIds || null, employeeFor: (id) => this.db.getUserById(id) });
    return this.transaction(() => {
      const date = timestamp();
      if (roadmapId) {
        const roadmap = this.db.getRoadmap(roadmapId);
        invariant(roadmap?.projectId === projectId && roadmap.kind === 'dag', 404, 'GRAPH_NOT_FOUND', '工作图不存在。');
        invariant(this.latestPlan(roadmapId)?.version === expectedVersion, 409, 'PLAN_CHANGED', '计划版本已变化。');
        invariant(!this.sql.prepare("SELECT id FROM workflow_runs WHERE roadmap_id=? AND status IN ('preparing','running','paused')").get(roadmapId),
          409, 'PLAN_FROZEN', '运行中的计划不可覆盖，请先取消或完成当前运行。');
      } else {
        invariant(expectedVersion === 0, 409, 'PLAN_CHANGED', '新计划版本须为 0。');
        roadmapId = randomUUID();
        this.sql.prepare("INSERT INTO roadmaps(id,project_id,title,status,kind,created_at,updated_at) VALUES (?,?,?,'draft','dag',?,?)")
          .run(roadmapId, projectId, graph.title, date, date);
      }
      const id = randomUUID();
      this.sql.prepare(`INSERT INTO graph_plan_versions(id,roadmap_id,version,graph_json,context_json,created_by,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(id, roadmapId, expectedVersion + 1, JSON.stringify(graph), JSON.stringify(context), ownerId, date);
      this.sql.prepare("UPDATE roadmaps SET title=?,status='draft',version=?,updated_at=? WHERE id=?")
        .run(graph.title, expectedVersion + 1, date, roadmapId);
      this.event({ projectId, type: 'plan.saved', payload: { roadmapId, version: expectedVersion + 1 } });
      return this.plan(id);
    });
  }

  plan(id) {
    const row = this.sql.prepare('SELECT * FROM graph_plan_versions WHERE id=?').get(id);
    return row ? { id: row.id, roadmapId: row.roadmap_id, version: row.version, graph: parse(row.graph_json),
      context: parse(row.context_json, {}), createdBy: row.created_by, createdAt: row.created_at } : null;
  }
  latestPlan(roadmapId) {
    return this.plan(this.sql.prepare('SELECT id FROM graph_plan_versions WHERE roadmap_id=? ORDER BY version DESC LIMIT 1').get(roadmapId)?.id || '');
  }

  start({ roadmapId, ownerId, expectedVersion, policy = {}, idempotencyKey }) {
    const roadmap = this.db.getRoadmap(roadmapId);
    invariant(roadmap?.kind === 'dag', 404, 'GRAPH_NOT_FOUND', '工作图不存在。');
    const project = this.owner(roadmap.projectId, ownerId);
    invariant(typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey),
      400, 'INVALID_IDEMPOTENCY_KEY', '须提供 16–100 位幂等标识。');
    return this.transaction(() => {
      const prior = this.sql.prepare('SELECT workflow_run_id FROM workflow_jobs WHERE dedupe_key=?')
        .get(`start:${roadmapId}:${idempotencyKey}`);
      if (prior) return this.run(prior.workflow_run_id);
      const plan = this.latestPlan(roadmapId);
      invariant(plan?.version === expectedVersion, 409, 'PLAN_CHANGED', '计划版本已变化，请刷新。');
      const graph = validateGraph(plan.graph, { candidateIds: plan.context.candidateIds, employeeFor: (id) => this.db.getUserById(id) });
      invariant(!this.sql.prepare("SELECT id FROM workflow_runs WHERE project_id=? AND status IN ('preparing','running','paused')").get(project.id),
        409, 'PROJECT_WORKFLOW_ACTIVE', '项目已有未完成的工作图，请先完成或取消。');
      const id = randomUUID();
      const date = timestamp();
      const members = [...new Set(graph.nodes.map((node) => node.assigneeUserId))];
      const authorization = { scope: 'files_only', ownerEpoch: this.policyEpoch(ownerId),
        members: members.map((userId) => ({ userId, epoch: this.policyEpoch(userId),
          accessId: this.db.getProjectForUser(project.id, userId)?.accessId || null })) };
      this.sql.prepare(`INSERT INTO workflow_runs(id,roadmap_id,plan_id,project_id,owner_user_id,owner_access_id,
        status,review_policy_json,authorization_json,created_at,updated_at) VALUES (?,?,?,?,?,?,'preparing',?,?,?,?)`)
        .run(id, roadmapId, plan.id, project.id, ownerId, project.accessId, JSON.stringify(reviewPolicy(policy)), JSON.stringify(authorization), date, date);
      const insert = this.sql.prepare(`INSERT INTO tasks(id,roadmap_id,project_id,assignee_user_id,position,title,acceptance,
        status,workflow_run_id,node_key,checklist_json,due_at,blocked_reason,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'ready',?,?,?,?,'PREPARING',?,?)`);
      const offset = this.sql.prepare('SELECT COALESCE(MAX(position),-1)+1 AS value FROM tasks WHERE roadmap_id=?').get(roadmapId).value;
      graph.nodes.forEach((node, index) => insert.run(randomUUID(), roadmapId, project.id, node.assigneeUserId, offset + index,
        node.title, node.acceptance, id, node.key, JSON.stringify(node.checklist), node.dueAt, date, date));
      this.sql.prepare("UPDATE roadmaps SET current_workflow_id=?,status='ready',updated_at=? WHERE id=?").run(id, date, roadmapId);
      this.enqueue({ projectId: project.id, ownerId, runId: id, type: 'share.prepare', dedupeKey: `start:${roadmapId}:${idempotencyKey}` });
      this.event({ projectId: project.id, runId: id, type: 'workflow.preparing', payload: { status: 'preparing' } });
      return this.run(id);
    });
  }

  run(id) {
    const row = this.sql.prepare('SELECT * FROM workflow_runs WHERE id=?').get(id);
    return row ? { id: row.id, roadmapId: row.roadmap_id, planId: row.plan_id, projectId: row.project_id,
      ownerId: row.owner_user_id, ownerAccessId: row.owner_access_id, status: row.status, revision: row.revision,
      generation: row.generation, reviewPolicy: parse(row.review_policy_json), authorization: parse(row.authorization_json),
      pausedReason: row.paused_reason, lastCheckedAt: row.last_checked_at, nextCheckAt: row.next_check_at,
      createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  runs({ projectId = null, activeOnly = false } = {}) {
    return this.sql.prepare(`SELECT id FROM workflow_runs WHERE (? IS NULL OR project_id=?)
      ${activeOnly ? "AND status IN ('preparing','running','paused')" : ''} ORDER BY created_at DESC`)
      .all(projectId, projectId).map((r) => this.run(r.id));
  }
  tasks(runId) { return this.sql.prepare('SELECT id FROM tasks WHERE workflow_run_id=? ORDER BY position').all(runId).map((t) => this.db.getTask(t.id)); }

  assertRun(id, generation = null, states = ['running']) {
    const run = this.run(id);
    invariant(run && states.includes(run.status) && (generation === null || run.generation === generation),
      409, 'WORKFLOW_CHANGED', '工作图已暂停、结束或版本已变化。');
    const project = this.owner(run.projectId, run.ownerId);
    invariant(project.accessId === run.ownerAccessId && this.policyEpoch(run.ownerId) === run.authorization.ownerEpoch,
      403, 'WORKFLOW_AUTHORIZATION_CHANGED', '老板账号策略已变化，请恢复工作图授权。');
    return run;
  }

  changeState(id, ownerId, revision, action) {
    return this.transaction(() => {
      const run = this.run(id);
      invariant(run && run.ownerId === ownerId, 403, 'WORKFLOW_FORBIDDEN', '无权操作工作图。');
      this.owner(run.projectId, ownerId);
      invariant(run.revision === revision, 409, 'WORKFLOW_CHANGED', '工作图已更新，请刷新。');
      const states = { pause: ['preparing', 'running'], resume: ['paused'], cancel: ['preparing', 'running', 'paused'] };
      invariant(states[action]?.includes(run.status), 409, 'WORKFLOW_STATE_INVALID', '当前状态不允许此操作。');
      const status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled'
        : this.tasks(id).every((t) => t.assignedAccessId) ? 'running' : 'preparing';
      // Invalidate every old job/callback, including jobs currently in native RPC setup.
      this.sql.prepare(`UPDATE workflow_runs SET status=?,revision=revision+1,generation=generation+1,
        paused_reason=?,updated_at=? WHERE id=?`).run(status, action === 'pause' ? 'OWNER_PAUSED' : null, timestamp(), id);
      this.sql.prepare("UPDATE workflow_jobs SET status='cancelled',lease_token=NULL,lease_until=NULL,updated_at=? WHERE workflow_run_id=? AND status NOT IN ('succeeded','cancelled')")
        .run(timestamp(), id);
      if (action === 'resume') {
        const authorization = { ...run.authorization, ownerEpoch: this.policyEpoch(ownerId),
          members: run.authorization.members.map((m) => ({ ...m, epoch: this.policyEpoch(m.userId) })) };
        this.sql.prepare('UPDATE workflow_runs SET authorization_json=? WHERE id=?').run(JSON.stringify(authorization), id);
        this.enqueue({ projectId: run.projectId, ownerId, runId: id, generation: run.generation + 1,
          type: status === 'preparing' ? 'share.prepare' : 'workflow.reconcile', dedupeKey: `resume:${id}:${run.generation + 1}` });
      }
      this.event({ projectId: run.projectId, runId: id, type: `workflow.${status}`, payload: { status } });
      return this.run(id);
    });
  }

  enqueue({ projectId, ownerId, runId = null, generation = 1, type, dedupeKey, taskId = null, taskVersion = null,
    submissionId = null, payload = {}, dueAt = Date.now(), maxAttempts = 5 }) {
    this.sql.prepare(`INSERT OR IGNORE INTO workflow_jobs(id,project_id,owner_user_id,workflow_run_id,type,dedupe_key,
      generation,task_id,task_version,submission_id,payload_json,due_at,max_attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), projectId, ownerId, runId, type, dedupeKey, generation,
      taskId, taskVersion, submissionId, JSON.stringify(payload), dueAt, maxAttempts, timestamp(), timestamp());
    return this.job(this.sql.prepare('SELECT id FROM workflow_jobs WHERE dedupe_key=?').get(dedupeKey).id);
  }
  job(id) {
    const row = this.sql.prepare('SELECT * FROM workflow_jobs WHERE id=?').get(id);
    return row ? { id: row.id, projectId: row.project_id, ownerId: row.owner_user_id, runId: row.workflow_run_id,
      type: row.type, dedupeKey: row.dedupe_key, generation: row.generation, taskId: row.task_id, taskVersion: row.task_version,
      submissionId: row.submission_id, payload: parse(row.payload_json, {}), result: parse(row.result_json),
      status: row.status, dueAt: row.due_at, leaseToken: row.lease_token, leaseUntil: row.lease_until,
      attempt: row.attempt, maxAttempts: row.max_attempts, errorCode: row.error_code, turnRunId: row.turn_run_id,
      createdAt: row.created_at, updatedAt: row.updated_at } : null;
  }
  claimJob(now = Date.now(), leaseMs = 60_000, excludeTypes = []) {
    return this.transaction(() => {
      const row = this.sql.prepare(`SELECT id FROM workflow_jobs WHERE status IN ('queued','retry_wait') AND due_at<=?
        ${excludeTypes.length ? `AND type NOT IN (${excludeTypes.map(() => '?').join(',')})` : ''}
        ORDER BY due_at,created_at LIMIT 1`).get(now, ...excludeTypes);
      if (!row) return null;
      const result = this.sql.prepare(`UPDATE workflow_jobs SET status='leased',lease_token=?,lease_until=?,attempt=attempt+1,
        updated_at=? WHERE id=? AND status IN ('queued','retry_wait')`).run(randomUUID(), now + leaseMs, timestamp(), row.id);
      return result.changes ? this.job(row.id) : null;
    });
  }
  assertJob(id, token) {
    const job = this.job(id);
    invariant(job?.status === 'leased' && job.leaseToken === token && job.leaseUntil > Date.now(),
      409, 'JOB_LEASE_LOST', '后台任务租约已失效。');
    if (job.runId) this.assertRun(job.runId, job.generation, ['preparing', 'running']);
    return job;
  }
  heartbeat(id, token, leaseMs = 60_000) {
    return this.sql.prepare("UPDATE workflow_jobs SET lease_until=? WHERE id=? AND status='leased' AND lease_token=? AND lease_until>?")
      .run(Date.now() + leaseMs, id, token, Date.now()).changes === 1;
  }
  finishJob(id, token, result = null) {
    const job = this.job(id);
    invariant(job?.status === 'leased' && job.leaseToken === token && job.leaseUntil > Date.now()
      && (!job.runId || this.run(job.runId)?.generation === job.generation), 409, 'JOB_LEASE_LOST', '后台任务租约已失效。');
    this.sql.prepare("UPDATE workflow_jobs SET status='succeeded',result_json=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?")
      .run(JSON.stringify(result), timestamp(), id, token);
  }
  retryJob(id, token, code, { waitMs = 1000, permanent = false } = {}) {
    const job = this.job(id);
    if (job?.status !== 'leased' || job.leaseToken !== token) return;
    const errorCode = /^[A-Z0-9_]{1,80}$/.test(String(code)) ? code : 'WORKFLOW_JOB_FAILED';
    this.sql.prepare(`UPDATE workflow_jobs SET status=?,error_code=?,due_at=?,lease_token=NULL,lease_until=NULL,
      updated_at=? WHERE id=? AND lease_token=?`).run(permanent || job.attempt >= job.maxAttempts ? 'needs_attention' : 'retry_wait',
      errorCode, Date.now() + waitMs, timestamp(), id, token);
  }
  deferJob(id, token, code, waitMs = 2000) {
    const current = this.job(id);
    if (current?.status !== 'leased' || current.leaseToken !== token) return;
    this.retryJob(id, token, code, { waitMs });
    // Resource contention is not a failed attempt and cannot exhaust the failure budget.
    this.sql.prepare(`UPDATE workflow_jobs SET status='retry_wait',attempt=MAX(0,attempt-1)
      WHERE id=? AND status IN ('retry_wait','needs_attention')`).run(id);
  }
  recoverJobs() {
    // Called only on Portal startup. A maintenance CLI must not recover live leases.
    this.sql.prepare(`UPDATE workflow_jobs SET status=CASE WHEN turn_run_id IS NOT NULL
      AND NOT (result_json IS NOT NULL AND EXISTS (SELECT 1 FROM turn_runs tr WHERE tr.id=workflow_jobs.turn_run_id AND tr.status='completed'))
      THEN 'needs_attention' ELSE 'retry_wait' END,
      error_code=CASE WHEN turn_run_id IS NOT NULL THEN 'MODEL_DELIVERY_UNCERTAIN' ELSE 'PORTAL_RESTARTED' END,
      lease_token=NULL,lease_until=NULL,due_at=?,updated_at=? WHERE status='leased'`).run(Date.now(), timestamp());
  }

  event({ projectId, runId = null, taskId = null, recipientId = null, type, payload = {} }) {
    const allowed = new Set(['roadmapId', 'submissionId', 'reviewId', 'handoffId', 'version', 'revision', 'status', 'count', 'reason']);
    const safe = {};
    for (const [key, value] of Object.entries(payload)) {
      if (!allowed.has(key)) continue;
      if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
      else if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)) safe[key] = value;
    }
    invariant(/^[a-z_.]{1,80}$/.test(type), 500, 'INVALID_PROJECT_EVENT', '项目事件类型无效。');
    return Number(this.sql.prepare(`INSERT INTO project_events(project_id,workflow_run_id,task_id,recipient_user_id,event_type,payload_json,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(projectId, runId, taskId, recipientId, type, JSON.stringify(safe), timestamp()).lastInsertRowid);
  }
  events(projectId, userId, after = 0, limit = 500) {
    const project = this.db.getProjectForUser(projectId, userId);
    invariant(this.db.getUserById(userId)?.status === 'active' && project, 403, 'PROJECT_FORBIDDEN', '项目访问已失效。');
    return this.sql.prepare(`SELECT * FROM project_events WHERE project_id=? AND id>?
      AND (recipient_user_id IS NULL OR recipient_user_id=? OR ?=1) ORDER BY id LIMIT ?`)
      .all(projectId, Math.max(0, after), userId, project.accessKind === 'owner' ? 1 : 0, Math.min(500, Math.max(1, limit)))
      .map((r) => ({ id: r.id, projectId: r.project_id, runId: r.workflow_run_id, taskId: r.task_id,
        type: r.event_type, payload: parse(r.payload_json, {}), createdAt: r.created_at }));
  }
}
