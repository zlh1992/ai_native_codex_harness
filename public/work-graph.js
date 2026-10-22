import { KanbanBoard, taskColumn, taskColumns } from './kanban.js';
import { sessionFetch, sessionUrl } from './employee-session.js';
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
  PLANNER_TRANSIENT_NETWORK: '模型响应流网络中断，尚未保存计划',
  WORKFLOW_RESULT_MISSING: '模型已结束，但未提交有效的结构化结果',
  DELIVERY_MERGE_CONFLICT: '成果合并冲突，请处理', WORKFLOW_AUTHORIZATION_CHANGED: '账号策略变化，请恢复授权',
  INDEPENDENT_VALIDATION_REQUIRED: '需要独立验证，请老板验收', REWORK_LIMIT_REACHED: '已到自动返工上限',
  DELIVERY_SCOPE_REVIEW_REQUIRED: '存在无关工作，请核对交付范围', MODEL_BUDGET_EXCEEDED: '已到模型调用预算' };
const reason = (code) => reasons[code] || (code ? '等待处理，请查看后台任务' : '');
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
const runLabels = { queued: '等待模型容量', starting: '连接模型', running: '模型生成中', completed: '模型已结束', failed: '模型调用失败', interrupted: '模型已中断' };
export function jobProgress(job) {
  const p = job.progress || {};
  return `配置模型 ${p.configuredModel || '—'} / ${p.configuredEffort || '—'} · 已调用 ${p.modelCalls || 0} 次 · ${runLabels[p.runStatus] || '等待调度'} · ${p.receiptSaved ? '已保存业务结果' : '尚未保存业务结果'}`;
}
export function jobAttentionMarkup(job) {
  const safe = job.recovery === 'retry'; const resume = job.recovery === 'resume';
  return `<div class="graph-job"><b>${job.type === 'plan.generate' ? '计划生成待恢复' : '后台任务待恢复'}</b><span>${escape(safe && job.errorCode === 'MODEL_DELIVERY_UNCERTAIN' ? reasons.PLANNER_TRANSIENT_NETWORK : reason(job.errorCode))}</span>
    <p>${escape(jobProgress(job))}</p><p>开始 ${escape(date(job.progress?.startedAt))} · 结束 ${escape(date(job.progress?.completedAt))} · 最近工具活动 ${escape(date(job.progress?.lastToolAt))}</p>
    <p>${resume ? '已有持久结果，将恢复后续步骤，不重新调用模型。' : safe ? '可重新尝试；保留历史，自动尝试达到上限后停止。重试可能增加模型用量。' : '无法确认先前调用是否生效。请先查看后台记录；重新调用可能重复工作并增加模型用量。'}</p>
    ${job.chatId ? `<button class="secondary" data-job-chat="${escape(job.chatId)}">查看后台记录</button>` : ''}
    ${job.recovery === 'confirm' ? `<label><input type="checkbox" data-ack="${escape(job.id)}"> 已查看记录，确认重新调用</label>` : ''}
    <button class="secondary" data-retry-job="${escape(job.id)}" ${job.recovery === 'blocked' ? 'disabled' : ''}>${resume ? '恢复后续步骤' : '重新尝试'}</button></div>`;
}
const reviewLabel = mode => mode === 'auto' ? 'AI 自动审核 · 推进 / 打回' : mode === 'manual' ? '老板人工审核' : '老板审核 · AI 提供意见';
const coverageLabel = code => ({ UNSUPPORTED_FORMAT: '格式暂不支持内容审核', NO_EXTRACTABLE_TEXT: '未提取到正文',
  DOCX_NON_TEXT_CONTENT: '含图片/嵌入内容或解析警告', PDF_NON_TEXT_CONTENT: '含图片或无文本页',
  TEXT_LIMIT: '文本超出审核预算', PAGE_LIMIT: '超过页数预算', REVIEW_BUDGET: '超过本轮审核预算',
  EXTRACTION_FAILED: '解析失败或超时', EXTRACTOR_UNAVAILABLE: '解析器不可用', FILE_LIMIT: '文件超限' })[code] || code;
const isRaster = name => /\.(png|jpe?g|gif|webp)$/i.test(name);
const artifactUrl = (id, file) => sessionUrl(`/api/task-submissions/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(file.path)}`);
const GRAPH_NODE_WIDTH = 264;
const GRAPH_NODE_HEIGHT = 176;
const GRAPH_COLUMN_STEP = 320;
const GRAPH_ROW_STEP = 200;
const viewHelp = {
  kanban: '任务看板：按真实状态分列；点击卡片查看清单、附件和验收。排序只影响你的显示，不改变任务状态。',
  graph: '依赖图：按前后置关系排列任务，连线表示必须先完成的依赖；可横向、纵向滚动和缩放。',
  list: '状态列表：不画依赖连线，按任务卡片集中查看负责人、状态和截止信息。',
  events: '事件记录：按时间倒序查看工作图的状态变化与推进原因。',
};

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
    return [node.key, { x: 24 + depth * GRAPH_COLUMN_STEP, y: 24 + row * GRAPH_ROW_STEP }];
  }));
  return { positions, width: Math.max(340, (Math.max(0, ...levels.values()) + 1) * GRAPH_COLUMN_STEP),
    height: Math.max(260, Math.max(1, ...rows.values()) * GRAPH_ROW_STEP + 48) };
}

