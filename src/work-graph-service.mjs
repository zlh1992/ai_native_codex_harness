import { invariant } from './errors.mjs';
import fs from 'node:fs';
import { deliveryRelativePath, graphText, nodeReviewMode } from './work-graph-contract.mjs';

export class WorkGraphService {
  constructor({ db, store, workspace, worktrees, codex }) { Object.assign(this, { db, store, workspace, worktrees, codex }); }

  idle(accessId) { invariant(!this.codex.workspaceBusy(accessId), 409, 'WORKSPACE_BUSY', '等待工作树空闲后继续。'); }
  node(task) { return this.store.plan(this.store.run(task.workflowRunId).planId).graph.nodes.find((n) => n.key === task.nodeKey); }
  member(task, run = this.store.assertRun(task.workflowRunId)) {
    const user = this.db.getUserById(task.assigneeUserId);
    const auth = run.authorization.members.find((m) => m.userId === task.assigneeUserId);
    const project = this.db.getProjectForUser(task.projectId, task.assigneeUserId);
    invariant(user?.status === 'active' && auth && this.store.policyEpoch(user.id) === auth.epoch,
      403, 'MEMBER_POLICY_CHANGED', '员工账号策略已变化，请老板处理。');
    invariant(project?.accessId === task.assignedAccessId && project.accessId === auth.accessId,
      403, 'PROJECT_ACCESS_REVOKED', '任务绑定的员工授权已撤销。');
    return project;
  }
  taskFor(taskId, userId) {
    const task = this.db.getTaskForUser(taskId, userId);
    invariant(task?.workflowRunId, 403, 'TASK_FORBIDDEN', '工作图任务不存在或不属于你。');
    const run = this.store.assertRun(task.workflowRunId);
    const project = this.member(task, run);
    return { task, run, project };
  }
  updateChecklist(taskId, userId, { taskVersion, revision, items }) {
    const { task, run } = this.taskFor(taskId, userId);
    invariant(['active', 'rework'].includes(task.status) && task.version === taskVersion && task.checklistRevision === revision,
      409, 'TASK_VERSION_CHANGED', '任务或清单已变化，请刷新。');
    invariant(Array.isArray(items) && items.length === task.checklist.length
      && new Set(items.map((i) => i?.id)).size === items.length, 400, 'INVALID_CHECKLIST', '须提交完整清单状态。');
    const checklist = task.checklist.map((item) => {
      const change = items.find((i) => i?.id === item.id);
      invariant(change && typeof change.done === 'boolean', 400, 'INVALID_CHECKLIST', '清单项无效。');
      return { ...item, done: change.done };
    });
    return this.store.transaction(() => {
      const changed = this.db.db.prepare(`UPDATE tasks SET checklist_json=?,checklist_revision=checklist_revision+1,updated_at=?
        WHERE id=? AND version=? AND checklist_revision=? AND status IN ('active','rework')`)
        .run(JSON.stringify(checklist), new Date().toISOString(), task.id, taskVersion, revision);
      invariant(changed.changes === 1, 409, 'TASK_VERSION_CHANGED', '清单状态已变化。');
      this.store.event({ projectId: task.projectId, runId: run.id, taskId, recipientId: userId,
        type: 'task.checklist_updated', payload: { version: task.version, revision: revision + 1 } });
      return this.db.getTask(taskId);
    });
  }

  deliveryFiles(taskId, userId, { taskVersion, outputs = [] }) {
    const { task, project } = this.taskFor(taskId, userId);
    invariant(task.version === taskVersion && ['active', 'rework'].includes(task.status),
      409, 'TASK_VERSION_CHANGED', '任务版本或状态已变化。');
    invariant(Array.isArray(outputs) && outputs.length <= 30, 400, 'INVALID_OUTPUTS', '成果文件最多 30 个。');
    const root = this.workspace.projectRoot(project);
    const canonicalRoot = fs.realpathSync(root);
    const paths = [...new Set([...this.node(task).outputs, ...outputs.map(p => deliveryRelativePath(p, root, canonicalRoot))])];
    invariant(paths.length <= 30, 400, 'INVALID_OUTPUTS', '含必交成果最多 30 个文件。');
    const files = paths.map(p => this.workspace.fileMetadata(project, p));
    invariant(files.reduce((sum, f) => sum + f.size, 0) <= 32 * 1024 * 1024,
      413, 'CONTEXT_TOO_LARGE', '交付文件总大小最多 32 MiB。');
    return files;
  }

