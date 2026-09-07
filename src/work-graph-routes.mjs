import { invariant } from './errors.mjs';
import { readJson, sendJson, sseHeaders, sse } from './http-utils.mjs';

export function createWorkGraphRoutes({ db, store, graphs, reviews, runtime, scheduler, shares, codex, config,
  requireMutation, refreshSession, projectFor, requireAdmin, audit }) {
  return async function route(req, res, url, originalSession) {
    const pathname = url.pathname;
    let session = originalSession;
    const reply = (status, body) => sendJson(res, status, body, config);
    const bodyFor = async () => {
      requireMutation(req, session);
      const body = await readJson(req, 256 * 1024);
      session = refreshSession(session);
      return body;
    };
    let match = pathname.match(/^\/api\/admin\/users\/([^/]+)\/profile$/);
    if (match && ['GET', 'PATCH'].includes(req.method)) {
      requireAdmin(session);
      if (req.method === 'GET') reply(200, { profile: store.profile(match[1]) });
      else {
        const body = await bodyFor(); requireAdmin(session);
        const profile = store.updateProfile(match[1], session.user.id, body, body.revision);
        audit(req, session, 'employee.profile_updated', 'user', match[1], { revision: profile.revision });
        reply(200, { profile });
      }
      return true;
    }
    match = pathname.match(/^\/api\/projects\/([^/]+)\/work-graphs(?:\/(generate|candidates))?$/);
    if (match) {
      if (req.method === 'POST') invariant(config.workGraphEnabled, 503, 'WORK_GRAPH_DISABLED', '工作图创建已由运维关闭。');
      projectFor(session, match[1]);
      if (req.method === 'GET' && match[2] === 'candidates') {
        store.owner(match[1], session.user.id);
        reply(200, { employees: db.listUsers().filter((u) => u.role === 'user' && u.status === 'active')
          .map((u) => ({ id: u.id, displayName: u.displayName, profile: store.profile(u.id) })) });
      } else if (req.method === 'GET' && !match[2]) {
        reply(200, { graphs: db.listRoadmaps(match[1]).filter((r) => r.kind === 'dag').map((r) => graphs.view(r.id, session.user.id)) });
      } else if (req.method === 'POST' && match[2] === 'generate') {
        const body = await bodyFor();
        const job = runtime.generate(match[1], session.user.id, body);
        scheduler.wake(); reply(202, { job: publicJob(job) });
      } else if (req.method === 'POST' && !match[2]) {
        const body = await bodyFor();
        const plan = store.savePlan({ projectId: match[1], ownerId: session.user.id, graph: body.graph });
        reply(201, { graph: graphs.view(plan.roadmapId, session.user.id) });
      } else return false;
      return true;
    }
    match = pathname.match(/^\/api\/work-graph-jobs\/([^/]+)(?:\/(retry))?$/);
    if (match && ['GET', 'POST'].includes(req.method)) {
      let job = store.job(match[1]);
      invariant(job, 404, 'WORKFLOW_JOB_NOT_FOUND', '后台任务不存在。');
      store.owner(job.projectId, session.user.id);
      if (req.method === 'POST' && match[2] === 'retry') {
        const body = await bodyFor(); job = store.job(match[1]); store.owner(job.projectId, session.user.id);
        invariant(job.status === 'needs_attention', 409, 'WORKFLOW_JOB_CHANGED', '仅可重试需要处理的后台任务。');
        if (job.runId) store.assertRun(job.runId, job.generation);
        invariant(!job.turnRunId || body.acknowledgeUncertain === true, 409, 'MODEL_DELIVERY_UNCERTAIN', '请先核对后台对话并确认再次调用。');
        const payload = { ...job.payload, ownerEpoch: store.policyEpoch(session.user.id) };
        store.sql.prepare(`UPDATE workflow_jobs SET status='queued',attempt=0,turn_run_id=NULL,result_json=NULL,payload_json=?,due_at=?,error_code=NULL WHERE id=?`)
          .run(JSON.stringify(payload), Date.now(), job.id);
        job = store.job(job.id); scheduler.wake();
      } else if (req.method !== 'GET') return false;
      reply(200, { job: publicJob(job) }); return true;
    }
    match = pathname.match(/^\/api\/work-graphs\/([^/]+)(?:\/(plan|start|pause|resume|cancel))?$/);
    if (match) {
      const id = match[1]; const action = match[2];
      const view = graphs.view(id, session.user.id);
      if (req.method === 'GET') {
        reply(200, action === 'plan' ? { plan: view.plan } : { graph: view,
          jobs: view.owner && view.run ? store.sql.prepare('SELECT id FROM workflow_jobs WHERE workflow_run_id=? ORDER BY created_at DESC LIMIT 100')
            .all(view.run.id).map((r) => publicJob(store.job(r.id))) : [] });
      } else if (req.method === 'PATCH' && action === 'plan') {
        const body = await bodyFor();
        const prior = store.latestPlan(id);
        store.savePlan({ projectId: view.projectId, ownerId: session.user.id, roadmapId: id,
          graph: body.graph, context: prior.context, expectedVersion: body.expectedVersion });
        reply(200, { graph: graphs.view(id, session.user.id) });
      } else if (req.method === 'POST' && action === 'start') {
        const body = await bodyFor();
        const run = store.start({ roadmapId: id, ownerId: session.user.id, expectedVersion: body.expectedVersion,
          policy: body.reviewPolicy, idempotencyKey: body.idempotencyKey });
        scheduler.wake(); reply(202, { runId: run.id, graph: graphs.view(id, session.user.id) });
      } else if (req.method === 'POST' && ['pause', 'resume', 'cancel'].includes(action)) {
        const body = await bodyFor();
        const current = db.getRoadmap(id);
        const run = store.changeState(current.currentWorkflowId, session.user.id, body.expectedRevision, action);
        if (action !== 'resume') {
          const taskIds = new Set(store.tasks(run.id).map((t) => t.id));
          const chats = db.listChats({ projectId: view.projectId }).filter((c) => taskIds.has(c.taskId)
            || (c.workflowJobId && store.job(c.workflowJobId)?.runId === run.id));
          await Promise.all(chats.map((c) => codex.interruptAndWait(c.id)));
          session = refreshSession(session);
        }
        if (action === 'cancel') shares.cleanupCancelled(run.id);
        scheduler.wake(); reply(200, { graph: graphs.view(id, session.user.id) });
      } else return false;
      return true;
    }
    match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(checklist|handoffs|submissions))?$/);
    if (match && db.getTask(match[1])?.workflowRunId) {
      const task = db.getTask(match[1]);
      invariant(db.getTaskForUser(task.id, session.user.id), 403, 'TASK_FORBIDDEN', '任务不存在或不属于你。');
      if (req.method === 'GET' && !match[2]) {
        reply(200, { task: graphs.publicTask(task), submissions: db.listSubmissionsForTask(task.id).map((s) => graphs.publicSubmission(s)),
          handoffs: graphs.handoffs(task.id, session.user.id) });
      } else if (req.method === 'GET' && match[2] === 'handoffs') reply(200, { handoffs: graphs.handoffs(task.id, session.user.id) });
      else if (req.method === 'PATCH' && match[2] === 'checklist') {
        const body = await bodyFor(); reply(200, { task: graphs.publicTask(graphs.updateChecklist(task.id, session.user.id, body)) });
      } else if (req.method === 'POST' && match[2] === 'submissions') {
        const body = await bodyFor(); const submission = graphs.submit(task.id, session.user.id, body);
        scheduler.wake(); reply(201, { submission: graphs.publicSubmission(submission), task: graphs.publicTask(db.getTask(task.id)) });
      } else return false;
      return true;
    }
    match = pathname.match(/^\/api\/task-submissions\/([^/]+)\/artifact$/);
    if (match && req.method === 'GET') {
      const file = graphs.artifact(match[1], session.user.id, url.searchParams.get('path'));
      if (url.searchParams.get('download') === '1') {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
          'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.path.split('/').at(-1)),
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
        res.end(file.bytes);
      } else reply(200, { file: { path: file.path, size: file.size, sha256: file.sha256,
        readable: file.readable, content: file.readable && file.size <= 256 * 1024 ? file.content : null } });
      return true;
    }
    match = pathname.match(/^\/api\/admin\/task-submissions\/([^/]+)\/review$/);
    if (match && req.method === 'POST' && db.getTask(db.getSubmission(match[1])?.taskId || '')?.workflowRunId) {
      requireAdmin(session); const body = await bodyFor(); requireAdmin(session);
      const context = reviews.context(match[1], session.user.id);
      invariant(body.expectedVersion === context.task.version, 409, 'TASK_VERSION_CHANGED', '审核版本已变化。');
      const proposal = reviews.proposal({ submissionId: match[1], ownerId: session.user.id, verdict: body.verdict,
        detail: { feedback: body.feedback || '', items: body.items } });
      const submission = reviews.apply(proposal.id, { ownerId: session.user.id });
      scheduler.wake(); reply(200, { submission: graphs.publicSubmission(submission), task: graphs.publicTask(db.getTask(submission.taskId)) });
      return true;
    }
    match = pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
    if (match && req.method === 'GET') {
      const project = projectFor(session, match[1]);
      const expectedAccess = project.accessId;
      const parsed = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      let cursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
      if (url.searchParams.get('format') === 'json') { reply(200, { events: store.events(project.id, session.user.id, cursor) }); return true; }
      sseHeaders(res, config);
      let timer; let polls = 0;
      const poll = () => {
        try {
          session = refreshSession(session);
          invariant(projectFor(session, project.id).accessId === expectedAccess, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已失效。');
          if (++polls % 15 === 0) res.write(': keepalive\n\n');
          let batch;
          do {
            batch = store.events(project.id, session.user.id, cursor);
            for (const event of batch) { sse(res, 'project_event', { ...event, eventId: event.id }); cursor = event.id; }
          } while (batch.length === 500 && !res.destroyed);
        } catch { clearInterval(timer); res.end(); }
      };
      timer = setInterval(poll, 1000); timer.unref?.();
      res.on('close', () => clearInterval(timer));
      poll(); return true;
    }
    return false;
  };
}

function publicJob(job) {
  return { id: job.id, type: job.type, status: job.status, dueAt: job.dueAt, attempt: job.attempt,
    errorCode: job.errorCode, result: job.result ? Object.fromEntries(['planId', 'roadmapId', 'version', 'runId', 'reviewId'].filter(key => job.result[key] !== undefined).map(key => [key, job.result[key]])) : null, taskId: job.taskId, createdAt: job.createdAt };
}