export class WorkGraphUI {
  constructor({ api, toast, openTask, openFile, refreshTasks, onDetail }) {
    Object.assign(this, { api, toast, openTaskChat: openTask, openFile, refreshTasks, onDetail });
    this.zoom = 1; this.graphs = []; this.mode = 'kanban'; this.events = []; this.jobs = []; this.selection = 0;
    this.generationKeys = new Map();
    this.detailEpoch = 0;
  }
  clearDetail() {
    this.detailEpoch++;
    for (const entry of this.detail?.uploads || []) if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.detail = null;
  }
  closeDetail(notify = true) {
    if (this.detail?.submitting) return;
    if (notify) this.onDetail?.(null);
    this.clearDetail();
    if (this.drawer?.open) this.drawer.close();
  }
  dispose() {
    this.selection++; this.source?.close(); this.source = null; clearInterval(this.poller); clearTimeout(this.refreshTimer);
    this.handlers?.abort(); this.kanban?.destroy(); this.kanban = null;
    this.clearDetail();
    this.detail = null; this.current = null; this.events = []; this.graphs = []; this.jobs = []; this.projectId = ''; this.graphId = null;
    this.generationKeys = new Map(); this.generationJobId = null; this.generationJob = null;
    this.initialized = false; this.refreshing = false; this.employeeRefresh = null; this.owner = false;
    this.panel?.replaceChildren(); this.panel?.classList.add('hidden');
  }
  async initialize(user, projects) {
    projects = projects.filter(p => p.projectType !== 'local_private');
    this.user = user; this.projects = projects; this.owner = user.role === 'admin';
    this.panel = $('#work-graph-panel'); this.drawer = $('#work-graph-drawer');
    if (!this.panel || this.initialized) return;
    this.initialized = true;
    this.handlers = new AbortController(); const options = { signal: this.handlers.signal };
    this.drawer.addEventListener('click', (event) => this.drawerAction(event).catch((e) => this.toast(e.message, 'error')), options);
    this.drawer.addEventListener('cancel', event => { event.preventDefault(); this.closeDetail(); }, options);
    this.drawer.addEventListener('close', () => {
      // Native close events can arrive after a different drawer has already opened.
      if (!this.drawer.open && this.detail) this.clearDetail();
    }, options);
    this.panel.addEventListener('click', (event) => this.action(event).catch((e) => this.toast(e.message, 'error')), options);
    this.panel.addEventListener('change', (event) => {
      if (event.target.id === 'graph-project') this.selectProject(event.target.value).catch((e) => this.toast(e.message, 'error'));
      if (event.target.id === 'graph-select') { this.graphId = event.target.value; this.refresh().catch((e) => this.toast(e.message, 'error')); }
    }, options);
    if (!this.owner) {
      this.poller = setInterval(() => { if (document.visibilityState === 'visible') this.refreshEmployee().catch(() => {}); }, 5000);
      return;
    }
    $('.employee-hero h1').textContent = '团队任务看板';
    $('.employee-hero .eyebrow').textContent = 'TEAM WORK GRAPH';
    $('.employee-hero p:last-child').textContent = '从项目资料与团队能力生成计划，让交付、验收与下一步持续推进。';
    const captions = ['进行中', '待验收', '返工 / 阻塞', '已通过'];
    all('.employee-summary > div > span').forEach((node, index) => { node.textContent = captions[index]; });
    $('#task-list').classList.add('hidden'); $('.task-section-title').classList.add('hidden');
    this.panel.classList.remove('hidden');
    this.panel.innerHTML = `<div class="graph-project-row"><label>项目<select id="graph-project">${projects.filter((p) => p.accessKind === 'owner')
      .map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}</select></label><span>每个项目一张活动工作图 · 员工独立交付</span></div>
      <details class="graph-generate-details"><summary>＋ 规划新任务 · 设置参与员工与验收方式</summary><form id="graph-generate-form" class="graph-generate"><label class="graph-goal">这次想完成什么？<textarea name="prompt" rows="2" maxlength="8000" required placeholder="例如：请团队完成新版产品方案，设计和实现并行，最后汇总验收"></textarea></label>
      <div class="graph-options"><label>默认审核方式<select name="reviewMode"><option value="manual">老板人工审核</option><option value="assisted">老板审核 · AI 提供意见</option><option value="auto">AI 自动审核 · 推进 / 打回</option></select></label>
      <label>最终交付<select name="finalMode"><option value="same">跟随审核方式</option><option value="manual">老板最终人工验收</option><option value="assisted">老板最终验收 · AI 提供意见</option><option value="auto">AI 最终自动审核</option></select></label>
      <button class="secondary" type="submit" data-preview="true">生成草稿</button><button class="primary" type="submit">生成并派发</button></div>
      <details class="graph-sources"><summary>参与员工与项目资料</summary><div id="graph-candidates" class="graph-candidates"></div>
      <label>使用的项目文件（每行一个；留空自动选取文本资料）<textarea name="paths" rows="2" placeholder="README.md"></textarea></label>
      <div id="graph-materials"></div><small>发布将向参与员工共享整个项目（节点附件不是文件权限隔离），并按所选方式持续验收。规划对话不会复制给员工。</small></details></form></details>
      <div id="graph-generation-status" role="status"></div><div class="graph-toolbar"><div><p class="eyebrow">WORK GRAPH</p><select id="graph-select" aria-label="选择工作图"></select></div>
      <div class="graph-view-actions"><button class="secondary" data-view-mode="kanban">任务看板</button><button class="secondary" data-view-mode="graph">依赖图</button><button class="secondary" data-view-mode="list">状态列表</button><button class="secondary" data-view-mode="events">事件记录</button><button class="secondary" data-zoom="-1" aria-label="缩小依赖图">−</button><button class="secondary" data-zoom="1" aria-label="放大依赖图">＋</button><button class="secondary" data-refresh-graph>刷新</button></div></div>
      <label class="board-search" id="graph-search-label">搜索<input id="graph-search" type="search" placeholder="任务或负责人" aria-label="搜索团队任务"></label>
      <p id="graph-view-help" class="graph-view-help" aria-live="polite"></p><div id="graph-run-bar"></div><div id="graph-board"></div><div id="graph-job-list"></div>`;
    $('#graph-generate-form').addEventListener('submit', (event) => { event.preventDefault(); this.generate(event).catch((e) => this.toast(e.message, 'error')); });
    $('#graph-search').addEventListener('input', () => this.render());
    await this.selectProject($('#graph-project').value);
  }
  async updateProjects(projects) {
    if (!this.initialized || !this.owner) return;
    projects = projects.filter(p => p.projectType !== 'local_private');
    this.projects = projects;
    const owned = projects.filter(p => p.accessKind === 'owner');
    $('#graph-project').innerHTML = owned.map(p => `<option value="${escape(p.id)}" ${p.id === this.projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('');
    if (!owned.some(p => p.id === this.projectId)) await this.selectProject(owned[0]?.id || '');
  }
  async refreshEmployee() {
    if (this.employeeRefresh) return;
    const token = {}; this.employeeRefresh = token;
    const selection = this.selection;
    try {
      await this.refreshTasks();
      const detail = this.detail;
      // Never replace an employee's draft, chosen upload, or uncertain submission.
      if (selection !== this.selection || !this.drawer.open || !detail || detail.graph.owner
        || detail.submitting || $('#graph-submit-form', this.drawer)) return;
      const { graph } = await this.api(`/api/work-graphs/${detail.graph.id}`);
      if (selection !== this.selection || this.detail !== detail || !this.drawer.open) return;
      const node = graph.nodes.find(node => node.key === detail.node.key);
      if (node && (JSON.stringify(node) !== JSON.stringify(detail.node) || graph.run?.status !== detail.graph.run?.status)) {
        const scroll = this.drawer.scrollTop;
        this.showNode(graph, node.key, null, true); this.drawer.scrollTop = scroll;
      }
    } finally { if (this.employeeRefresh === token) this.employeeRefresh = null; }
  }
  async selectProject(id) {
    this.closeDetail();
    const selection = ++this.selection;
    this.kanban?.destroy(); this.kanban = null; this.current = null;
    this.source?.close(); clearInterval(this.poller); this.projectId = id; this.graphId = null; this.events = []; this.generationJob = null;
    this.generationJobId = null;
    $('#graph-generation-status').textContent = '';
    if (!id) { $('#graph-board').textContent = '先在驾驶舱或工作台创建项目。'; return; }
    const data = await this.api(`/api/projects/${id}/work-graphs/candidates`);
    if (id !== this.projectId || selection !== this.selection) return;
    this.candidates = data.employees;
    if (this.dispatchEnabled) {
      const { materials } = await this.api(`/api/projects/${id}/materials`);
      if (id !== this.projectId || selection !== this.selection) return;
      $('#graph-materials').innerHTML = `<p>选择任务输入资料（在项目对话的“派发资料”中上传）</p>${materials.map(f => `<label><input type="checkbox" name="attachment" value="${escape(f.id)}"> ${escape(f.name)} · ${f.size} B</label>`).join('') || '<small>尚无资料附件</small>'}`;
    }
    $('#graph-candidates').innerHTML = data.employees.map((u) => `<label><input type="checkbox" name="candidate" value="${escape(u.id)}" ${u.profile.availability === 'unavailable' ? 'disabled' : 'checked'}> ${escape(u.displayName)} <small>${escape(u.profile.jobTitle || '未设置岗位')}</small></label>`).join('') || '请先在驾驶舱创建员工。';
    const pending = localStorage.getItem(`work-graph-job:${id}`); if (pending) this.generationJobId = pending;
    else this.generationJobId = null;
    await this.refresh();
    if (id !== this.projectId || selection !== this.selection) return;
    this.subscribe(id);
    this.poller = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh().catch(() => {});
    }, 5000);
  }
  subscribe(id) {
    this.source = new EventSource(sessionUrl(`/api/projects/${id}/events?after=0`));
    const source = this.source;
    this.source.addEventListener('project_event', (event) => {
      if (this.source !== source || this.projectId !== id) return;
      const data = JSON.parse(event.data);
      if (!this.events.some((entry) => entry.id === data.id)) this.events.push(data);
      this.events.sort((a, b) => a.id - b.id);
      clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh().catch(() => {}), 150);
    });
  }
  async refresh() {
    const selection = this.selection;
    if (!this.owner || !this.projectId || this.refreshing === selection) return;
    this.refreshing = selection;
    try {
      const projectId = this.projectId;
      const data = await this.api(`/api/projects/${projectId}/work-graphs`);
      if (projectId !== this.projectId || selection !== this.selection) return;
      this.graphs = data.graphs;
      if (!this.graphs.some((g) => g.id === this.graphId)) this.graphId = this.graphs[0]?.id || null;
      if (this.graphId) {
        const selectedId = this.graphId;
        const detail = await this.api(`/api/work-graphs/${selectedId}`);
        if (projectId !== this.projectId || selectedId !== this.graphId || selection !== this.selection) return;
        this.jobs = detail.jobs;
        this.current = detail.graph;
      } else { this.current = null; this.jobs = []; }
      $('#graph-select').innerHTML = this.graphs.map((g) => `<option value="${escape(g.id)}" ${g.id === this.graphId ? 'selected' : ''}>${escape(g.title)} · V${g.version}</option>`).join('');
      if (this.generationJobId) {
        const jobId = this.generationJobId;
        const { job } = await this.api(`/api/work-graph-jobs/${jobId}`);
        if (selection !== this.selection || projectId !== this.projectId || jobId !== this.generationJobId) return;
        this.generationJob = job;
        $('#graph-generation-status').textContent = `计划生成：${labels[job.status] || job.status} · ${jobProgress(job)}${job.status === 'retry_wait' ? ` · 下次尝试 ${date(job.dueAt)}（调度 ${job.attempt}/${job.maxAttempts}）` : job.status === 'needs_attention' ? ' · 请查看下方恢复卡片' : ''}`;
        if (job.status === 'succeeded') { localStorage.removeItem(`work-graph-job:${projectId}`); this.generationJobId = null; }
        if (job.status === 'needs_attention' && !this.jobs.some((j) => j.id === job.id)) this.jobs.unshift(job);
      }
      if (selection === this.selection && projectId === this.projectId) this.render();
    } finally { if (this.refreshing === selection) this.refreshing = false; }
  }
  render() {
    const graph = this.current; const nodes = graph?.nodes || [];
    const counts = [nodes.filter((n) => n.status === 'active').length, nodes.filter((n) => n.status === 'submitted').length,
      nodes.filter((n) => n.status === 'rework' || (n.blockedReason && !['WAITING_DEPENDENCIES', 'WAITING_EMPLOYEE', 'WAITING_REVIEW'].includes(n.blockedReason))).length,
      `${nodes.filter((n) => n.status === 'passed').length} / ${nodes.length}`];
    ['task-active-count', 'task-submitted-count', 'task-passed-count', 'visible-project-count'].forEach((id, index) => { $(`#${id}`).textContent = counts[index]; });
    const run = graph?.run; const canEdit = !run || ['passed', 'cancelled', 'superseded'].includes(run.status);
    $('#graph-view-help').textContent = viewHelp[this.mode];
    all('[data-view-mode]', this.panel).forEach((button) => {
      const active = button.dataset.viewMode === this.mode;
      button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
    });
    all('[data-zoom]', this.panel).forEach((button) => { button.disabled = this.mode !== 'graph'; });
    $('#graph-run-bar').innerHTML = graph ? `<span class="status-tag ${escape(run?.status || 'draft')}">${labels[run?.status || 'draft']}</span>
      <span>最近检查 ${date(run?.lastCheckedAt)} · 下次 ${date(run?.nextCheckAt)}</span>
      ${canEdit ? '<button class="secondary" data-edit-plan>编辑计划</button><button class="primary" data-start-graph>发布任务</button>'
        : `<button class="secondary" data-control="${run.status === 'paused' ? 'resume' : 'pause'}">${run.status === 'paused' ? '恢复推进' : '暂停'}</button><button class="secondary danger" data-control="cancel">取消运行</button>`}` : '';
    const board = $('#graph-board');
    $('#graph-search-label').hidden = this.mode !== 'kanban';
    if (this.mode !== 'kanban') { this.kanban?.destroy(); this.kanban = null; }
    if (!graph) $('.graph-generate-details').open = true;
    if (!graph) { board.className = 'graph-empty'; board.textContent = '输入项目目标，生成团队的第一张工作图。'; }
    else if (this.mode === 'kanban') {
      board.className = '';
      if (this.kanban?.key !== `portal-board:${this.user.id}:graph:${graph.id}`) { this.kanban?.destroy(); this.kanban = null; }
      this.kanban ||= new KanbanBoard(board, { key: `${this.user.id}:graph:${graph.id}`, onOpen: key => this.showNode(this.current, key) });
      this.kanban.render(taskColumns, nodes.map(node => ({ id: node.key, column: taskColumn(node), title: node.title,
        tag: node.completionGate ? '最终交付' : reviewLabel(node.reviewMode), person: node.assigneeName,
        description: reason(node.blockedReason) || node.acceptance || '',
        meta: `V${node.version} · ${node.dueAt ? date(node.dueAt) : '未设截止日期'}`,
        search: `${node.title} ${node.assigneeName} ${labels[node.status]}` })), $('#graph-search').value);
    }
    else if (this.mode === 'events') {
      board.className = 'graph-events';
      board.innerHTML = this.events.slice().reverse().map((e) => `<article><time>${date(e.createdAt)}</time><b>${escape(e.type)}</b><span>${escape(reason(e.payload.reason) || labels[e.payload.status] || '')}</span></article>`).join('') || '正在读取项目事件；暂无记录时等待新事件。';
    } else {
      const related = new Set([this.selectedKey, ...(nodes.find(n => n.key === this.selectedKey)?.dependsOn || []), ...nodes.filter(n => n.dependsOn.includes(this.selectedKey)).map(n => n.key)]);
      const layout = graphLayout(nodes); board.className = this.mode === 'list' ? 'graph-list' : 'graph-scroll';
      const card = (node) => `<button class="graph-node status-${escape(node.status)} ${related.has(node.key) ? 'graph-related' : ''}" data-node="${escape(node.key)}" title="${escape(node.title)}">
          <span class="graph-node-heading"><span>${escape(node.assigneeName)}</span><span>V${node.version}</span></span><strong class="graph-node-title">${escape(node.title)}</strong>
          ${(node.task?.inputs?.files || node.attachments || []).length ? `<small>输入资料 ${(node.task?.inputs?.files || node.attachments).length} 份</small>` : ''}<span class="graph-node-status">${labels[node.status]}${node.completionGate ? ' · 最终交付' : ''}</span><small>${escape(reason(node.blockedReason)) || `截止 ${date(node.dueAt)}`}</small><small>${escape(reviewLabel(node.reviewMode))}${node.submissions?.length ? ` · 附件 ${node.submissions.find(s => s.taskVersion === node.version)?.outputsManifest.length || 0}` : ''}</small></button>`;
      if (this.mode === 'list') board.innerHTML = nodes.map((n) => card(n)).join('');
      else {
        const lines = nodes.flatMap((node) => node.dependsOn.map((parent) => {
          const from = layout.positions.get(parent); const to = layout.positions.get(node.key); if (!from || !to) return '';
          const centerY = GRAPH_NODE_HEIGHT / 2;
          return `<path d="M${from.x + GRAPH_NODE_WIDTH},${from.y + centerY} C${from.x + 292},${from.y + centerY} ${to.x - 28},${to.y + centerY} ${to.x - 4},${to.y + centerY}" marker-end="url(#graph-arrow)"/>`;
        })).join('');
        board.innerHTML = `<div class="graph-canvas" ><svg width="${layout.width}" height="${layout.height}" aria-label="任务依赖连线"><defs><marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8"/></marker></defs>${lines}</svg>${nodes.map((n) => card(n)).join('')}</div>`;
        const canvas = $('.graph-canvas', board);
        canvas.style.zoom = String(this.zoom);
        canvas.style.width = `${layout.width}px`; canvas.style.height = `${layout.height}px`;
        all('[data-node]', canvas).forEach(element => {
          const position = layout.positions.get(element.dataset.node);
          element.style.left = `${position.x}px`; element.style.top = `${position.y}px`;
        });
      }
    }
    const acknowledged = new Set(all('[data-ack]:checked').map(node => node.dataset.ack));
    $('#graph-job-list').innerHTML = [...this.jobs, ...(this.generationJob?.status === 'needs_attention' && !this.jobs.some(j => j.id === this.generationJob.id) ? [this.generationJob] : [])].filter((j) => j.status === 'needs_attention').map(jobAttentionMarkup).join('');
    all('[data-ack]').forEach(node => { node.checked = acknowledged.has(node.dataset.ack); });
    all('[data-retry-job]').forEach(node => { node.disabled ||= this.retryingJob === node.dataset.retryJob; });
    if (this.drawer.open && this.detail?.graph.owner && !this.detail.reviewing && graph?.id === this.detail.graph.id) {
      const node = graph.nodes.find(n => n.key === this.detail.node.key);
      if (node && JSON.stringify(node) !== JSON.stringify(this.detail.node)) {
        const feedback = $('#graph-review-feedback', this.drawer)?.value || '';
        const scroll = this.drawer.scrollTop;
        this.showNode(graph, node.key, null, true);
        if ($('#graph-review-feedback', this.drawer)) $('#graph-review-feedback', this.drawer).value = feedback;
        this.drawer.scrollTop = scroll;
      }
    }
  }
  async generate(event) {
    const form = event.currentTarget; const data = new FormData(form);
    const projectId = this.projectId; const selection = this.selection;
    const keys = this.generationKeys;
    const key = keys.get(projectId) || crypto.randomUUID(); keys.set(projectId, key);
    const mode = data.get('reviewMode');
    const finalMode = data.get('finalMode');
    const paths = String(data.get('paths')).split('\n').map((s) => s.trim()).filter(Boolean);
    const buttons = all('button[type=submit]', form); buttons.forEach((b) => { b.disabled = true; });
    try {
      const { job } = await this.api(`/api/projects/${projectId}/work-graphs/generate`, { method: 'POST', body: {
        attachmentIds: data.getAll('attachment'), prompt: data.get('prompt'), candidateIds: data.getAll('candidate'), ...(paths.length ? { paths } : {}),
        autoStart: !event.submitter?.dataset.preview, reviewPolicy: { mode, finalMode: finalMode === 'same' ? mode : finalMode }, idempotencyKey: key } });
      // An accepted request belongs to its initiating project, even after navigation.
      // A disposed session must never restore its private in-memory state.
      if (keys !== this.generationKeys) return;
      keys.delete(projectId);
      localStorage.setItem(`work-graph-job:${projectId}`, job.id);
      if (selection !== this.selection || projectId !== this.projectId) return;
      this.generationJobId = job.id; await this.refresh();
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
        idempotencyKey: crypto.randomUUID(), reviewPolicy: { mode, finalMode: form.get('finalMode') === 'same' ? mode : 'assisted' } } });
      await this.refresh();
    } else if (button.dataset.jobChat) {
      const selection = this.selection; const chatId = button.dataset.jobChat;
      this.clearDetail();
      this.drawer.innerHTML = '<button class="secondary" data-close-drawer>关闭</button><p>正在读取后台记录…</p>';
      this.drawer.showModal();
      const pending = this.drawer.firstElementChild;
      const data = await this.api(`/api/chats/${encodeURIComponent(chatId)}`);
      if (selection !== this.selection || !this.drawer.open || pending !== this.drawer.firstElementChild) return;
      this.drawer.innerHTML = `<button class="secondary" data-close-drawer>关闭</button><h2>后台私有记录（只读）</h2><p>记录不是任务成功的保证；结构化结果是否已保存，以恢复卡片为准。</p>${data.messages.map(m => `<section><b>${escape(m.role)}</b><p class="graph-preserve">${escape(m.content)}</p></section>`).join('') || '<p>暂无消息记录。</p>'}`;
    } else if (button.dataset.retryJob) {
      if (this.retryingJob) return;
      this.retryingJob = button.dataset.retryJob; button.disabled = true;
      try {
        await this.api(`/api/work-graph-jobs/${button.dataset.retryJob}/retry`, { method: 'POST', body: {
          acknowledgeUncertain: $(`[data-ack="${button.dataset.retryJob}"]`)?.checked === true } }); await this.refresh();
      } finally { this.retryingJob = null; button.disabled = false; }
    }
  }
  async inspect(task, native = null) {
    if (this.detail?.submitting) return;
    this.closeDetail(false);
    const epoch = this.detailEpoch;
    const data = await this.api(`/api/projects/${task.projectId}/work-graphs`);
    if (!this.initialized || epoch !== this.detailEpoch) return;
    const graph = data.graphs.find((g) => g.nodes.some((n) => n.taskId === task.id));
    if (graph) this.showNode(graph, graph.nodes.find((n) => n.taskId === task.id).key, native);
  }
  showNode(graph, key, native = null, preserve = false) {
    const node = graph.nodes.find((n) => n.key === key);
    const existing = preserve && this.detail?.graph.id === graph.id && this.detail.node.key === key
      && this.detail.node.version === node.version ? this.detail : null;
    const preview = existing ? $('#graph-artifact-preview', this.drawer) : null;
    if (existing) Object.assign(existing, { graph, node });
    else { this.clearDetail(); this.detail = { graph, node, native, uploads: [] }; }
    const task = node.task; if (!preserve) this.onDetail?.(task); const editable = task && ['active', 'rework'].includes(task.status) && graph.run?.status === 'running';
    const latest = node.submissions?.find((s) => s.taskVersion === node.version);
    this.drawer.innerHTML = `<div class="graph-drawer-top"><div><p class="eyebrow">${escape(node.assigneeName)} · V${node.version}</p><h2>${escape(node.title)}</h2></div><button class="secondary" data-close-drawer aria-label="关闭">×</button></div>
      <p><span class="status-tag ${escape(node.status)}">${labels[node.status]}</span> ${escape(reason(node.blockedReason))}</p>
      <p>${escape(reviewLabel(node.reviewMode))}</p>
      ${!graph.owner && editable ? '<p><button class="primary" type="button" data-open-task>进入任务对话</button></p>' : ''}
      ${latest ? `<p role="status">审核：${node.reviewJob ? escape(labels[node.reviewJob.status] || node.reviewJob.status) : node.reviewMode === 'manual' ? '等待老板审核' : '等待 AI 审核'}${node.reviewJob?.errorCode ? ` · ${escape(reason(node.reviewJob.errorCode))}` : ''}</p>` : ''}
      ${task ? `<h3>验收标准</h3><p class="graph-preserve">${escape(task.acceptance)}</p><h3>任务清单</h3>
        <div id="graph-checklist">${task.checklist.map((i) => `<label><input type="checkbox" data-item="${escape(i.id)}" ${i.done ? 'checked' : ''} ${!editable || graph.owner ? 'disabled' : ''}> ${escape(i.text)}</label>`).join('')}</div>` : '<p>发布计划后下发任务。</p>'}
      ${!task && node.attachments?.length ? `<h3>选定输入附件</h3><p>${node.attachments.map(f => escape(f.name)).join('、')}</p>` : ''}
      ${task?.inputs?.files?.length ? `<section class="graph-submission"><h3>输入资料 · 第 ${task.inputs.revision} 版</h3><p>进入任务对话即可使用；ZIP 保留原包，不自动解压。整个项目对参与员工共享。</p>${task.inputs.files.map(f => `<p><button class="text-link" data-preview-input="${escape(f.id)}">${escape(f.name)}</button> · ${f.size} B · <a href="${escape(sessionUrl(`/api/tasks/${task.id}/inputs/${f.id}?revision=${task.inputs.revision}&download=1`))}" download>下载</a><small>${escape(f.path)} · SHA-256 ${escape(f.sha256)}</small></p>`).join('')}</section>` : ''}
      ${(task?.inputManifest || []).map((h) => `<section class="graph-handoff"><h3>上游成果</h3><p class="graph-preserve">${escape(h.summary)}</p>${h.outputs.map((f) => `<button class="text-link" data-open-output="${escape(f.path)}">${escape(f.path)}</button>`).join('')}</section>`).join('')}
      ${(node.reviews || []).map((r) => `<section class="graph-review"><b>${r.source === 'ai' ? 'AI' : '老板'} · ${r.verdict === 'passed' ? '通过' : r.verdict === 'rework' ? '返工' : '需人工判断'} · ${r.status === 'applied' ? '已应用' : r.status === 'superseded' ? '历史意见' : '建议'}</b><p class="graph-preserve">${escape(r.detail.feedback)}</p>${(r.detail.items || []).map((i) => `<small>${escape(i.status)} · ${escape(i.comment)} · 证据：${escape((i.evidence || []).join('、') || '未引用')}</small>`).join('')}${(r.detail.coverage || []).map(f => `<small>${escape(f.path)}：${f.complete ? '文本已读取' : '需人工查看'}${f.reason ? ` · ${escape(coverageLabel(f.reason))}` : ''}</small>`).join('')}</section>`).join('')}
      ${latest ? `<section class="graph-submission"><h3>本轮提交 · ${latest.kind === 'manual' ? '人工成果' : 'Codex 成果'}</h3><p class="graph-preserve">${escape(latest.resultSummary || latest.finalReplySnapshot)}</p><p class="graph-preserve">${escape(latest.employeeNote || '')}</p><small>采用资料第 ${latest.inputs?.revision || 0} 版 · 固定快照 ${escape(latest.snapshotCommitSha?.slice(0, 12))} · 附件 ${latest.outputsManifest.length} 个</small><div class="graph-attachments">${latest.outputsManifest.map((f) => `<article class="graph-attachment">${isRaster(f.path) ? `<img loading="lazy" src="${escape(artifactUrl(latest.id, f))}&preview=1" alt="${escape(f.path)}">` : '<span class="graph-file-icon">文件</span>'}<div><button class="text-link" data-preview-submission="${escape(latest.id)}" data-path="${escape(f.path)}">${escape(f.path)}</button><small>${f.size} B · 固定提交版本</small><a class="text-link" href="${escape(artifactUrl(latest.id, f))}&download=1" download>下载</a></div></article>`).join('')}</div></section>` : ''}
      ${(node.submissions || []).filter(s => s.taskVersion !== node.version).map(s => `<details class="graph-submission"><summary>历史交付 · V${s.taskVersion} · ${s.outputsManifest.length} 个附件</summary><p class="graph-preserve">${escape(s.resultSummary || s.finalReplySnapshot)}</p>${s.outputsManifest.map(f => `<p><button class="text-link" data-preview-submission="${escape(s.id)}" data-path="${escape(f.path)}">${escape(f.path)}</button> · <a href="${escape(artifactUrl(s.id, f))}&download=1" download>下载</a></p>`).join('')}</details>`).join('')}
      ${!graph.owner && editable ? `<form id="graph-submit-form"><label>${native ? '已选择 Codex 最终回复，补充交付说明' : '成果说明'}<textarea name="summary" rows="5" maxlength="8000" ${native ? '' : 'required'}></textarea></label>
      <p>必交文件：${escape((node.requiredOutputs || []).join('、') || '无指定文件')}</p>
      <div id="graph-upload-zone" class="graph-upload-zone"><label>上传交付文件（可多选或拖入）<input id="graph-upload-input" type="file" multiple></label><small>提交时上传；图片显示缩略，其他文件显示卡片。含必交文件最多 30 个、合计 32 MiB。失败时已上传文件保留在项目中，移除已上传项会将该文件移入回收站。</small></div><div id="graph-upload-list" class="graph-attachments"></div>
      <label>工作区文件路径（每行一个）<textarea name="outputs" rows="3" placeholder="当前员工项目内的绝对路径，或 reports/result.pdf"></textarea></label><small>路径指 Portal 服务器上的当前项目工作区；你电脑上的文件请使用上传。</small><button class="secondary" type="button" data-check-files>校验文件清单</button><div id="graph-files-result" role="status"></div>
      <label>已知限制 / 备注<textarea name="note" rows="2" maxlength="4000"></textarea></label>
      <p class="form-error" role="alert"></p><div class="dialog-actions"><button class="secondary" type="button" data-save-checklist>保存清单</button><button class="primary" type="submit">提交验收</button></div></form>` : ''}
      ${graph.owner && latest?.verdict === 'pending' && graph.run?.status === 'running' ? `<label>审核意见 / 修改要求<textarea id="graph-review-feedback" rows="4" maxlength="8000"></textarea></label><div class="dialog-actions"><button class="secondary" data-verdict="rework">打回重做</button><button class="primary" data-verdict="passed">通过并交付</button></div>` : ''}`;
    if (preview) this.drawer.append(preview);
    if (!this.drawer.open) this.drawer.showModal();
    $('#graph-submit-form', this.drawer)?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      $('.form-error', form).textContent = '';
      this.submitDetail(form).catch((e) => { $('.form-error', form).textContent = e.message; });
    });
    const input = $('#graph-upload-input', this.drawer);
    if (input) input.onchange = () => { this.addUploads([...input.files]); input.value = ''; };
    const zone = $('#graph-upload-zone', this.drawer);
    if (zone) {
      zone.ondragover = event => event.preventDefault();
      zone.ondrop = event => { event.preventDefault(); this.addUploads([...event.dataTransfer.files]); };
    }
  }
  addUploads(files) {
    if (this.detail.submitting || this.detail.submissionBody) return;
    const entries = this.detail.uploads;
    for (const file of files) {
      if (entries.length >= 30
        || entries.reduce((n, e) => n + e.file.size, file.size) > 32 * 1024 * 1024) {
        this.toast('附件超过 30 个或 32 MiB，请减少文件', 'error'); break;
      }
      const name = file.name.normalize('NFKC').replace(/[\\/\x00-\x1f]/g, '_').slice(-160) || 'file';
      const extraPath = `deliveries/${this.detail.node.task.id}/v${this.detail.node.version}/${crypto.randomUUID()}/${name}`;
      const matches = (this.detail.node.requiredOutputs || []).filter(p => p.split('/').at(-1) === name);
      entries.push({ file, extraPath, path: matches.length === 1 ? matches[0] : extraPath,
        preview: isRaster(file.name) ? URL.createObjectURL(file) : null, uploaded: false, owned: false });
    }
    this.renderUploads();
  }
  renderUploads() {
    $('#graph-upload-list', this.drawer).innerHTML = this.detail.uploads.map((e, i) => `<article class="graph-attachment">${e.preview ? `<img src="${escape(e.preview)}" alt="${escape(e.file.name)}">` : '<span class="graph-file-icon">文件</span>'}<div>${escape(e.file.name)}<small>${e.file.size} B · ${e.uploaded ? '已就绪' : '待上传'}</small><label>交付到<select data-upload-target="${i}" ${e.uploaded || this.detail.submitting ? 'disabled' : ''}><option value="${escape(e.extraPath)}" ${e.path === e.extraPath ? 'selected' : ''}>新增附件</option>${(this.detail.node.requiredOutputs || []).map(p => `<option value="${escape(p)}" ${e.path === p ? 'selected' : ''}>必交：${escape(p)}</option>`).join('')}</select></label></div><button type="button" class="secondary" data-remove-upload="${i}" ${this.detail.submitting ? 'disabled' : ''}>移除</button></article>`).join('');
    all('[data-upload-target]', this.drawer).forEach(select => { select.onchange = () => {
      if (!this.detail.submitting && !this.detail.submissionBody) this.detail.uploads[Number(select.dataset.uploadTarget)].path = select.value;
    }; });
  }
  async checkDeliveryFiles() {
    const detail = this.detail;
    const form = $('#graph-submit-form', this.drawer);
    const outputs = String(new FormData(form).get('outputs') || '').split('\n').map(s => s.trim()).filter(Boolean);
    const { files } = await this.api(`/api/tasks/${this.detail.node.task.id}/delivery-files`, { method: 'POST', body: {
      taskVersion: this.detail.node.version, outputs: [...outputs, ...this.detail.uploads.filter(e => e.uploaded).map(e => e.path)] } });
    if (this.detail === detail && this.drawer.open) $('#graph-files-result', this.drawer).textContent = files.map(f => `${f.path} · ${f.size} B`).join('\n') || '没有工作区附件';
    return outputs;
  }
  async saveChecklist() {
    const { node } = this.detail;
    const { task } = await this.api(`/api/tasks/${node.task.id}/checklist`, { method: 'PATCH', body: {
      taskVersion: node.task.version, revision: node.task.checklistRevision,
      items: all('[data-item]', this.drawer).map((i) => ({ id: i.dataset.item, done: i.checked })) } });
    node.task = task; return task;
  }
  async submitDetail(form) {
    const detail = this.detail;
    const ensureCurrent = () => {
      if (this.detail !== detail || !this.drawer.open) throw new DOMException('已忽略过期任务提交', 'AbortError');
    };
    const data = new FormData(form); const button = $('button[type=submit]', form); button.disabled = true;
    detail.submitting = true;
    all('input,textarea,button,select', form).forEach(e => { e.disabled = true; });
    all('[data-item]', this.drawer).forEach(e => { e.disabled = true; });
    try {
      if (!detail.submissionBody) {
        const outputs = String(data.get('outputs') || '').split('\n').map(s => s.trim()).filter(Boolean);
        const { task: current } = await this.api(`/api/tasks/${detail.node.task.id}`);
        ensureCurrent();
        if (current.version !== detail.node.version || !['active', 'rework'].includes(current.status)) throw new Error('任务已变化，请刷新后提交。');
        if (!detail.uploads.length) await this.api(`/api/tasks/${current.id}/delivery-files`, { method: 'POST', body: { taskVersion: current.version, outputs } });
      }
      // Keep the same destination on retries; no duplicate uploads or submissions.
      ensureCurrent();
      for (const entry of detail.uploads) {
        ensureCurrent();
        if (entry.uploaded) continue;
        button.textContent = `正在上传 ${entry.file.name}…`;
        try {
          await this.api(`/api/projects/${detail.graph.projectId}/file?path=${encodeURIComponent(entry.path)}`, { method: 'PUT', body: entry.file });
          ensureCurrent(); entry.owned = true;
        } catch (error) {
          ensureCurrent();
          if (error.code !== 'FILE_EXISTS') throw error;
          const response = await sessionFetch(`/api/projects/${detail.graph.projectId}/raw?path=${encodeURIComponent(entry.path)}`, { credentials: 'same-origin' });
          ensureCurrent();
          if (!response.ok) throw error;
          const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await entry.file.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
          const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await response.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join('');
          if (actual !== hash) throw new Error('目标已存在且内容不同：请选择新增附件，或先在工作区处理该文件。');
        }
        ensureCurrent(); entry.uploaded = true; this.renderUploads();
      }
      button.textContent = '正在提交验收…';
      if (!detail.submissionBody) await this.api(`/api/tasks/${detail.node.task.id}/delivery-files`, { method: 'POST', body: {
        taskVersion: detail.node.version, outputs: [...String(data.get('outputs') || '').split('\n').map(s => s.trim()).filter(Boolean), ...detail.uploads.map(e => e.path)] } });
      ensureCurrent();
      const task = detail.submissionBody ? detail.node.task : await this.saveChecklist();
      ensureCurrent();
      detail.submissionKey ||= crypto.randomUUID();
      detail.submissionBody ||= {
        kind: detail.native ? 'codex' : 'manual', ...(detail.native || {}), taskVersion: task.version,
        inputRevision: detail.node.task.inputs?.revision || 0, checklistRevision: task.checklistRevision, idempotencyKey: detail.submissionKey, resultSummary: data.get('summary'),
        outputs: [...String(data.get('outputs') || '').split('\n').map((s) => s.trim()).filter(Boolean), ...detail.uploads.map(e => e.path)], note: data.get('note') };
      await this.api(`/api/tasks/${task.id}/submissions`, { method: 'POST', body: detail.submissionBody });
      ensureCurrent();
      detail.submitting = false; this.closeDetail(); this.toast('成果已提交，等待验收'); await this.refreshTasks();
    } catch (error) {
      if (error.status && error.status < 500) detail.submissionBody = null;
      throw error;
    } finally {
      detail.submitting = false;
      if (this.detail === detail && this.drawer.open) {
        all('input,textarea,button,select', form).forEach(e => { e.disabled = Boolean(detail.submissionBody); });
        all('[data-upload-target]', form).forEach(e => { e.disabled ||= detail.uploads[Number(e.dataset.uploadTarget)].uploaded; });
        all('[data-item]', this.drawer).forEach(e => { e.disabled = Boolean(detail.submissionBody); });
        button.disabled = false; button.textContent = detail.submissionBody ? '确认提交结果（重试）' : '提交验收';
      }
    }
  }
  async drawerAction(event) {
    const button = event.target.closest('button'); if (!button) return;
    if (this.detail?.submitting) return;
    if (button.hasAttribute('data-close-drawer')) this.closeDetail();
    else if (button.hasAttribute('data-check-files')) await this.checkDeliveryFiles();
    else if (button.hasAttribute('data-remove-upload')) {
      const detail = this.detail;
      if (this.detail.submissionBody) return;
      const index = Number(button.dataset.removeUpload); const entry = this.detail.uploads[index];
      if (entry.uploaded && entry.owned) await this.api(`/api/projects/${this.detail.graph.projectId}/file?path=${encodeURIComponent(entry.path)}`, { method: 'DELETE' });
      if (this.detail !== detail || !this.drawer.open) return;
      if (entry.preview) URL.revokeObjectURL(entry.preview);
      this.detail.uploads.splice(index, 1); this.detail.submissionBody = null; this.renderUploads();
    }
    else if (button.hasAttribute('data-save-checklist')) {
      const detail = this.detail; await this.saveChecklist();
      if (this.detail === detail && this.drawer.open) this.toast('清单已保存');
    }
    else if (button.hasAttribute('data-open-task')) { const id = this.detail.node.task.id; this.closeDetail(false); await this.openTaskChat(id); }
    else if (button.dataset.openOutput) { const id = this.detail.graph.projectId; this.closeDetail(); await this.openFile(id, button.dataset.openOutput); }
    else if (button.dataset.previewInput) {
      const detail = this.detail; const request = Symbol(); detail.previewRequest = request;
      const endpoint = `/api/tasks/${detail.node.task.id}/inputs/${encodeURIComponent(button.dataset.previewInput)}?revision=${detail.node.task.inputs.revision}`;
      const { file } = await this.api(endpoint);
      if (this.detail !== detail || !this.drawer.open || detail.previewRequest !== request) return;
      let preview = $('#graph-artifact-preview', this.drawer);
      if (!preview) { preview = document.createElement('section'); preview.id = 'graph-artifact-preview'; this.drawer.append(preview); }
      preview.innerHTML = `<h3>${escape(file.name || file.path)}</h3><pre class="graph-preserve">${escape(file.content || '未提取正文，请下载查看。压缩包内容尚未分析。')}</pre>`;
      preview.scrollIntoView({ block: 'nearest' });
    }
    else if (button.dataset.previewSubmission) {
      const detail = this.detail; const request = Symbol(); detail.previewRequest = request;
      const endpoint = sessionUrl(`/api/task-submissions/${encodeURIComponent(button.dataset.previewSubmission)}/artifact?path=${encodeURIComponent(button.dataset.path)}`);
      const { file } = await this.api(endpoint);
      if (this.detail !== detail || !this.drawer.open || detail.previewRequest !== request) return;
      let preview = $('#graph-artifact-preview', this.drawer);
      if (!preview) { preview = document.createElement('section'); preview.id = 'graph-artifact-preview'; this.drawer.append(preview); }
      preview.innerHTML = `<h3>${escape(file.path)} · 固定提交版本</h3><a class="text-link" href="${escape(endpoint)}&download=1" download>下载成果</a><pre class="graph-preserve">${escape(file.content ?? '此文件请下载查看。')}</pre>`;
      preview.scrollIntoView({ block: 'nearest' });
    }
    else if (button.dataset.verdict) {
      const detail = this.detail; const { node } = detail; const submission = node.submissions.find((s) => s.taskVersion === node.version && s.verdict === 'pending');
      detail.reviewing = true;
      button.disabled = true;
      try { await this.api(`/api/admin/task-submissions/${submission.id}/review`, { method: 'POST', body: {
        verdict: button.dataset.verdict, expectedVersion: node.version, feedback: $('#graph-review-feedback').value } });
      if (this.detail !== detail || !this.drawer.open) return;
      this.closeDetail(); await this.refresh(); this.toast('验收结果已保存'); }
      finally { detail.reviewing = false; button.disabled = false; }
    }
  }
  editPlan() {
    this.clearDetail();
    const epoch = this.detailEpoch;
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
        n.reviewMode = $('[name=nodeReviewMode]', field).value || null;
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
        <label>本节点验收<select name="nodeReviewMode"><option value="" ${!n.reviewMode ? 'selected' : ''}>继承默认方式</option><option value="manual" ${n.reviewMode === 'manual' ? 'selected' : ''}>老板人工审核</option><option value="auto" ${n.reviewMode === 'auto' ? 'selected' : ''}>AI 自动审核 · 推进 / 打回</option><option value="assisted" ${n.reviewMode === 'assisted' ? 'selected' : ''}>老板审核 · AI 提供意见</option></select></label>
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
          if (epoch !== this.detailEpoch || !this.drawer.open) return;
          this.closeDetail(); await this.refresh();
        } catch (error) { $('.form-error', form).textContent = error.message; }
        finally { button.disabled = false; }
      };
    };
    render(); if (!this.drawer.open) this.drawer.showModal();
  }
}
