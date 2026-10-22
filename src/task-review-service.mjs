import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';
import { graphText, nodeReviewMode } from './work-graph-contract.mjs';

export class TaskReviewService {
  constructor({ db, store, workspace, worktrees, codex, graphs }) { Object.assign(this, { db, store, workspace, worktrees, codex, graphs }); }

  context(submissionId, ownerId) {
    const submission = this.db.getSubmission(submissionId);
    invariant(submission, 404, 'SUBMISSION_NOT_FOUND', '提交不存在。');
    const task = this.db.getTask(submission.taskId);
    invariant(task, 404, 'TASK_NOT_FOUND', '任务不存在。');
    const project = this.store.owner(task.projectId, ownerId);
    invariant(submission.verdict === 'pending' && task.status === 'submitted' && task.version === submission.taskVersion,
      409, 'SUBMISSION_NOT_PENDING', '提交已审核或任务版本已变化。');
    if (task.workflowRunId) this.graphs.member(task, this.store.assertRun(task.workflowRunId));
    return { submission, task, project };
  }

  proposal({ submissionId, ownerId, source = 'human', verdict, detail = {}, dedupeKey }) {
    invariant(['human', 'ai'].includes(source) && ['passed', 'rework', 'needs_human'].includes(verdict),
      400, 'INVALID_VERDICT', '审核结果无效。');
    const { task, submission } = this.context(submissionId, ownerId);
    const feedback = graphText(detail.feedback || '', '审核意见', 8000, verdict === 'passed');
    const items = detail.items || (source === 'human' ? task.checklist.map((i) => ({ id: i.id,
      status: verdict === 'passed' ? 'passed' : 'failed', comment: feedback, evidence: [] })) : []);
    invariant(Array.isArray(items) && items.length === task.checklist.length
      && new Set(items.map((i) => i?.id)).size === items.length, 400, 'REVIEW_CHECKLIST_REQUIRED', '审核须覆盖本轮全部清单项。');
    const upstream = task.workflowRunId ? this.graphs.reviewInputs(task) : [];
    const materialRow = this.db.db.prepare('SELECT manifest_json FROM task_submission_inputs WHERE submission_id=?').get(submissionId);
    const materialInputs = materialRow ? JSON.parse(materialRow.manifest_json) : [];
    const references = new Set([...materialInputs.map(f => `input:${f.id}`), 'result_summary', 'final_reply', ...submission.outputsManifest.map((f) => f.path),
      ...upstream.flatMap(input => input.outputs.map(output => output.evidenceRef))]);
    const criteria = task.checklist.map((item) => {
      const result = items.find((i) => i?.id === item.id);
      invariant(result && ['passed', 'failed', 'unknown'].includes(result.status), 400, 'INVALID_REVIEW_ITEM', '清单审核结果无效。');
      const evidence = result.evidence || [];
      invariant(Array.isArray(evidence) && evidence.length <= 30 && evidence.every((ref) => references.has(ref)),
        400, 'INVALID_REVIEW_EVIDENCE', '审核引用须来自本次提交或获准的固定上游成果。');
      invariant(source !== 'ai' || result.status !== 'passed' || evidence.length > 0,
        400, 'REVIEW_EVIDENCE_REQUIRED', '自动审核的通过项必须引用具体成果。');
      return { id: item.id, status: result.status, comment: graphText(result.comment || '', '逐项意见', 2000, true), evidence };
    });
    invariant(verdict !== 'passed' || criteria.every((i) => i.status === 'passed'), 400, 'REVIEW_NOT_PASSED', '清单存在未通过项。');
    invariant(source !== 'ai' || verdict !== 'passed' || !submission.outputsManifest.length
      || criteria.some(i => i.evidence.some(ref => submission.outputsManifest.some(f => f.path === ref))),
      400, 'REVIEW_FILE_EVIDENCE_REQUIRED', '有附件的通过意见必须引用实际文件，不能只引用成果说明。');
    const key = dedupeKey || `human:${submissionId}:${randomUUID()}`;
    const prior = this.db.db.prepare('SELECT id FROM task_reviews WHERE dedupe_key=?').get(key);
    if (prior) return this.get(prior.id);
    const id = randomUUID();
    this.db.db.prepare(`INSERT INTO task_reviews(id,submission_id,task_version,actor_user_id,source,verdict,detail_json,dedupe_key,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, submissionId, task.version, ownerId, source, verdict,
      JSON.stringify({ feedback, items: criteria }), key, new Date().toISOString());
    return this.get(id);
  }

  get(id) {
    const row = this.db.db.prepare('SELECT * FROM task_reviews WHERE id=?').get(id);
    return row ? { id: row.id, submissionId: row.submission_id, taskVersion: row.task_version, actorId: row.actor_user_id,
      source: row.source, verdict: row.verdict, detail: JSON.parse(row.detail_json), status: row.status } : null;
  }

  apply(reviewId, { ownerId, job = null } = {}) {
    const review = this.get(reviewId);
    invariant(review && review.actorId === ownerId, 403, 'REVIEW_FORBIDDEN', '无权应用验收意见。');
    if (review.status === 'applied') {
      const submission = this.db.getSubmission(review.submissionId);
      this.store.owner(this.db.getTask(submission.taskId).projectId, ownerId);
      return submission;
    }
    invariant(review.status === 'suggested' && review.verdict !== 'needs_human', 409, 'REVIEW_NEEDS_OWNER', '请老板补充审核结论。');
    if (job) this.store.assertJob(job.id, job.leaseToken);
    const { task, submission, project } = this.context(review.submissionId, ownerId);
    invariant(task.workflowRunId, 409, 'WORKFLOW_REQUIRED', '此审核入口仅用于工作图。');
    const run = this.store.assertRun(task.workflowRunId, job?.generation ?? null);
    if (job) {
      invariant(job.runId === run.id && job.submissionId === submission.id && job.taskVersion === task.version,
        409, 'REVIEW_JOB_CHANGED', '审核任务关联已变化。');
      const mode = nodeReviewMode(this.graphs.node(task), run.reviewPolicy);
      invariant(mode === 'auto', 403, 'AUTO_REVIEW_NOT_AUTHORIZED', '该节点未授权自动审核。');
      invariant(submission.outputsManifest.every(output => review.detail.coverage?.some(f => !f.evidenceRef && f.path === output.path && f.complete)),
        409, 'REVIEW_NEEDS_OWNER', '交付文件未完整读取，请老板核对。');
      const materialRow = this.db.db.prepare('SELECT manifest_json FROM task_submission_inputs WHERE submission_id=?').get(submission.id);
      invariant((materialRow ? JSON.parse(materialRow.manifest_json) : []).every(f => review.detail.coverage?.some(c => c.evidenceRef === `input:${f.id}` && c.complete)), 409, 'REVIEW_NEEDS_OWNER', '本次采用的输入资料尚未完整读取，请老板核对。');
      const references = new Set(review.detail.items.flatMap(item => item.evidence));
      invariant(this.graphs.reviewInputs(task).every(input => input.outputs.every(output => !references.has(output.evidenceRef)
        || review.detail.coverage?.some(f => f.evidenceRef === output.evidenceRef && f.complete))),
      409, 'REVIEW_NEEDS_OWNER', '固定上游文件未完整读取，请老板核对。');
      invariant(!this.graphs.node(task).requiresIndependentValidation, 409, 'INDEPENDENT_VALIDATION_REQUIRED', '此任务需要老板核对独立验证结果。');
      invariant(review.verdict !== 'passed' || !task.foreignWorkSeen, 409, 'DELIVERY_SCOPE_REVIEW_REQUIRED', '期间存在无关工作，请老板核对交付范围。');
      invariant(review.verdict !== 'rework' || task.version <= run.reviewPolicy.maxRework,
        409, 'REWORK_LIMIT_REACHED', '已达到自动返工上限，请老板处理。');
    }
    let delivery = null;
    if (review.verdict === 'passed') {
      this.graphs.idle(project.accessId); this.graphs.idle(submission.projectAccessId);
      const access = this.db.getProjectAccessById(submission.projectAccessId);
      invariant(access?.status === 'active' && access.userId === task.assigneeUserId && access.projectId === project.id,
        403, 'SUBMISSION_ACCESS_REVOKED', '交付绑定的原授权已失效。');
      delivery = this.worktrees.deliverSubmission({ projectRoot: this.workspace.projectRoot(project), treePath: access.treePath,
        snapshotCommitSha: submission.snapshotCommitSha, snapshotTreeSha: submission.snapshotTreeSha,
        taskId: task.id, taskVersion: task.version });
    }
    return this.store.transaction(() => {
      if (job) this.store.assertJob(job.id, job.leaseToken);
      this.context(submission.id, ownerId);
      const date = new Date().toISOString();
      const changed = this.db.db.prepare(`UPDATE task_submissions SET verdict=?,reviewed_at=?,delivery_commit_sha=?,delivered_at=?
        WHERE id=? AND verdict='pending' AND task_version=?`).run(review.verdict, date, delivery?.deliveryCommitSha || null,
        delivery ? date : null, submission.id, task.version);
      invariant(changed.changes === 1, 409, 'SUBMISSION_NOT_PENDING', '该提交已经审核。');
      if (review.verdict === 'rework') {
        const checklist = task.checklist.map((item) => ({ ...item, done: review.detail.items.find((r) => r.id === item.id)?.status === 'passed' }));
        this.db.db.prepare(`UPDATE tasks SET status='rework',version=version+1,checklist_json=?,checklist_revision=checklist_revision+1,
          blocked_reason=NULL,updated_at=? WHERE id=? AND version=?`).run(JSON.stringify(checklist), date, task.id, task.version);
      } else {
        this.db.db.prepare("UPDATE tasks SET status='passed',blocked_reason=NULL,updated_at=? WHERE id=? AND version=?").run(date, task.id, task.version);
        this.db.db.prepare(`INSERT INTO task_handoffs(id,task_id,task_version,submission_id,delivery_commit_sha,manifest_json,created_at)
          VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.id, task.version, submission.id, delivery.deliveryCommitSha,
          JSON.stringify({ summary: (submission.resultSummary || submission.finalReplySnapshot).slice(0, 8000),
            outputs: submission.outputsManifest, limitations: submission.employeeNote }), date);
        this.db.touchProject(project.id);
      }
      this.db.db.prepare("UPDATE task_reviews SET status='superseded' WHERE submission_id=? AND status='suggested' AND id<>?").run(submission.id, review.id);
      this.db.db.prepare("UPDATE task_reviews SET status='applied',applied_at=? WHERE id=?").run(date, review.id);
      this.store.event({ projectId: project.id, runId: run.id, taskId: task.id, recipientId: task.assigneeUserId,
        type: `task.${review.verdict}`, payload: { submissionId: submission.id, reviewId: review.id,
          version: task.version + (review.verdict === 'rework' ? 1 : 0) } });
      this.store.enqueue({ projectId: project.id, ownerId, runId: run.id, generation: run.generation,
        type: 'workflow.reconcile', dedupeKey: `applied:${submission.id}:${run.generation}` });
      return this.db.getSubmission(submission.id);
    });
  }

  legacy({ submissionId, ownerId, verdict }) {
    invariant(['passed', 'rework'].includes(verdict), 400, 'INVALID_VERDICT', '审核结果必须是 passed 或 rework。');
    const { task, submission, project } = this.context(submissionId, ownerId);
    invariant(!task.workflowRunId, 409, 'WORKFLOW_REVIEW_REQUIRED', '工作图使用结构化审核。');
    let delivery = null;
    if (verdict === 'passed') {
      const access = this.db.getProjectAccessById(submission.projectAccessId);
      invariant(access?.status === 'active' && access.accessKind === 'shared'
        && access.projectId === project.id && access.userId === submission.submitterUserId,
      409, 'SUBMISSION_ACCESS_REVOKED', '提交绑定的原项目授权已失效，不能交付。');
      const next = task.roadmapId ? this.db.getRoadmap(task.roadmapId)?.steps.find((t) => t.position > task.position && t.status === 'ready') : null;
      invariant(!next || this.db.getProjectForUser(next.projectId, next.assigneeUserId), 409, 'NEXT_ASSIGNEE_ACCESS_REVOKED', '下一员工授权已失效。');
      this.graphs.idle(project.accessId); this.graphs.idle(access.id);
      delivery = this.worktrees.deliverSubmission({ projectRoot: this.workspace.projectRoot(project), treePath: access.treePath,
        snapshotCommitSha: submission.snapshotCommitSha, snapshotTreeSha: submission.snapshotTreeSha,
        taskId: task.id, taskVersion: task.version });
    }
    const result = this.db.reviewSubmission({ submissionId, verdict, deliveryCommitSha: delivery?.deliveryCommitSha || null });
    if (delivery) this.db.touchProject(project.id);
    return { submission: result, task: this.db.getTask(task.id), delivery };
  }
}