  submit(taskId, userId, body) {
    const { task, run, project } = this.taskFor(taskId, userId);
    const key = body.idempotencyKey;
    invariant(typeof key === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(key), 400, 'INVALID_IDEMPOTENCY_KEY', '提交须携带幂等标识。');
    const previous = this.db.listSubmissionsForTask(taskId).find((s) => s.idempotencyKey === key);
    if (previous) return previous;
    invariant(['active', 'rework'].includes(task.status) && task.version === body.taskVersion
      && task.checklistRevision === body.checklistRevision, 409, 'TASK_VERSION_CHANGED', '任务版本或清单已变化。');
    invariant(task.checklist.every((item) => item.done), 409, 'CHECKLIST_INCOMPLETE', '请先完成全部清单项。');
    this.idle(project.accessId);
    const kind = body.kind || 'codex';
    invariant(['codex', 'manual'].includes(kind), 400, 'INVALID_SUBMISSION_KIND', '提交来源无效。');
    const resultSummary = graphText(body.resultSummary || '', '成果说明', 8000, kind === 'codex');
    const note = graphText(body.note || '', '交付备注', 4000, true);
    invariant(!body.outputs || (Array.isArray(body.outputs) && body.outputs.length <= 30), 400, 'INVALID_OUTPUTS', '成果文件最多 30 个。');
    const paths = this.deliveryFiles(taskId, userId, body).map(f => f.path);
    invariant(paths.length <= 30, 400, 'INVALID_OUTPUTS', '成果文件最多 30 个。');
    // Validate completed native evidence before creating a Git snapshot.
    if (kind === 'codex') {
      const turn = this.db.getTurnRun(body.turnRunId || '');
      invariant(turn?.taskId === task.id && turn.userId === userId && turn.chatId === body.chatId
        && turn.taskVersion === task.version && turn.status === 'completed' && turn.finalItemId === body.itemId,
      409, 'FINAL_ITEM_REQUIRED', '请选择当前任务版本已完成的 Codex 最终回复。');
    }
    const snapshot = this.worktrees.createSubmissionSnapshot({ treePath: project.treePath, taskId, taskVersion: task.version });
    const outputs = this.worktrees.readSnapshotFiles({ projectRoot: project.treePath, commitSha: snapshot.commitSha, paths,
      includeContent: false, maxBytes: 32 * 1024 * 1024 });
    return this.db.submitTask({ taskId, taskVersion: task.version, submitterUserId: userId, projectAccessId: project.accessId,
      kind, chatId: kind === 'codex' ? body.chatId : null, turnRunId: kind === 'codex' ? body.turnRunId : null,
      itemId: kind === 'codex' ? body.itemId : null, resultSummary, note, checklistSnapshot: task.checklist,
      outputsManifest: outputs, idempotencyKey: key, snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha,
      afterSubmit: (submission) => {
        this.db.db.prepare("UPDATE tasks SET blocked_reason='WAITING_REVIEW' WHERE id=?").run(taskId);
        this.scheduleReview(task, run, submission);
        this.store.event({ projectId: task.projectId, runId: run.id, taskId, recipientId: userId,
          type: 'task.submitted', payload: { submissionId: submission.id, version: task.version } });
      } });
  }

  scheduleReview(task, run, submission) {
    const mode = nodeReviewMode(this.node(task), run.reviewPolicy);
    if (mode === 'manual') return;
    this.store.enqueue({ projectId: task.projectId, ownerId: run.ownerId, runId: run.id, generation: run.generation,
      taskId: task.id, taskVersion: task.version, submissionId: submission.id, type: 'submission.review',
      dedupeKey: `review:${run.id}:${run.generation}:${submission.id}`, payload: { mode } });
  }

  block(task, reason) {
    if (task.blockedReason === reason) return;
    this.store.transaction(() => {
      this.db.db.prepare('UPDATE tasks SET blocked_reason=?,updated_at=? WHERE id=?').run(reason, new Date().toISOString(), task.id);
      this.store.event({ projectId: task.projectId, runId: task.workflowRunId, taskId: task.id, recipientId: task.assigneeUserId,
        type: 'task.blocked', payload: { reason } });
    });
  }

