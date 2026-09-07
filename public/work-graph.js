const $ = (selector, root = document) => root.querySelector(selector);
const all = (selector, root = document) => [...root.querySelectorAll(selector)];
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[c]);
const labels = { draft: '草稿', preparing: '准备共享', ready: '等待前序', running: '推进中', active: '进行中',
  submitted: '待验收', passed: '已通过', rework: '需返工', paused: '已暂停', cancelled: '已取消', superseded: '已修订',
  queued: '排队中', leased: '处理中', retry_wait: '等待重试', succeeded: '已完成', needs_attention: '需要处理' };
const reasons = { PREPARING: '正在准备成员共享', WAITING_DEPENDENCIES: '等待前序验收', WAITING_EMPLOYEE: '等待员工完成当前任务',
  WORKSPACE_BUSY: '等待工作区空闲', WAITING_REVIEW: '等待验收', WAITING_OWNER_REVIEW: '等待老板决定',
  INPUT_WORKTREE_DIRTY: '有未提交工作，请先处理', INPUT_BASE_DIVERGED: '输入基线分叉，请处理冲突',
  PROJECT_ACCESS_REVOKED: '项目授权已撤销', MEMBER_POLICY_CHANGED: '员工策略变化，请老板处理',
  CODEX_NOT_READY: '等待 Codex 服务', MODEL_DELIVERY_UNCERTAIN: '上次调用结果不确定，请核对后台对话',
  DELIVERY_MERGE_CONFLICT: '成果合并冲突，请处理', WORKFLOW_AUTHORIZATION_CHANGED: '账号策略变化，请恢复授权',
  INDEPENDENT_VALIDATION_REQUIRED: '需要独立验证，请老板验收', REWORK_LIMIT_REACHED: '已到自动返工上限',
  DELIVERY_SCOPE_REVIEW_REQUIRED: '存在无关工作，请核对交付范围', MODEL_BUDGET_EXCEEDED: '已到模型调用预算' };
const reason = (code) => reasons[code] || (code ? '等待处理，请查看后台任务' : '');
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export function graphLayout(nodes) {
  const levels = new Map();
  for (let pass = 0; pass < nodes.length; pass += 1) {
    for (const node of nodes) if (!levels.has(node.key) && node.dependsOn.every((key) => levels.has(key))) {
      levels.set(node.key, node.dependsOn.length ? Math.max(...node.dependsOn.map((key) => levels.get(key))) + 1 : 0);
    }
  }
  const rows = new Map();
  const positions = new Map(nodes.map((node) => {
    const depth = levels.get(node.key) || 0; const row = rows.get(depth) || 0; rows.set(depth, row + 1);
    return [node.key, { x: 24 + depth * 320, y: 24 + row * 168 }];
  }));
  return { positions, width: Math.max(340, (Math.max(0, ...levels.values()) + 1) * 320),
    height: Math.max(220, Math.max(1, ...rows.values()) * 168 + 48) };
}

