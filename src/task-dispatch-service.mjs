import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';
import { slugify } from './fs-service.mjs';
import { validateGraph, graphText } from './work-graph-contract.mjs';
import { operationKey } from './task-materials.mjs';

export class TaskDispatchService {
  constructor({ config, db, store, materials, workspace, worktrees, codex }) {
    Object.assign(this, { config, db, store, materials, workspace, worktrees, codex }); this.sql = db.db;
  }
  owner(userId, projectId, chatId = null) {
    invariant(this.config.taskDispatchEnabled, 404, 'DISPATCH_DISABLED', '任务派发尚未启用。');
    const project = this.store.owner(projectId, userId);
    if (chatId) {
      const chat = this.db.getChat(chatId);
      invariant(chat?.userId === userId && chat.projectAccessId === project.accessId && (!chat.purpose || chat.purpose === 'normal'),
        403, 'CHAT_FORBIDDEN', '只能从自己的普通项目对话派发。');
    }
    return project;
  }
  graph(body) {
    if (body.graph) return validateGraph({ ...body.graph, nodes: body.graph.nodes?.map(({ reviewMode, ...node }) => node) }, { employeeFor: id => this.db.getUserById(id) });
    const title = graphText(body.title, '任务标题', 160);
    const acceptance = graphText(body.acceptance, '验收要求');
    return validateGraph({ schemaVersion: 1, title, nodes: [{ key: 'delivery', title, acceptance,
      assigneeUserId: body.assigneeUserId, checklist: body.checklist || [acceptance], outputs: body.outputs || [],
      dependsOn: [], completionGate: true, dueAt: body.dueAt || null, inputAttachmentIds: body.attachmentIds || [] }] },
    { employeeFor: id => this.db.getUserById(id) });
  }
  request(userId, body) {
    const source = this.owner(userId, body.projectId, body.chatId);
    const key = operationKey(body.idempotencyKey);
    const graph = this.graph(body);
    const files = this.materials.validatePlan(graph, userId);
    const request = { graph, files, background: graphText(body.background || '', '任务背景', 8000, true) };
    const prior = this.sql.prepare('SELECT * FROM task_dispatches WHERE owner_id=? AND idempotency_key=?').get(userId, key);
    if (prior) {
      invariant(prior.source_project_id === source.id && prior.source_chat_id === (body.chatId || null)
        && prior.request_json === JSON.stringify(request), 409, 'IDEMPOTENCY_CONFLICT', '派发标识已用于另一个请求。');
      return this.receipt(prior.id, userId);
    }
    const id = randomUUID();
    this.store.transaction(() => {
      this.sql.prepare(`INSERT INTO task_dispatches(id,owner_id,source_project_id,source_access_id,source_chat_id,owner_epoch,request_json,idempotency_key,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, userId, source.id, source.accessId, body.chatId || null,
        this.store.policyEpoch(userId), JSON.stringify(request), key, new Date().toISOString());
      const job = this.store.enqueue({ projectId: source.id, ownerId: userId, type: 'dispatch.prepare',
        dedupeKey: `dispatch:${id}`, payload: { dispatchId: id } });
      this.sql.prepare('UPDATE task_dispatches SET job_id=? WHERE id=?').run(job.id, id);
    });
    return this.receipt(id, userId);
  }
  receipt(id, userId) {
    const row = this.sql.prepare('SELECT * FROM task_dispatches WHERE id=? AND owner_id=?').get(id, userId);
    invariant(row, 404, 'DISPATCH_NOT_FOUND', '派发记录不存在。');
    this.owner(userId, row.source_project_id, row.source_chat_id);
    const job = row.job_id && this.store.job(row.job_id);
    const run = row.run_id && this.store.run(row.run_id);
    const jobs = run ? this.sql.prepare("SELECT status,error_code AS errorCode FROM workflow_jobs WHERE workflow_run_id=? AND status='needs_attention'").all(run.id) : [];
    const request = JSON.parse(row.request_json);
    return { id: row.id, status: job?.status === 'needs_attention' || jobs.length ? 'needs_attention'
      : run && ['cancelled', 'paused'].includes(run.status) ? run.status : row.status,
    errorCode: jobs[0]?.errorCode || job?.errorCode || null, title: request.graph.title,
    projectId: row.project_id, projectName: row.project_id ? this.db.getProject(row.project_id)?.name : null,
    roadmapId: row.roadmap_id, attachmentCount: request.files.length,
    tasks: run ? this.store.tasks(run.id).map(t => ({ id: t.id, title: t.title, employee: this.db.getUserById(t.assigneeUserId)?.displayName,
      status: t.status, url: `/employee?view=tasks&task=${encodeURIComponent(t.id)}`,
      weixin: this.sql.prepare('SELECT status FROM weixin_outbox WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(t.id)?.status || (this.sql.prepare("SELECT id FROM weixin_connections WHERE user_id=? AND status='active'").get(t.assigneeUserId) ? 'queued' : 'not_bound') })) : [],
    createdAt: row.created_at };
  }
  list(userId, chatId) {
    return this.sql.prepare('SELECT id FROM task_dispatches WHERE owner_id=? AND source_chat_id=? ORDER BY created_at DESC LIMIT 30')
      .all(userId, chatId).map(r => this.receipt(r.id, userId));
  }
  prepare(job) {
    this.store.assertJob(job.id, job.leaseToken);
    let row = this.sql.prepare('SELECT * FROM task_dispatches WHERE id=?').get(job.payload.dispatchId);
    invariant(row?.owner_id === job.ownerId && row.source_project_id === job.projectId, 403, 'DISPATCH_FORBIDDEN', '派发身份不匹配。');
    const source = this.owner(row.owner_id, row.source_project_id, row.source_chat_id);
    invariant(source.accessId === row.source_access_id && this.store.policyEpoch(row.owner_id) === row.owner_epoch,
      403, 'WORKFLOW_AUTHORIZATION_CHANGED', '派发授权已变化。');
    if (row.run_id) return { dispatchId: row.id, runId: row.run_id };
    invariant(!this.codex.workspaceBusy(source.accessId), 409, 'WORKSPACE_BUSY', '等待本轮整理结束后派发。');
    const request = JSON.parse(row.request_json);
    if (!row.project_id) {
      this.materials.select(request.files.map(f => f.id), row.owner_id, { checkSource: true });
      const owner = this.db.getUserById(row.owner_id);
      invariant(this.db.listProjectsForUser(owner.id).length < owner.maxProjects, 413, 'PROJECT_QUOTA', '老板项目配额已满。');
      this.store.transaction(() => {
        const project = this.db.createProject({ userId: owner.id, name: request.graph.title, slug: slugify(request.graph.title), description: request.background });
        this.sql.prepare("UPDATE task_dispatches SET project_id=?,status='preparing' WHERE id=?").run(project.id, row.id);
      });
      row = this.sql.prepare('SELECT * FROM task_dispatches WHERE id=?').get(row.id);
    }
    const project = this.store.owner(row.project_id, row.owner_id);
    if (!fs.existsSync(this.workspace.projectRoot(project))) this.workspace.createProject(project);
    this.materials.importFiles(project, request.files);
    const brief = `# ${request.graph.title}\n\n${request.background}\n\n${request.graph.nodes.map(n => `## ${n.title}\n\n${n.acceptance}`).join('\n\n')}\n`;
    const briefPath = `inputs/dispatch-${row.id}.md`;
    try {
      invariant(this.workspace.readFile(project, briefPath).content === brief, 409, 'MATERIAL_PATH_CONFLICT', '派发说明已有不同内容。');
    } catch (error) { if (error.code !== 'PATH_NOT_FOUND') throw error; this.workspace.writeFile(project, briefPath, brief); }
    this.store.transaction(() => {
      const plan = this.store.savePlan({ projectId: project.id, ownerId: row.owner_id, graph: request.graph,
        context: { candidateIds: [...new Set(request.graph.nodes.map(n => n.assigneeUserId))], materialIds: request.files.map(f => f.id) } });
      const run = this.store.start({ roadmapId: plan.roadmapId, ownerId: row.owner_id, expectedVersion: plan.version,
        policy: { mode: 'manual' }, idempotencyKey: row.id });
      this.sql.prepare('UPDATE task_dispatches SET roadmap_id=?,run_id=? WHERE id=?').run(plan.roadmapId, run.id, row.id);
    });
    return { dispatchId: row.id };
  }
  graphEvent(event) {
    if (event.type === 'workflow.running') {
      for (const task of this.store.tasks(event.runId)) this.materials.notify(task, 'assigned');
      const row = this.sql.prepare('SELECT * FROM task_dispatches WHERE run_id=?').get(event.runId);
      if (row && row.status !== 'published') {
        this.sql.prepare("UPDATE task_dispatches SET status='published' WHERE id=?").run(row.id);
        if (row.source_chat_id && this.db.getChat(row.source_chat_id)) this.db.addMessage({ id: `dispatch:${row.id}`, chatId: row.source_chat_id,
          role: 'assistant', kind: 'dispatch_receipt', content: `任务已发布：${JSON.parse(row.request_json).graph.title}。员工可在任务面板查看资料并处理。`,
          metadata: { dispatchId: row.id } });
      }
    }
    if (event.type === 'task.dispatched') {
      const task = this.db.getTask(event.taskId);
      const node = this.store.plan(this.store.run(task.workflowRunId).planId).graph.nodes.find(n => n.key === task.nodeKey);
      if (node.dependsOn.length) this.materials.notify(task, 'ready');
    }
  }
}