  reconcile(runId, generation = null) {
    const run = this.store.assertRun(runId, generation);
    const tasks = this.store.tasks(runId);
    const byKey = new Map(tasks.map((task) => [task.nodeKey, task]));
    const owner = this.store.owner(run.projectId, run.ownerId);
    for (const task of tasks) {
      if (task.status === 'passed') continue;
      try {
        const project = this.member(task, run);
        if (task.status === 'submitted') {
          const submission = this.db.listSubmissionsForTask(task.id).find((s) => s.taskVersion === task.version && s.verdict === 'pending');
          if (submission) this.scheduleReview(task, run, submission);
          continue;
        }
        if (task.status !== 'ready') {
          if (['MEMBER_POLICY_CHANGED', 'PROJECT_ACCESS_REVOKED'].includes(task.blockedReason)) this.block(task, null);
          continue;
        }
        const dependencies = this.node(task).dependsOn.map((key) => byKey.get(key));
        if (!dependencies.every((t) => t?.status === 'passed')) { this.block(task, 'WAITING_DEPENDENCIES'); continue; }
        if (this.store.tasks(runId).some((t) => t.id !== task.id && t.assigneeUserId === task.assigneeUserId
          && ['active', 'rework', 'submitted'].includes(t.status))) { this.block(task, 'WAITING_EMPLOYEE'); continue; }
        this.idle(project.accessId); this.idle(owner.accessId);
        const handoffs = dependencies.map((t) => this.handoffFor(t.id, t.version));
        invariant(handoffs.every(Boolean), 409, 'WAITING_HANDOFF', '等待上游交付记录。');
        const baseSha = this.worktrees.head(this.workspace.projectRoot(owner));
        this.worktrees.synchronizeShare({ projectRoot: this.workspace.projectRoot(owner), treePath: project.treePath, commitSha: baseSha });
        this.store.transaction(() => {
          this.store.assertRun(runId, run.generation);
          this.member(task, run);
          const changed = this.db.db.prepare(`UPDATE tasks SET status='active',blocked_reason=NULL,input_manifest_json=?,
            input_base_sha=?,updated_at=? WHERE id=? AND status='ready' AND version=?`)
            .run(JSON.stringify(handoffs), baseSha, new Date().toISOString(), task.id, task.version);
          if (changed.changes) this.store.event({ projectId: run.projectId, runId, taskId: task.id,
            recipientId: task.assigneeUserId, type: 'task.dispatched', payload: { version: task.version } });
        });
      } catch (error) {
        if (!error.code || error.status >= 500) throw error;
        this.block(task, error.code);
      }
    }
    if (tasks.length && this.store.tasks(runId).every((task) => task.status === 'passed' && this.handoffFor(task.id, task.version))) {
      this.store.transaction(() => {
        this.db.db.prepare("UPDATE workflow_runs SET status='passed',revision=revision+1,updated_at=? WHERE id=? AND status='running'")
          .run(new Date().toISOString(), runId);
        this.db.db.prepare("UPDATE roadmaps SET status='passed' WHERE id=?").run(run.roadmapId);
        this.db.db.prepare("UPDATE workflow_jobs SET status='cancelled' WHERE workflow_run_id=? AND status IN ('queued','retry_wait','needs_attention')").run(runId);
        this.store.event({ projectId: run.projectId, runId, type: 'workflow.passed', payload: { status: 'passed' } });
      });
    }
    this.db.db.prepare('UPDATE workflow_runs SET last_checked_at=?,next_check_at=? WHERE id=?')
      .run(new Date().toISOString(), this.store.run(runId).status === 'passed' ? null : new Date(Date.now() + 30_000).toISOString(), runId);
    return { status: this.store.run(runId).status };
  }

  handoffFor(taskId, version) {
    const row = this.db.db.prepare('SELECT * FROM task_handoffs WHERE task_id=? AND task_version=?').get(taskId, version);
    return row ? { id: row.id, taskId: row.task_id, taskVersion: row.task_version, submissionId: row.submission_id,
      deliveryCommitSha: row.delivery_commit_sha, ...JSON.parse(row.manifest_json) } : null;
  }

  handoffs(taskId, userId) {
    const task = this.db.getTask(taskId);
    invariant(task?.workflowRunId && this.db.getUserById(userId)?.status === 'active', 403, 'TASK_FORBIDDEN', '任务不可访问。');
    const run = this.store.run(task.workflowRunId);
    const project = this.db.getProjectForUser(task.projectId, userId);
    invariant(project && (run.ownerId === userId || task.assigneeUserId === userId), 403, 'TASK_FORBIDDEN', '无权读取交接成果。');
    const tasks = this.store.tasks(run.id);
    return this.node(task).dependsOn.map((key) => tasks.find((t) => t.nodeKey === key))
      .filter((t) => t?.status === 'passed').map((t) => this.handoffFor(t.id, t.version)).filter(Boolean);
  }