export class WorkGraphUI {
  constructor({ api, toast, openTask, openFile, refreshTasks }) {
    Object.assign(this, { api, toast, openTaskChat: openTask, openFile, refreshTasks });
    this.zoom = 1; this.graphs = []; this.mode = globalThis.matchMedia?.('(max-width: 760px)').matches ? 'list' : 'graph'; this.events = []; this.jobs = [];
  }
  async initialize(user, projects) {
    this.user = user; this.projects = projects; this.owner = user.role === 'admin';
    this.panel = $('#work-graph-panel'); this.drawer = $('#work-graph-drawer');
    if (!this.panel || this.initialized) return;
    this.initialized = true;
    this.drawer.addEventListener('click', (event) => this.drawerAction(event).catch((e) => this.toast(e.message, 'error')));
    this.panel.addEventListener('click', (event) => this.action(event).catch((e) => this.toast(e.message, 'error')));
    this.panel.addEventListener('change', (event) => {
      if (event.target.id === 'graph-project') this.selectProject(event.target.value).catch((e) => this.toast(e.message, 'error'));
      if (event.target.id === 'graph-select') { this.graphId = event.target.value; this.refresh().catch((e) => this.toast(e.message, 'error')); }
    });
    if (!this.owner) {
      this.poller = setInterval(() => { if (document.visibilityState === 'visible') this.refreshTasks().catch(() => {}); }, 5000);
      return;
    }
    $('.employee-hero h1').textContent = '项目推进';
    $('.employee-hero .eyebrow').textContent = 'TEAM WORK GRAPH';
    $('.employee-hero p:last-child').textContent = '从项目资料与团队能力生成计划，让交付、验收与下一步持续推进。';
    const captions = ['进行中', '待验收', '返工 / 阻塞', '已通过'];
    all('.employee-summary > div > span').forEach((node, index) => { node.textContent = captions[index]; });
    $('#task-list').classList.add('hidden'); $('.task-section-title').classList.add('hidden');
    this.panel.classList.remove('hidden');
    this.panel.innerHTML = `<div class="graph-project-row"><label>项目<select id="graph-project">${projects.filter((p) => p.accessKind === 'owner')
      .map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}</select></label><span>每个项目一张活动工作图 · 员工独立交付</span></div>
      <form id="graph-generate-form" class="graph-generate"><label class="graph-goal">这次想完成什么？<textarea name="prompt" rows="2" maxlength="8000" required placeholder="例如：请团队完成新版产品方案，设计和实现并行，最后汇总验收"></textarea></label>
      <div class="graph-options"><label>审核方式<select name="reviewMode"><option value="assisted">AI 建议，老板验收</option><option value="auto">自动验收与返工</option><option value="manual">老板人工验收</option></select></label>
      <label>最终交付<select name="finalMode"><option value="same">跟随审核方式</option><option value="manual">老板最终验收</option></select></label>
      <button class="secondary" type="submit" data-preview="true">生成预览</button><button class="primary" type="submit">EXECUTE · 生成并启动</button></div>
      <details class="graph-sources"><summary>参与员工与项目资料</summary><div id="graph-candidates" class="graph-candidates"></div>
      <label>使用的项目文件（每行一个；留空自动选取文本资料）<textarea name="paths" rows="2" placeholder="README.md"></textarea></label>
      <small>启动将向参与员工分享项目文件，并按所选方式持续验收。规划对话不会复制给员工。</small></details></form>
      <div id="graph-generation-status" role="status"></div><div class="graph-toolbar"><div><p class="eyebrow">WORK GRAPH</p><select id="graph-select" aria-label="选择工作图"></select></div>
      <div class="graph-view-actions"><button class="secondary" data-view-mode="graph">依赖图</button><button class="secondary" data-view-mode="list">状态列表</button><button class="secondary" data-view-mode="events">事件记录</button><button class="secondary" data-zoom="-1" aria-label="缩小依赖图">−</button><button class="secondary" data-zoom="1" aria-label="放大依赖图">＋</button><button class="secondary" data-refresh-graph>刷新</button></div></div>
      <div id="graph-run-bar"></div><div id="graph-board"></div><div id="graph-job-list"></div>`;
    $('#graph-generate-form').addEventListener('submit', (event) => { event.preventDefault(); this.generate(event).catch((e) => this.toast(e.message, 'error')); });
    await this.selectProject($('#graph-project').value);
  }
  async updateProjects(projects) {
    if (!this.initialized || !this.owner) return;
    this.projects = projects;
    const owned = projects.filter(p => p.accessKind === 'owner');
    $('#graph-project').innerHTML = owned.map(p => `<option value="${escape(p.id)}" ${p.id === this.projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('');
    if (!owned.some(p => p.id === this.projectId)) await this.selectProject(owned[0]?.id || '');
  }
  async selectProject(id) {
    this.source?.close(); clearInterval(this.poller); this.projectId = id; this.graphId = null; this.events = []; this.generationJob = null;
    if (!id) { $('#graph-board').textContent = '先在驾驶舱或工作台创建项目。'; return; }
    const data = await this.api(`/api/projects/${id}/work-graphs/candidates`);
    if (id !== this.projectId) return;
    this.candidates = data.employees;
    $('#graph-candidates').innerHTML = data.employees.map((u) => `<label><input type="checkbox" name="candidate" value="${escape(u.id)}" ${u.profile.availability === 'unavailable' ? 'disabled' : 'checked'}> ${escape(u.displayName)} <small>${escape(u.profile.jobTitle || '未设置岗位')}</small></label>`).join('') || '请先在驾驶舱创建员工。';
    const pending = localStorage.getItem(`work-graph-job:${id}`); if (pending) this.generationJobId = pending;
    else this.generationJobId = null;
    await this.refresh();
    this.subscribe(id);
    this.poller = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh().catch(() => {});
    }, 5000);
  }
  subscribe(id) {
    const cursorKey = `work-graph-cursor:${this.user.id}:${id}`;
    this.source = new EventSource(`/api/projects/${id}/events?after=${Number(sessionStorage.getItem(cursorKey)) || 0}`);
    this.source.addEventListener('project_event', (event) => {
      const data = JSON.parse(event.data); sessionStorage.setItem(cursorKey, String(data.id));
      this.events.push(data); this.events = this.events.slice(-100);
      clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh().catch(() => {}), 150);
    });
  }
  async refresh() {
    if (!this.owner || !this.projectId || this.refreshing) return;
    this.refreshing = true;
    try {
      const projectId = this.projectId;
      const data = await this.api(`/api/projects/${projectId}/work-graphs`);
      if (projectId !== this.projectId) return;
      this.graphs = data.graphs;
      if (!this.graphs.some((g) => g.id === this.graphId)) this.graphId = this.graphs[0]?.id || null;
      if (this.graphId) {
        const selectedId = this.graphId;
        const detail = await this.api(`/api/work-graphs/${selectedId}`);
        if (projectId !== this.projectId || selectedId !== this.graphId) return;
        this.jobs = detail.jobs;
        this.current = detail.graph;
      } else { this.current = null; this.jobs = []; }
      $('#graph-select').innerHTML = this.graphs.map((g) => `<option value="${escape(g.id)}" ${g.id === this.graphId ? 'selected' : ''}>${escape(g.title)} · V${g.version}</option>`).join('');
      if (this.generationJobId) {
        const { job } = await this.api(`/api/work-graph-jobs/${this.generationJobId}`);
        this.generationJob = job;
        $('#graph-generation-status').textContent = `计划生成：${labels[job.status] || job.status}${job.errorCode ? ` · ${reason(job.errorCode)}` : ''}`;
        if (job.status === 'succeeded') { localStorage.removeItem(`work-graph-job:${projectId}`); this.generationJobId = null; }
        if (job.status === 'needs_attention' && !this.jobs.some((j) => j.id === job.id)) this.jobs.unshift(job);
      }
      this.render();
    } finally { this.refreshing = false; }
  }
  render() {
    const graph = this.current; const nodes = graph?.nodes || [];
    const counts = [nodes.filter((n) => n.status === 'active').length, nodes.filter((n) => n.status === 'submitted').length,
      nodes.filter((n) => n.status === 'rework' || (n.blockedReason && !['WAITING_DEPENDENCIES', 'WAITING_EMPLOYEE', 'WAITING_REVIEW'].includes(n.blockedReason))).length,
      `${nodes.filter((n) => n.status === 'passed').length} / ${nodes.length}`];
    ['task-active-count', 'task-submitted-count', 'task-passed-count', 'visible-project-count'].forEach((id, index) => { $(`#${id}`).textContent = counts[index]; });
    const run = graph?.run; const canEdit = !run || ['passed', 'cancelled', 'superseded'].includes(run.status);
    $('#graph-run-bar').innerHTML = graph ? `<span class="status-tag ${escape(run?.status || 'draft')}">${labels[run?.status || 'draft']}</span>
      <span>最近检查 ${date(run?.lastCheckedAt)} · 下次 ${date(run?.nextCheckAt)}</span>
      ${canEdit ? '<button class="secondary" data-edit-plan>编辑计划</button><button class="primary" data-start-graph>启动此版本</button>'
        : `<button class="secondary" data-control="${run.status === 'paused' ? 'resume' : 'pause'}">${run.status === 'paused' ? '恢复推进' : '暂停'}</button><button class="secondary danger" data-control="cancel">取消运行</button>`}` : '';
    const board = $('#graph-board');
    if (!graph) { board.className = 'graph-empty'; board.textContent = '输入项目目标，生成团队的第一张工作图。'; }
    else if (this.mode === 'events') {
      board.className = 'graph-events';
      board.innerHTML = this.events.slice().reverse().map((e) => `<article><time>${date(e.createdAt)}</time><b>${escape(e.type)}</b><span>${escape(reason(e.payload.reason) || labels[e.payload.status] || '')}</span></article>`).join('') || '等待项目事件。';
    } else {
      const related = new Set([this.selectedKey, ...(nodes.find(n => n.key === this.selectedKey)?.dependsOn || []), ...nodes.filter(n => n.dependsOn.includes(this.selectedKey)).map(n => n.key)]);
      const layout = graphLayout(nodes); board.className = this.mode === 'list' ? 'graph-list' : 'graph-scroll';
      const card = (node, positioned) => {
        const p = layout.positions.get(node.key);
        return `<button class="graph-node status-${escape(node.status)} ${related.has(node.key) ? 'graph-related' : ''}" data-node="${escape(node.key)}" >
          <span class="graph-node-heading"><span>${escape(node.assigneeName)}</span><span>V${node.version}</span></span><strong>${escape(node.title)}</strong>
          <span class="graph-node-status">${labels[node.status]}${node.completionGate ? ' · 最终交付' : ''}</span><small>${escape(reason(node.blockedReason)) || `截止 ${date(node.dueAt)}`}</small></button>`;
      };
      if (this.mode === 'list') board.innerHTML = nodes.map((n) => card(n, false)).join('');
      else {
        const lines = nodes.flatMap((node) => node.dependsOn.map((parent) => {
          const from = layout.positions.get(parent); const to = layout.positions.get(node.key); if (!from || !to) return '';
          return `<path d="M${from.x + 264},${from.y + 66} C${from.x + 292},${from.y + 66} ${to.x - 28},${to.y + 66} ${to.x - 4},${to.y + 66}" marker-end="url(#graph-arrow)"/>`;
        })).join('');
        board.innerHTML = `<div class="graph-canvas" ><svg width="${layout.width}" height="${layout.height}" aria-label="任务依赖连线"><defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker></defs>${lines}</svg>${nodes.map((n) => card(n, true)).join('')}</div>`;
        const canvas = $('.graph-canvas', board);
        canvas.style.zoom = String(this.zoom);
        canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`;
        all('[data-node]', canvas).forEach(element => {
          const position = layout.positions.get(element.dataset.node);
          element.style.left = `${position.x}px`; element.style.top = `${position.y}px`;
        });
      }
    }
    $('#graph-job-list').innerHTML = [...this.jobs, ...(this.generationJob?.status === 'needs_attention' && !this.jobs.some(j => j.id === this.generationJob.id) ? [this.generationJob] : [])].filter((j) => j.status === 'needs_attention').map((j) => `<div class="graph-job"><b>后台任务需要处理</b><span>${escape(reason(j.errorCode))}</span>
      <label><input type="checkbox" data-ack="${escape(j.id)}"> 已核对后台对话，可重新调用</label><button class="secondary" data-retry-job="${escape(j.id)}">重试</button></div>`).join('');
  }
  async generate(event) {
    const form = event.currentTarget; const data = new FormData(form);
    this.generationKey ||= crypto.randomUUID();
    const mode = data.get('reviewMode');
    const paths = String(data.get('paths')).split('\n').map((s) => s.trim()).filter(Boolean);
    const buttons = all('button[type=submit]', form); buttons.forEach((b) => { b.disabled = true; });
    try {
      const { job } = await this.api(`/api/projects/${this.projectId}/work-graphs/generate`, { method: 'POST', body: {
        prompt: data.get('prompt'), candidateIds: data.getAll('candidate'), ...(paths.length ? { paths } : {}),
        autoStart: !event.submitter?.dataset.preview, reviewPolicy: { mode, finalMode: data.get('finalMode') === 'same' ? mode : 'manual' }, idempotencyKey: this.generationKey } });
      this.generationKey = null; this.generationJobId = job.id;
      localStorage.setItem(`work-graph-job:${this.projectId}`, job.id); await this.refresh();
    } finally { buttons.forEach((b) => { b.disabled = false; }); }
  }
  async action(event) {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.viewMode) { this.mode = button.dataset.viewMode; this.render(); }
    else if (button.hasAttribute('data-refresh-graph')) await this.refresh();
    else if (button.dataset.zoom) { this.zoom = Math.max(0.5, Math.min(1.5, this.zoom + Number(button.dataset.zoom) * 0.1)); this.render(); }
    else if (button.dataset.node) { this.selectedKey = button.dataset.node; this.render(); this.showNode(this.current, button.dataset.node); }
    else if (button.hasAttribute('data-edit-plan')) this.editPlan();
    else if (button.dataset.control) {
      button.disabled = true;
      try { await this.api(`/api/work-graphs/${this.graphId}/${button.dataset.control}`, { method: 'POST', body: { expectedRevision: this.current.run.revision } }); await this.refresh(); }
      finally { button.disabled = false; }
    } else if (button.hasAttribute('data-start-graph')) {
      const form = new FormData($('#graph-generate-form')); const mode = form.get('reviewMode');
      await this.api(`/api/work-graphs/${this.graphId}/start`, { method: 'POST', body: { expectedVersion: this.current.version,
        idempotencyKey: crypto.randomUUID(), reviewPolicy: { mode, finalMode: form.get('finalMode') === 'same' ? mode : 'manual' } } });
      await this.refresh();
    } else if (button.dataset.retryJob) {
      await this.api(`/api/work-graph-jobs/${button.dataset.retryJob}/retry`, { method: 'POST', body: {
        acknowledgeUncertain: $(`[data-ack="${button.dataset.retryJob}"]`).checked } }); await this.refresh();
    }
  }
  async inspect(task, native = null) {
    const data = await this.api(`/api/projects/${task.projectId}/work-graphs`);
    const graph = data.graphs.find((g) => g.nodes.some((n) => n.taskId === task.id));
    if (graph) this.showNode(graph, graph.nodes.find((n) => n.taskId === task.id).key, native);
  }
  showNode(graph, key, native = null) {
    const node = graph.nodes.find((n) => n.key === key); this.detail = { graph, node, native };
    const task = node.task; const editable = task && ['active', 'rework'].includes(task.status) && graph.run?.status === 'running';
    const latest = node.submissions?.find((s) => s.taskVersion === node.version);
    this.drawer.innerHTML = `<div class="graph-drawer-top"><div><p class="eyebrow">${escape(node.assigneeName)} · V${node.version}</p><h2>${escape(node.title)}</h2></div><button class="secondary" data-close-drawer aria-label="关闭">×</button></div>
      <p><span class="status-tag ${escape(node.status)}">${labels[node.status]}</span> ${escape(reason(node.blockedReason))}</p>
      ${task ? `<h3>验收标准</h3><p class="graph-preserve">${escape(task.acceptance)}</p><h3>任务清单</h3>
        <div id="graph-checklist">${task.checklist.map((i) => `<label><input type="checkbox" data-item="${escape(i.id)}" ${i.done ? 'checked' : ''} ${!editable || graph.owner ? 'disabled' : ''}> ${escape(i.text)}</label>`).join('')}</div>` : '<p>启动计划后下发任务。</p>'}
      ${(task?.inputManifest || []).map((h) => `<section class="graph-handoff"><h3>上游成果</h3><p class="graph-preserve">${escape(h.summary)}</p>${h.outputs.map((f) => `<button class="text-link" data-open-output="${escape(f.path)}">${escape(f.path)}</button>`).join('')}</section>`).join('')}
      ${(node.reviews || []).map((r) => `<section class="graph-review"><b>${r.source === 'ai' ? 'AI' : '老板'} · ${r.verdict === 'passed' ? '通过' : r.verdict === 'rework' ? '返工' : '需人工判断'} · ${r.status === 'applied' ? '已应用' : r.status === 'superseded' ? '历史意见' : '建议'}</b><p class="graph-preserve">${escape(r.detail.feedback)}</p>${(r.detail.items || []).map((i) => `<small>${escape(i.status)} · ${escape(i.comment)}</small>`).join('')}</section>`).join('')}
      ${latest ? `<section class="graph-submission"><h3>本轮提交 · ${latest.kind === 'manual' ? '人工成果' : 'Codex 成果'}</h3><p class="graph-preserve">${escape(latest.resultSummary || latest.finalReplySnapshot)}</p><small>固定快照 ${escape(latest.snapshotCommitSha?.slice(0, 12))}</small><ul>${latest.outputsManifest.map((f) => `<li><button class="text-link" data-preview-submission="${escape(latest.id)}" data-path="${escape(f.path)}">${escape(f.path)}</button> · ${f.size} B</li>`).join('')}</ul></section>` : ''}
      ${!graph.owner && editable ? `<form id="graph-submit-form"><label>${native ? '已选择 Codex 最终回复，补充交付说明' : '成果说明'}<textarea name="summary" rows="5" maxlength="8000" ${native ? '' : 'required'}></textarea></label>
      <label>额外交付文件（每行一个）<textarea name="outputs" rows="2"></textarea></label><label>已知限制 / 备注<textarea name="note" rows="2" maxlength="4000"></textarea></label>
      <p class="form-error" role="alert"></p><div class="dialog-actions"><button class="secondary" type="button" data-open-task>进入任务对话</button><button class="secondary" type="button" data-save-checklist>保存清单</button><button class="primary" type="submit">提交验收</button></div></form>` : ''}
      ${graph.owner && latest?.verdict === 'pending' && graph.run?.status === 'running' ? `<label>审核意见 / 修改要求<textarea id="graph-review-feedback" rows="4" maxlength="8000"></textarea></label><div class="dialog-actions"><button class="secondary" data-verdict="rework">打回重做</button><button class="primary" data-verdict="passed">通过并交付</button></div>` : ''}`;
    if (!this.drawer.open) this.drawer.showModal();
    $('#graph-submit-form', this.drawer)?.addEventListener('submit', (event) => { event.preventDefault(); this.submitDetail(event.currentTarget).catch((e) => { $('.form-error', event.currentTarget).textContent = e.message; }); });
  }
  async saveChecklist() {
    const { node } = this.detail;
    const { task } = await this.api(`/api/tasks/${node.task.id}/checklist`, { method: 'PATCH', body: {
      taskVersion: node.task.version, revision: node.task.checklistRevision,
      items: all('[data-item]', this.drawer).map((i) => ({ id: i.dataset.item, done: i.checked })) } });
    node.task = task; return task;
  }
  async submitDetail(form) {
    const data = new FormData(form); const button = $('button[type=submit]', form); button.disabled = true;
    try {
      const task = this.detail.submissionBody ? this.detail.node.task : await this.saveChecklist();
      this.detail.submissionKey ||= crypto.randomUUID();
      this.detail.submissionBody ||= {
        kind: this.detail.native ? 'codex' : 'manual', ...(this.detail.native || {}), taskVersion: task.version,
        checklistRevision: task.checklistRevision, idempotencyKey: this.detail.submissionKey, resultSummary: data.get('summary'),
        outputs: String(data.get('outputs')).split('\n').map((s) => s.trim()).filter(Boolean), note: data.get('note') };
      await this.api(`/api/tasks/${task.id}/submissions`, { method: 'POST', body: this.detail.submissionBody });
      this.drawer.close(); this.toast('成果已提交，等待验收'); await this.refreshTasks();
    } catch (error) {
      if (error.status && error.status < 500) this.detail.submissionBody = null;
      throw error;
    } finally { button.disabled = false; }
  }
  async drawerAction(event) {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-close-drawer')) this.drawer.close();
    else if (button.hasAttribute('data-save-checklist')) { await this.saveChecklist(); this.toast('清单已保存'); }
    else if (button.hasAttribute('data-open-task')) { this.drawer.close(); await this.openTaskChat(this.detail.node.task.id); }
    else if (button.dataset.openOutput) { this.drawer.close(); await this.openFile(this.detail.graph.projectId, button.dataset.openOutput); }
    else if (button.dataset.previewSubmission) {
      const endpoint = `/api/task-submissions/${encodeURIComponent(button.dataset.previewSubmission)}/artifact?path=${encodeURIComponent(button.dataset.path)}`;
      const { file } = await this.api(endpoint);
      let preview = $('#graph-artifact-preview', this.drawer);
      if (!preview) { preview = document.createElement('section'); preview.id = 'graph-artifact-preview'; this.drawer.append(preview); }
      preview.innerHTML = `<h3>${escape(file.path)} · 固定提交版本</h3><a class="text-link" href="${escape(endpoint)}&download=1" download>下载成果</a><pre class="graph-preserve">${escape(file.content ?? '此文件请下载查看。')}</pre>`;
      preview.scrollIntoView({ block: 'nearest' });
    }
    else if (button.dataset.verdict) {
      const { node } = this.detail; const submission = node.submissions.find((s) => s.taskVersion === node.version && s.verdict === 'pending');
      button.disabled = true;
      try { await this.api(`/api/admin/task-submissions/${submission.id}/review`, { method: 'POST', body: {
        verdict: button.dataset.verdict, expectedVersion: node.version, feedback: $('#graph-review-feedback').value } });
      this.drawer.close(); await this.refresh(); this.toast('验收结果已保存'); }
      finally { button.disabled = false; }
    }
  }
  editPlan() {
    const graph = structuredClone(this.current.plan.graph);
    const version = this.current.version; const graphId = this.graphId;
    const collect = () => {
      const form = $('#graph-plan-form');
      graph.title = $('[name=title]', form).value;
      for (const field of all('[data-edit-node]', form)) {
        const n = graph.nodes.find(n => n.key === field.dataset.editNode);
        n.title = $('[name=title]', field).value; n.assigneeUserId = $('[name=assignee]', field).value;
        n.dependsOn = [...$('[name=depends]', field).selectedOptions].map(o => o.value);
        n.acceptance = $('[name=acceptance]', field).value;
        n.checklist = $('[name=checklist]', field).value.split('\n').map(s => s.trim()).filter(Boolean);
        n.outputs = $('[name=outputs]', field).value.split('\n').map(s => s.trim()).filter(Boolean);
        n.completionGate = $('[name=final]', field).checked;
        n.requiresIndependentValidation = $('[name=independent]', field).checked;
        const due = $('[name=due]', field).value; n.dueAt = due ? new Date(due).toISOString() : null;
      }
    };
    const render = () => {
      this.drawer.innerHTML = `<div class="graph-drawer-top"><h2>编辑计划 · V${version}</h2><button class="secondary" data-close-drawer>×</button></div>
        <form id="graph-plan-form"><label>工作图名称<input name="title" value="${escape(graph.title)}" required maxlength="160"></label>
        ${graph.nodes.map(n => `<fieldset data-edit-node="${escape(n.key)}"><legend>${escape(n.title)}</legend><label>任务名称<input name="title" value="${escape(n.title)}" required maxlength="160"></label>
        <label>负责人<select name="assignee">${this.candidates.map(u => `<option value="${escape(u.id)}" ${u.id === n.assigneeUserId ? 'selected' : ''}>${escape(u.displayName)}</option>`).join('')}</select></label>
        <label>等待哪些任务完成？<select name="depends" multiple>${graph.nodes.filter(p => p.key !== n.key).map(p => `<option value="${escape(p.key)}" ${n.dependsOn.includes(p.key) ? 'selected' : ''}>${escape(p.title)}</option>`).join('')}</select></label>
        <label>验收标准<textarea name="acceptance" required>${escape(n.acceptance)}</textarea></label><label>任务清单（每行一项）<textarea name="checklist" required>${escape(n.checklist.map(i => typeof i === 'string' ? i : i.text).join('\n'))}</textarea></label>
        <label>必需交付文件（每行一个）<textarea name="outputs">${escape(n.outputs.join('\n'))}</textarea></label>
        <label>截止时间<input name="due" type="datetime-local" value="${n.dueAt ? new Date(Date.parse(n.dueAt) - new Date(n.dueAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}"></label>
        <label><input name="final" type="checkbox" ${n.completionGate ? 'checked' : ''}> 最终交付节点（整张图仅一个）</label>
        <label><input name="independent" type="checkbox" ${n.requiresIndependentValidation ? 'checked' : ''}> 需要老板核对独立验证</label>
        <button class="secondary" type="button" data-remove-node="${escape(n.key)}">删除任务</button></fieldset>`).join('')}
        <button class="secondary" type="button" data-add-node>添加任务</button><p class="form-error" role="alert"></p><button class="primary" type="submit">保存新版本</button></form>`;
      const form = $('#graph-plan-form');
      $('[data-add-node]', form).onclick = () => {
        collect(); if (graph.nodes.length >= 32) return this.toast('最多 32 个任务', 'error');
        graph.nodes.push({ key: `node_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, title: '新任务',
          assigneeUserId: this.candidates[0]?.id || '', dependsOn: [], acceptance: '', checklist: [], outputs: [], completionGate: false }); render();
      };
      all('[data-remove-node]', form).forEach(button => { button.onclick = () => {
        collect(); graph.nodes = graph.nodes.filter(n => n.key !== button.dataset.removeNode);
        graph.nodes.forEach(n => { n.dependsOn = n.dependsOn.filter(k => k !== button.dataset.removeNode); }); render();
      }; });
      form.onsubmit = async event => {
        event.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
        try {
          collect();
          await this.api(`/api/work-graphs/${graphId}/plan`, { method: 'PATCH', body: { expectedVersion: version, graph } });
          this.drawer.close(); await this.refresh();
        } catch (error) { $('.form-error', form).textContent = error.message; }
        finally { button.disabled = false; }
      };
    };
    render(); if (!this.drawer.open) this.drawer.showModal();
  }
}