  artifact(submissionId, userId, relative) {
    const submission = this.db.getSubmission(submissionId);
    const task = submission && this.db.getTask(submission.taskId);
    const project = task && this.db.getProjectForUser(task.projectId, userId);
    invariant(task?.workflowRunId && project && this.db.getUserById(userId)?.status === 'active', 403, 'ARTIFACT_FORBIDDEN', '无权读取交付成果。');
    const run = this.store.run(task.workflowRunId);
    const ownsTask = task.assigneeUserId === userId;
    const downstream = this.store.tasks(run.id).some(t => t.assigneeUserId === userId
      && t.inputManifest.some(h => h.submissionId === submissionId));
    invariant(run.ownerId === userId || ownsTask || (submission.verdict === 'passed' && downstream),
      403, 'ARTIFACT_FORBIDDEN', '无权读取该次交付成果。');
    const output = submission.outputsManifest.find(f => f.path === relative);
    invariant(output, 404, 'ARTIFACT_NOT_FOUND', '成果文件不在交付清单中。');
    const [file] = this.worktrees.readSnapshotFiles({ projectRoot: this.workspace.projectRoot(project),
      commitSha: submission.snapshotCommitSha, paths: [relative], maxBytes: 32 * 1024 * 1024, includeBytes: true });
    invariant(file.sha256 === output.sha256, 409, 'OUTPUT_HASH_CHANGED', '交付成果校验失败。');
    return file;
  }

  view(roadmapId, userId) {
    const roadmap = this.db.getRoadmap(roadmapId);
    invariant(roadmap?.kind === 'dag' && this.db.getUserById(userId)?.status === 'active', 404, 'GRAPH_NOT_FOUND', '工作图不存在。');
    const project = this.db.getProjectForUser(roadmap.projectId, userId);
    invariant(project, 403, 'PROJECT_FORBIDDEN', '项目访问已失效。');
    const owner = project.accessKind === 'owner';
    const run = roadmap.currentWorkflowId ? this.store.run(roadmap.currentWorkflowId) : null;
    const plan = this.store.latestPlan(roadmapId);
    const tasks = run && run.planId === plan.id ? this.store.tasks(run.id) : [];
    const safeRun = run ? { id: run.id, status: run.status, revision: run.revision, generation: run.generation,
      pausedReason: run.pausedReason, lastCheckedAt: run.lastCheckedAt, nextCheckAt: run.nextCheckAt,
      reviewPolicy: run.reviewPolicy } : null;
    return { id: roadmapId, projectId: roadmap.projectId, title: plan.graph.title,
      version: plan.version, owner, run: safeRun,
      plan: owner ? { id: plan.id, version: plan.version, graph: plan.graph, context: plan.context } : null,
      nodes: plan.graph.nodes.map((node) => {
        const task = tasks.find((t) => t.nodeKey === node.key);
        return { key: node.key, title: node.title, assigneeUserId: node.assigneeUserId,
          assigneeName: this.db.getUserById(node.assigneeUserId)?.displayName || '', dependsOn: node.dependsOn,
          completionGate: node.completionGate, status: task?.status || 'draft', blockedReason: task?.blockedReason || null,
          taskId: task?.id || null, version: task?.version || 1, dueAt: node.dueAt,
          reviewMode: run ? nodeReviewMode(node, run.reviewPolicy) : node.reviewMode || null,
          ...(owner || task?.assigneeUserId === userId ? { task: task ? this.publicTask(task) : null,
            requiredOutputs: node.outputs,
            reviewJob: task ? this.db.db.prepare(`SELECT status,error_code AS errorCode FROM workflow_jobs
              WHERE task_id=? AND task_version=? AND type='submission.review' ORDER BY created_at DESC LIMIT 1`).get(task.id, task.version) || null : null,
            submissions: task ? this.db.listSubmissionsForTask(task.id).map((s) => this.publicSubmission(s)) : [],
            reviews: task ? this.db.db.prepare('SELECT r.* FROM task_reviews r JOIN task_submissions s ON s.id=r.submission_id WHERE s.task_id=? ORDER BY r.created_at')
              .all(task.id).map((r) => ({ id: r.id, submissionId: r.submission_id, source: r.source, verdict: r.verdict,
                status: r.status, detail: JSON.parse(r.detail_json), createdAt: r.created_at })) : [] } : {}) };
      }) };
  }
  publicTask(task) { const { assignedAccessId, ...safe } = task;
    return { ...safe, ...(task.workflowRunId ? { workflowStatus: this.store.run(task.workflowRunId)?.status } : {}) }; }
  publicSubmission(submission) {
    const { projectAccessId, codexThreadId, codexTurnId, finalItemId, ...safe } = submission;
    return safe;
  }
}
