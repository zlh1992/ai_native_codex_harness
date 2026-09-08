import { WorkGraphUI } from './work-graph.js';

const bossWorkbench = location.pathname === '/boss/workbench' || new URLSearchParams(location.search).get('workbench') === '1';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  me: null, csrf: '', projects: [], chats: [], selectedProject: null, selectedChat: null,
  selectedFile: null, selectedFileInfo: null, fileEntries: [], fileContent: null, viewerMode: 'preview',
  runningTurns: new Map(), maxConcurrentTurns: 11, tasks: [], selectedTask: null,
  codexCapacity: null, pendingSubmission: null, pendingUpload: null,
  pendingTextAction: null, pendingConfirmAction: null,
  eventCursors: new Map(), inputQueues: new Map(), queueRuns: new Map(),
  queueRefreshing: false, queueHistoryPending: false, queueSending: false, queueEdit: null, pendingInput: null,
  memories: [], memoryStatus: null,
};
const workGraphUI = new WorkGraphUI({ api, toast, openTask, refreshTasks: loadTasks,
  openFile: async (projectId, relative) => {
    if (!state.projects.some((p) => p.id === projectId)) await loadProjects();
    await selectProject(state.projects.find((p) => p.id === projectId));
    switchView('workbench'); await openFile(relative);
  } });

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

function formatDate(value, compact = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', compact ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function markdown(value) {
  const escaped = escapeHtml(value);
  const blocks = [];
  const held = escaped.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.push(`<pre data-language="${language.trim()}"><code>${code}</code></pre>`) - 1;
    return `\n@@CODE${index}@@\n`;
  });
  let html = held.split(/\n{2,}/).map((paragraph) => {
    const code = paragraph.match(/^@@CODE(\d+)@@$/);
    if (code) return blocks[Number(code[1])];
    let line = paragraph.replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>')
      .replace(/^# (.+)$/gm, '<h2>$1</h2>').replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    return `<p>${line}</p>`;
  }).join('');
  return html.replace(/@@CODE(\d+)@@/g, (_, index) => blocks[Number(index)]);
}

function toast(message, kind = '') {
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  $('#toast-stack').append(element);
  setTimeout(() => element.remove(), 4200);
}

function openTextDialog({ eyebrow, title, label, value, submitLabel, onSubmit, multiline = false }) {
  const form = $('#text-form');
  form.reset();
  $('.form-error', form).textContent = '';
  $('#text-dialog-eyebrow').textContent = eyebrow;
  $('#text-dialog-title').textContent = title;
  $('#text-dialog-label').textContent = label;
  const input = $('#text-dialog-input'); const textarea = $('#text-dialog-textarea');
  input.hidden = multiline; input.required = !multiline; input.name = multiline ? '' : 'value';
  textarea.hidden = !multiline; textarea.required = multiline; textarea.name = multiline ? 'value' : '';
  const field = multiline ? textarea : input;
  field.value = value;
  $('#text-dialog-submit').textContent = submitLabel;
  state.pendingTextAction = onSubmit;
  $('#text-dialog').showModal();
  field.focus();
  field.select();
}

function openConfirmDialog({ eyebrow, title, message, submitLabel, onConfirm }) {
  const form = $('#confirm-form');
  $('.form-error', form).textContent = '';
  $('#confirm-dialog-eyebrow').textContent = eyebrow;
  $('#confirm-dialog-title').textContent = title;
  $('#confirm-dialog-message').textContent = message;
  $('#confirm-dialog-submit').textContent = submitLabel;
  state.pendingConfirmAction = onConfirm;
  $('#confirm-dialog').showModal();
}

async function recoverThread(recovery, action) {
  recovery.disabled = true;
  try {
    const data = await api(`/api/chats/${state.selectedChat.id}/thread/recover`, {
      method: 'POST', body: { action, acknowledgeHistoryBreak: action === 'reset' },
    });
    state.selectedChat = data.chat;
    const local = state.chats.find((chat) => chat.id === data.chat.id); if (local) Object.assign(local, data.chat);
    toast(action === 'retry' ? '原线程已恢复。' : '已建立新线程，原映射已记录。');
    await selectChat(state.selectedChat);
  } catch (error) {
    recovery.disabled = false;
    throw error;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof ArrayBuffer) && !(options.body instanceof Blob) && typeof options.body !== 'string') {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET') headers.set('x-csrf-token', state.csrf);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showLogin() {
  if (bossWorkbench) { location.replace('/boss/login'); return; }
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  state.me = null; state.inputQueues.clear(); state.queueRuns.clear(); state.runningTurns.clear();
  state.pendingInput = null; state.queueEdit = null;
}

function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  requestAnimationFrame(clampPanelSizes);
}

async function health() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    $('#login-health').textContent = data.initialized ? (data.codex ? '本机 Codex 在线' : '服务在线，Codex 正在启动') : '等待创建超级管理员';
    $('.status-pill').classList.toggle('online', Boolean(data.codex));
  } catch { $('#login-health').textContent = '无法连接本机服务'; }
}

async function bootstrap() {
  let data;
  try {
    data = await api('/api/me');
  } catch (error) {
    showLogin();
    if (error.status !== 401) $('#login-error').textContent = `无法验证登录状态：${error.message}`;
    return;
  }

  state.me = data.user;
  state.csrf = data.csrfToken;
  if (data.user.role === 'user' && bossWorkbench) { location.replace('/employee'); return; }
  if (data.user.role === 'admin' && !bossWorkbench) {
    location.replace('/boss');
    return;
  }
  showApp();
  document.title = bossWorkbench ? '老板工作台 · Codex Harness' : '员工工作台 · Codex Harness';
  $('#user-chip').textContent = `${data.user.displayName} · ${data.user.role === 'admin' ? '超级管理员' : data.user.username}`;
  $('#model-badge').textContent = data.model;
  $('#model-badge').classList.toggle('hidden', data.user.role === 'admin');
  $('#model-select').classList.toggle('hidden', data.user.role !== 'admin');
  $('#model-select').replaceChildren(...[{ id: '', label: `默认 · ${data.model}` }, ...(data.models || [])].map((model) => new Option(model.label, model.id)));
  updateModelSelect();
  $('#codex-status').classList.toggle('online', data.codex.ready);
  $('#boss-nav').classList.toggle('hidden', data.user.role !== 'admin');
  state.codexCapacity = data.codex;
  state.memoryStatus = data.memory;
  state.maxConcurrentTurns = data.codex.maxRootTurns || 11;
  updateConcurrencyIndicator();
  updateCapacity(data.codex);
  $('#effort-select').innerHTML = data.efforts.map((value) => `<option value="${value}" ${value === data.defaultEffort ? 'selected' : ''}>${value}</option>`).join('');
  updateUsage(data.usage, data.user.maxStorageBytes);

  const requestedProject = new URLSearchParams(location.search).get('project');
  try {
    await Promise.all([loadProjects(), loadTasks()]);
    if (data.workGraphEnabled !== false) await workGraphUI.initialize(data.user, state.projects);
    const selected = requestedProject && state.projects.find((project) => project.id === requestedProject);
    if (selected) { await selectProject(selected); switchView('workbench'); }
    else switchView('tasks');
  } catch (error) {
    // api() already handles an actual expired session. Other failures must not
    // masquerade as a login failure and discard the authenticated UI state.
    if (error.status === 401) return;
    if (requestedProject) switchView('workbench');
    toast(`工作台加载失败：${error.message}`, 'error');
  }
}

function updateUsage(usage, quota) {
  $('#storage-label').textContent = `${formatBytes(usage?.bytes)} / ${formatBytes(quota)}`;
  $('#storage-meter').style.width = `${Math.min(100, Number(usage?.bytes || 0) / Number(quota || 1) * 100)}%`;
}

function updateCapacity(capacity = state.codexCapacity || {}) {
  state.codexCapacity = { ...(state.codexCapacity || {}), ...capacity };
  $('#execute-capacity').textContent = `${state.codexCapacity.activeExecuteLeases || 0} / ${state.codexCapacity.maxExecuteLeases || 11}`;
}

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  renderTasks();
  if (workGraphUI.initialized && state.me?.role === 'admin') await workGraphUI.refresh();
}

async function loadMemories() {
  const data = await api('/api/memories');
  state.memories = data.memories || []; state.memoryStatus = data.status;
  const index = data.status?.index;
  $('#memory-index-state').textContent = index?.available ? '索引进程已启动' : '关键词搜索降级';
  $('#memory-index-state').classList.toggle('online', Boolean(index?.available));
  const root = $('#memory-list');
  if (!state.memories.length) { root.className = 'memory-list empty-state'; root.textContent = '暂无记忆。可手动添加，或让 Codex 在对话中搜索、新增、修改和删除记忆；工具成功后会显示在这里。'; return; }
  root.className = 'memory-list';
  root.innerHTML = state.memories.map((item) => `<article class="memory-card" data-id="${item.id}" data-version="${item.version}">
    <header><span class="memory-source">${item.sourceKind === 'manual' ? '手动添加' : '来自对话'} · V${item.version} · ${formatDate(item.updatedAt, true)}</span>
    <span class="memory-card-actions"><button class="secondary" data-memory-edit>编辑</button><button class="danger-button" data-memory-delete>删除</button></span></header>
    <p>${escapeHtml(item.body)}</p></article>`).join('');
}

async function refreshChatMemory(turnRunId = null) {
  const chat = state.selectedChat;
  $('#use-memory').disabled = !chat; $('#save-memory').disabled = !chat;
  if (!chat) { $('#memory-ref-panel').classList.add('hidden'); updateInsightsVisibility(); return; }
  const data = await api(`/api/chats/${chat.id}/memory`);
  if (state.selectedChat?.id !== chat.id) return;
  $('#use-memory').checked = data.settings.useMemory; $('#save-memory').checked = data.settings.saveMemory;
  const refs = (data.references || []).filter((ref) => !turnRunId || ref.turnRunId === turnRunId);
  const panel = $('#memory-ref-panel');
  panel.classList.toggle('hidden', !refs.length);
  $('div', panel).innerHTML = refs.map((ref) => `<article class="memory-ref"><small>${ref.crossProject ? '跨项目引用' : '当前项目 / 全局记忆'} · V${ref.memoryVersion}</small><p>${ref.available ? escapeHtml(ref.body) : '来源权限已失效或记忆已删除；继续前需重置线程。'}</p></article>`).join('');
  updateInsightsVisibility();
}

function taskStatusLabel(status) {
  return ({ draft: '草稿', ready: '等待前序', active: '进行中', submitted: '待老板验收', passed: '已通过', rework: '需返工' })[status] || status;
}

function renderTasks() {
  if (workGraphUI.initialized && state.me?.role === 'admin') return;
  const active = state.tasks.filter((task) => ['active', 'rework'].includes(task.status)).length;
  $('#task-active-count').textContent = String(active);
  $('#task-submitted-count').textContent = String(state.tasks.filter((task) => task.status === 'submitted').length);
  $('#task-passed-count').textContent = String(state.tasks.filter((task) => task.status === 'passed').length);
  $('#visible-project-count').textContent = String(state.projects.length);
  const root = $('#task-list');
  if (!state.tasks.length) {
    root.className = 'task-board empty-state';
    root.textContent = '老板尚未分配任务。你仍可在工作台处理自己的项目。';
    return;
  }
  root.className = 'task-board';
  root.innerHTML = state.tasks.map((task) => {
    const actionable = ['active', 'rework'].includes(task.status) && (!task.workflowRunId || task.workflowStatus === 'running');
    return `<article class="task-card status-${task.status}">
      <div class="task-card-top"><span class="status-tag ${task.status}">${escapeHtml(taskStatusLabel(task.status))}</span><span>V${task.version} · #${task.position + 1}</span></div>
      <p class="eyebrow">${escapeHtml(task.roadmapTitle || 'DIRECT TASK')} · ${escapeHtml(task.projectName)}</p>
      <h3>${escapeHtml(task.title)}</h3>
      <div class="acceptance"><b>验收标准</b><p>${escapeHtml(task.acceptance)}</p></div>
      <div class="task-card-foot"><span>${formatDate(task.updatedAt, true)}</span>${task.workflowRunId ? `<button class="secondary task-inspect" data-id="${task.id}">清单 / 交付</button>` : ''}${actionable ? `<button class="primary task-open" data-id="${task.id}">${task.status === 'rework' ? '继续返工' : '进入任务'}</button>` : ''}</div>
    </article>`;
  }).join('');
  $$('.task-open', root).forEach((button) => button.addEventListener('click', () => openTask(button.dataset.id)));
  $$('.task-inspect', root).forEach((button) => button.addEventListener('click', () => workGraphUI.inspect(state.tasks.find((t) => t.id === button.dataset.id)).catch((e) => toast(e.message, 'error'))));
}

async function openTask(taskId) {
  try {
    const data = await api(`/api/tasks/${taskId}/chat`, { method: 'POST' });
    state.selectedTask = data.task;
    let project = state.projects.find((item) => item.id === data.project.id);
    if (!project) { await loadProjects(); project = state.projects.find((item) => item.id === data.project.id); }
    await selectProject(project);
    await selectChat(data.chat);
    switchView('workbench');
  } catch (error) { toast(error.message, 'error'); await loadTasks(); }
}

async function loadProjects() {
  const data = await api('/api/projects');
  state.projects = data.projects;
  await workGraphUI.updateProjects(state.projects);
  renderProjects();
  if (state.tasks) renderTasks();
  if (state.selectedProject) {
    const refreshed = state.projects.find((item) => item.id === state.selectedProject.id);
    if (refreshed) await selectProject(refreshed, false);
    else resetProject();
  }
}

function renderProjects() {
  const root = $('#project-list');
  if (!state.projects.length) { root.className = 'project-list empty-state'; root.textContent = '还没有项目，点击 ＋ 创建'; return; }
  root.className = 'project-list';
  root.innerHTML = state.projects.map((project) => `<button class="project-item ${state.selectedProject?.id === project.id ? 'active' : ''}" data-id="${project.id}"><b><i class="project-dot"></i>${escapeHtml(project.name)}</b><span>${project.accessKind === 'shared' ? '共享给我 · ' : ''}${escapeHtml(project.description || project.slug)}</span></button>`).join('');
  $$('.project-item', root).forEach((button) => button.addEventListener('click', () => selectProject(state.projects.find((item) => item.id === button.dataset.id))));
}

async function selectProject(project, clearChat = true) {
  if (!project) return toast('项目授权已失效，请刷新任务列表。', 'error');
  state.selectedProject = project;
  if (clearChat) { state.selectedChat = null; state.selectedTask = null; }
  closeViewer();
  renderProjects();
  $('#project-kicker').textContent = project.username ? `${project.username.toUpperCase()} / ${project.slug}` : project.slug;
  $('#chat-title').textContent = project.name;
  await Promise.all([loadChats(), loadFiles(), refreshUsage()]);
  if (clearChat) { renderMessages([]); await refreshChatMemory(); }
}

function resetProject() {
  state.selectedProject = null; state.selectedChat = null; state.selectedTask = null; closeViewer();
  renderProjects(); renderChats(); renderMessages([]);
  refreshChatMemory();
  $('#file-tree').className = 'file-tree empty-state'; $('#file-tree').textContent = '选择项目后浏览文件';
}

async function refreshUsage() {
  if (!state.selectedProject) return;
  const data = await api(`/api/projects/${state.selectedProject.id}`);
  updateUsage(data.usage, state.me.maxStorageBytes);
}

async function loadChats() {
  if (!state.selectedProject) return renderChats();
  const data = await api(`/api/projects/${state.selectedProject.id}/chats`);
  state.chats = data.chats;
  renderChats();
}

function renderChats() {
  updateModelSelect();
  const root = $('#chat-list');
  if (!state.selectedProject) { root.className = 'chat-list empty-state'; root.textContent = '请先选择项目'; return; }
  if (!state.chats.length) { root.className = 'chat-list empty-state'; root.textContent = '点击 ＋ 开始第一段对话'; return; }
  root.className = 'chat-list';
  root.innerHTML = state.chats.map((chat) => {
    const running = state.runningTurns.has(chat.id) || chat.status === 'running';
    return `<button class="chat-item ${state.selectedChat?.id === chat.id ? 'active' : ''} ${running ? 'running' : ''}" data-id="${chat.id}"><b>${running ? '<i class="run-dot">●</i> ' : ''}${escapeHtml(chat.title)}</b><span>${running ? '正在运行 · ' : ''}${chat.sharedAt ? '共享时的独立副本 · ' : ''}${formatDate(chat.updatedAt, true)}</span></button>`;
  }).join('');
  $$('.chat-item', root).forEach((button) => button.addEventListener('click', () => selectChat(state.chats.find((item) => item.id === button.dataset.id))));
}

function shouldAppendLivePrompt(messages, entry) {
  const prompt = String(entry?.prompt || '');
  return Boolean(prompt.trim())
    && !messages.some((message) => message.role === 'user' && message.content === prompt);
}

async function selectChat(chat) {
  state.selectedChat = chat;
  renderChats();
  $('#chat-title').textContent = chat.title;
  const data = await api(`/api/chats/${chat.id}`);
  if (state.selectedChat?.id !== chat.id) return;
  state.selectedChat = data.chat;
  $('#mode-select').value = data.chat.preferredMode || 'execute';
  updateModelSelect();
  state.selectedTask = data.task || null;
  state.eventCursors.set(chat.id, Number(data.latestEventId || 0));
  renderMessages(data.messages);
  let running = state.runningTurns.get(chat.id);
  if (!running && ['queued', 'starting', 'running'].includes(data.latestTurnRun?.status)) {
    running = await resumePersistedTurn(data);
  }
  if (running) renderLiveTurn(running, shouldAppendLivePrompt(data.messages, running));
  renderActivity(running);
  await Promise.all([refreshTurnInsights(), refreshChatMemory(data.latestTurnRun?.id || null)]);
  setComposer(true);
  await refreshInputQueue();
}

function renderMessages(messages) {
  const root = $('#message-list');
  if (!messages.length) {
    root.innerHTML = `<div class="welcome-message"><span class="mark">C</span><h3>${state.selectedProject ? '准备开始构建。' : '从一个项目开始。'}</h3><p>${state.selectedProject ? '描述目标、错误或想修改的功能，Codex 会直接在这个隔离项目中工作。' : '创建或选择项目，再新建对话。Codex 会在隔离的本机目录中读取、编写和验证代码。'}</p></div>`;
  } else {
    root.innerHTML = messages.map(messageHtml).join('');
    const snapshot = [...messages].reverse().find((message) => message.role === 'assistant' && message.metadata);
    renderPlanDiff(snapshot?.metadata?.plan || [], snapshot?.metadata?.diffSnapshot || '');
  }
  if (state.selectedChat?.threadState === 'resume_failed') {
    root.insertAdjacentHTML('afterbegin', `<article class="message error thread-recovery"><div class="message-label">THREAD RECOVERY</div><div class="message-body"><p>原 Codex 线程暂时无法恢复，映射和本地历史均已保留。</p><small>${escapeHtml(state.selectedChat.threadError || '')}</small><div class="message-actions"><button class="secondary" data-thread-recovery="retry">重试原线程</button><button class="danger-button" data-thread-recovery="reset">确认并新建空白线程</button></div></div></article>`);
  }
  root.scrollTop = root.scrollHeight;
}

function messageHtml(message) {
  if (message.role === 'event') {
    const result = message.metadata?.result;
    return `<div class="message event"><div class="tool-event">↳ ${escapeHtml(message.content)} ${result?.exitCode !== undefined ? `· exit ${escapeHtml(result.exitCode)}` : ''}</div></div>`;
  }
  const label = message.role === 'user' ? 'YOU' : message.role === 'error' ? 'ERROR' : 'CODEX';
  const canSubmit = message.role === 'assistant' && message.metadata?.turnRunId && message.metadata?.finalItemId
    && state.selectedTask && message.metadata.taskId === state.selectedTask.id
    && message.metadata.taskVersion === state.selectedTask.version && ['active', 'rework'].includes(state.selectedTask.status);
  const action = canSubmit ? `<div class="message-actions"><button class="submit-task-button" data-turn-run-id="${escapeHtml(message.metadata.turnRunId)}" data-item-id="${escapeHtml(message.metadata.finalItemId)}" data-task-version="${escapeHtml(message.metadata.taskVersion)}">提交任务 Done</button></div>` : '';
  return `<article class="message ${message.role}"><div class="message-label">${label}</div><div class="message-body">${markdown(message.content)}</div>${action}</article>`;
}

function appendMessage(role, content = '') {
  const root = $('#message-list');
  $('.welcome-message', root)?.remove();
  const article = document.createElement('article');
  article.className = `message ${role}`;
  article.innerHTML = `<div class="message-label">${role === 'user' ? 'YOU' : role === 'error' ? 'ERROR' : 'CODEX'}</div><div class="message-body"></div>`;
  $('.message-body', article).innerHTML = markdown(content);
  root.append(article); root.scrollTop = root.scrollHeight;
  return article;
}

function updateConcurrencyIndicator() {
  const active = state.runningTurns.size;
  $('#codex-status').innerHTML = `<i></i> Codex · ${active}/${state.maxConcurrentTurns}`;
}

function selectedChatRunning() {
  return Boolean(state.selectedChat && (state.runningTurns.has(state.selectedChat.id) || state.selectedChat.status === 'running'));
}

function setComposer(enabled) {
  const usable = enabled && Boolean(state.selectedChat)
    && state.selectedChat.threadState !== 'resume_failed';
  $('#prompt-input').disabled = !usable;
  $('#send-button').disabled = !usable || state.queueSending;
  $('#send-button').setAttribute('aria-label', selectedChatRunning() ? '加入消息队列' : '发送消息');
  $('#prompt-input').placeholder = selectedChatRunning() ? '继续输入，发送后排队…' : '告诉 Codex 你想构建什么…';
  renderInputQueue();
  $('#stop-turn').classList.toggle('hidden', !selectedChatRunning());
  $('#composer-context').textContent = state.selectedChat
    ? `${state.selectedProject.name} · ${state.selectedChat.title}${state.selectedTask ? ` · 任务 V${state.selectedTask.version}` : ''}${selectedChatRunning() ? ' · 运行中 · 发送后排队，可调整当前方向' : ''}`
    : '选择一个对话后即可开始';
}

function renderLiveTurn(entry, includePrompt = false) {
  if (state.selectedChat?.id !== entry.chatId) return null;
  if (includePrompt) appendMessage('user', entry.prompt);
  let assistant = $(`[data-live-chat="${CSS.escape(entry.chatId)}"]`);
  if (!assistant) {
    assistant = appendMessage('assistant', entry.text);
    assistant.dataset.liveChat = entry.chatId;
  }
  $('.message-body', assistant).innerHTML = markdown(entry.text || '…');
  $('#message-list').scrollTop = $('#message-list').scrollHeight;
  return assistant;
}

function renderActivity(entry) {
  const strip = $('#activity-strip');
  if (!entry || state.selectedChat?.id !== entry.chatId) {
    strip.classList.add('hidden'); strip.innerHTML = ''; return;
  }
  strip.classList.remove('hidden');
  strip.innerHTML = `<div class="activity-line"><i>●</i><span>${escapeHtml(entry.statusText || 'Codex 正在思考…')}</span></div>${entry.events.map((event) => `<div class="activity-line"><i>${event.done ? '✓' : '↳'}</i><span>${escapeHtml(event.name)}</span></div>`).join('')}`;
}

function updateInsightsVisibility() {
  const visible = !$('#goal-card').classList.contains('hidden') || $('#approval-list').children.length
    || !$('#plan-panel').classList.contains('hidden') || !$('#diff-panel').classList.contains('hidden')
    || !$('#memory-ref-panel').classList.contains('hidden');
  $('#turn-insights').classList.toggle('hidden', !visible);
}

function renderPlanDiff(plan = [], diff = '') {
  const planPanel = $('#plan-panel');
  planPanel.classList.toggle('hidden', !plan.length);
  $('div', planPanel).innerHTML = plan.map((item) => `<p><i class="plan-${escapeHtml(item.status)}"></i><span>${escapeHtml(item.step)}</span><b>${escapeHtml(item.status)}</b></p>`).join('');
  const diffPanel = $('#diff-panel');
  diffPanel.classList.toggle('hidden', !diff);
  $('pre', diffPanel).textContent = diff;
  updateInsightsVisibility();
}

function renderApprovals(approvals = []) {
  const root = $('#approval-list');
  root.innerHTML = approvals.map((approval) => {
    const request = approval.request || {};
    return `<article class="approval-card" data-id="${escapeHtml(approval.id || approval.approvalId)}">
      <div><span class="status-tag rework">等待批准</span><b>${approval.kind === 'file' ? '文件修改' : '命令执行'}</b></div>
      ${request.reason ? `<p>${escapeHtml(request.reason)}</p>` : ''}
      ${Array.isArray(request.files) && request.files.length ? `<small>目标文件</small><pre>${escapeHtml(request.files.join('\n'))}</pre>` : ''}
      ${request.command ? `<pre>${escapeHtml(request.command)}</pre>` : ''}
      ${request.cwd ? `<small>cwd · ${escapeHtml(request.cwd)}</small>` : ''}
      <div class="approval-actions"><button data-decision="decline" class="secondary">拒绝</button><button data-decision="accept" class="primary">批准一次</button></div>
    </article>`;
  }).join('');
  updateInsightsVisibility();
}

async function refreshTurnInsights() {
  if (!state.selectedChat) {
    $('#goal-card').classList.add('hidden'); renderApprovals([]); updateInsightsVisibility(); return;
  }
  const chatId = state.selectedChat.id;
  try {
    const [goalData, approvalData] = await Promise.all([
      api(`/api/chats/${chatId}/goal`), api(`/api/chats/${chatId}/approvals`),
    ]);
    if (state.selectedChat?.id !== chatId) return;
    const goal = goalData.goal;
    const card = $('#goal-card');
    card.classList.toggle('hidden', !goal && !state.selectedTask);
    if (goal || state.selectedTask) card.innerHTML = `<p class="eyebrow">CODEX GOAL · ${escapeHtml(goal?.status || '等待同步')}</p><b>${escapeHtml(state.selectedTask?.title || goal?.objective || '')}</b><p>${escapeHtml(state.selectedTask?.acceptance || goal?.objective || '')}</p><small>Goal 完成不等于任务通过；仍需从最终回复提交快照并等待老板验收。</small>`;
    renderApprovals(approvalData.approvals || []);
    updateInsightsVisibility();
  } catch (error) { toast(error.message, 'error'); }
}

function applyJournalEvent(entry, event) {
  const data = event.payload || {};
  if (event.eventType === 'assistant_delta') entry.text += data.delta || '';
  else if (event.eventType === 'diff_updated' && typeof data.diff === 'string') entry.diff = data.diff;
  else if (event.eventType === 'input_steered') void refreshInputQueue({ history: true });
  else if (event.eventType === 'plan_updated') entry.plan = data.plan || [];
  else if (event.eventType === 'turn_queued') entry.statusText = `${data.mode || entry.mode.toUpperCase()} 正在排队 · 前方 ${Math.max(0, Number(data.position || 1) - 1)} 个任务`;
  else if (event.eventType === 'turn_status') entry.statusText = data.status === 'running' ? `Codex 正在执行 · ${entry.mode.toUpperCase()}` : 'Codex 正在启动…';
  else if (event.eventType === 'tool_started') {
    const existing = entry.events.find((item) => item.callId === data.callId);
    if (existing) Object.assign(existing, { name: data.name || existing.name, toolName: data.name, done: false });
    else entry.events.push({ callId: data.callId, name: data.name || '工具调用', toolName: data.name, done: false });
  } else if (event.eventType === 'tool_completed') {
    const tool = entry.events.find((item) => item.callId === data.callId);
    if (tool) Object.assign(tool, { done: true, name: data.name || tool.name, toolName: data.name || tool.toolName });
    else entry.events.push({ callId: data.callId, name: data.name || '工具调用', done: true });
  } else if (event.eventType === 'approval_required') {
    entry.statusText = '等待你批准操作…';
  } else if (event.eventType === 'approval_resolved') {
    entry.statusText = 'Codex 继续执行…';
  } else if (event.eventType === 'subagent_updated') {
    const callId = data.item?.id || `subagent:${event.id}`;
    const existing = entry.events.find((item) => item.callId === callId);
    const value = { callId, name: `子代理 ${data.count || 0}/${data.limit || 3} · ${data.model || 'gpt-5.6-luna'}`, done: data.phase === 'completed' };
    if (existing) Object.assign(existing, value); else entry.events.push(value);
  } else if (event.eventType === 'native_item') {
    const callId = data.item?.id || `native:${event.id}`;
    const existing = entry.events.find((item) => item.callId === callId);
    const value = { callId, name: existing?.toolName || data.item?.type || '原生操作', done: data.phase === 'completed' };
    if (existing) Object.assign(existing, value); else entry.events.push(value);
  } else if (event.eventType === 'turn_error') {
    entry.statusText = data.message || 'Codex 任务已中断';
    entry.terminalStatus = data.status || 'failed';
  } else if (event.eventType === 'turn_completed') {
    entry.statusText = 'Codex 已完成';
    entry.terminalStatus = data.status || 'completed';
  }
}

async function recoverTurnJournal(entry, { fullRun = false } = {}) {
  let cursor = fullRun ? 0 : Number(entry.lastEventId || 0);
  let latestEventId = cursor;
  let data = null;
  do {
    data = await api(`/api/chats/${entry.chatId}/events?after=${cursor}&limit=5000`);
    const page = data.events || [];
    latestEventId = Math.max(latestEventId, Number(data.latestEventId || 0));
    for (const event of page) {
      cursor = Math.max(cursor, Number(event.id || 0));
      if (entry.turnRunId && event.turnRunId !== entry.turnRunId) continue;
      if (!entry.turnRunId) entry.turnRunId = event.turnRunId;
      applyJournalEvent(entry, event);
    }
    if (!page.length) break;
  } while (cursor < latestEventId);
  entry.lastEventId = Math.max(Number(entry.lastEventId || 0), cursor);
  if (data.latestTurnRun && (!entry.turnRunId || data.latestTurnRun.id === entry.turnRunId)) {
    entry.turnRunId = data.latestTurnRun.id;
    entry.plan = data.latestTurnRun.plan || entry.plan;
    entry.diff = data.latestTurnRun.diffSnapshot || '';
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(data.latestTurnRun.status)) entry.terminalStatus = data.latestTurnRun.status;
  }
  state.eventCursors.set(entry.chatId, Math.max(latestEventId, Number(entry.lastEventId || 0)));
  if (state.selectedChat?.id === entry.chatId) {
    renderLiveTurn(entry);
    renderActivity(entry);
    renderPlanDiff(entry.plan, entry.diff);
  }
  return data;
}

async function resumePersistedTurn(chatData) {
  const run = chatData.latestTurnRun;
  if (!run || state.runningTurns.has(chatData.chat.id)) return state.runningTurns.get(chatData.chat.id) || null;
  const entry = {
    chatId: chatData.chat.id, projectId: chatData.chat.projectId, prompt: '', mode: run.mode || chatData.chat.preferredMode || 'execute', text: '',
    events: [], approvals: [], plan: [], diff: '', statusText: '正在恢复任务事件…', lastEventId: 0,
    turnRunId: run.id, recovered: true,
  };
  state.runningTurns.set(entry.chatId, entry);
  try { await recoverTurnJournal(entry, { fullRun: true }); }
  catch (error) { state.runningTurns.delete(entry.chatId); state.queueRuns.delete(entry.chatId); throw error; }
  void (async () => {
    try {
      const backoff = [1000, 2000, 5000];
      let attempt = 0;
      while (state.runningTurns.get(entry.chatId) === entry && !entry.terminalStatus) {
        try {
          const response = await fetch(`/api/chats/${entry.chatId}/turn-runs/${entry.turnRunId}/events?after=${entry.lastEventId}`, {
            credentials: 'same-origin', headers: { 'last-event-id': String(entry.lastEventId || 0) },
          });
          if (!response.ok || !response.body) {
            const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
            const error = new Error(payload?.error?.message || `事件恢复失败 (${response.status})`);
            error.status = response.status; throw error;
          }
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!entry.terminalStatus) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split('\n\n'); buffer = frames.pop() || '';
            for (const frame of frames) {
              let id = null; let eventType = 'message'; let payload = null;
              for (const line of frame.split('\n')) {
                if (line.startsWith('id:')) id = Number(line.slice(3).trim());
                if (line.startsWith('event:')) eventType = line.slice(6).trim();
                if (line.startsWith('data:')) { try { payload = JSON.parse(line.slice(5)); } catch { payload = {}; } }
              }
              if (!payload || eventType === 'ping') continue;
              applyJournalEvent(entry, { id, eventType, payload });
              entry.lastEventId = Math.max(Number(entry.lastEventId || 0), Number(id || payload.eventId || 0));
              state.eventCursors.set(entry.chatId, entry.lastEventId);
              if (state.selectedChat?.id === entry.chatId) {
                renderLiveTurn(entry); renderActivity(entry); renderPlanDiff(entry.plan, entry.diff);
              }
            }
          }
          await recoverTurnJournal(entry);
          attempt = 0;
        } catch (error) {
          if ([401, 403, 404].includes(error.status)) throw error;
          await new Promise((resolve) => setTimeout(resolve, backoff[Math.min(attempt, backoff.length - 1)]));
          attempt += 1;
        }
      }
    } catch (error) {
      if (state.selectedChat?.id === entry.chatId) toast(`事件恢复已暂停：${error.message}`, 'error');
    } finally {
      if (state.runningTurns.get(entry.chatId) === entry) state.runningTurns.delete(entry.chatId);
      if (state.selectedChat?.id === entry.chatId) {
        try {
          const fresh = await api(`/api/chats/${entry.chatId}`);
          if (state.selectedChat?.id !== entry.chatId) return;
          state.selectedChat = fresh.chat; state.selectedTask = fresh.task || null;
          state.eventCursors.set(entry.chatId, Number(fresh.latestEventId || entry.lastEventId || 0));
          renderMessages(fresh.messages); renderActivity(); setComposer(true); await refreshTurnInsights();
          if (['queued', 'starting', 'running'].includes(fresh.latestTurnRun?.status)) await resumePersistedTurn(fresh);
          await Promise.all([loadChats(), loadTasks(), loadFiles(), refreshUsage()]);
        } catch { /* access may have been revoked while the turn drained */ }
      }
      state.queueRuns.delete(entry.chatId);
      updateConcurrencyIndicator();
    }
  })();
  return entry;
}

function renderInputQueue() {
  const root = $('#input-queue');
  const inputs = state.inputQueues.get(state.selectedChat?.id) || [];
  root.classList.toggle('hidden', !inputs.length);
  const signature = JSON.stringify([inputs, selectedChatRunning()]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.innerHTML = `<div class="queue-heading">待发送 · ${inputs.length}<span>按顺序执行</span></div>` + inputs.map((input, index) => {
    const busy = input.status === 'steering';
    const uncertain = input.reason === 'DELIVERY_UNCERTAIN';
    const status = busy ? '正在调整方向…' : uncertain ? '发送结果未确认，请核对对话' : input.status === 'paused' ? '已暂停' : '排队中';
    return `<article class="queue-item" data-input-id="${escapeHtml(input.id)}">
      <div class="queue-meta">${index + 1} · ${status} · ${escapeHtml(input.mode.toUpperCase())}</div>
      <p>${escapeHtml(input.prompt)}</p><div class="queue-actions">
      <button type="button" class="secondary compact" data-queue-action="edit" ${busy ? 'disabled' : ''}>编辑</button>
      <button type="button" class="secondary compact" data-queue-action="cancel" ${busy ? 'disabled' : ''}>取消</button>
      ${input.status === 'paused' ? `<button type="button" class="secondary compact" data-queue-action="resume">${uncertain ? '核对后重发' : '继续排队'}</button>` : ''}
      <button type="button" class="queue-steer compact" data-queue-action="steer" ${busy || uncertain || !selectedChatRunning() ? 'disabled' : ''} title="把这条消息送入当前任务，调整运行方向">↑ 打断插队</button>
      </div></article>`;
  }).join('');
}

async function refreshInputQueue({ history = false } = {}) {
  const chatId = state.selectedChat?.id;
  if (!chatId || !state.me) return;
  if (state.queueRefreshing) { state.queueHistoryPending ||= history; return; }
  history ||= state.queueHistoryPending; state.queueHistoryPending = false;
  state.queueRefreshing = true;
  try {
    const queue = await api(`/api/chats/${chatId}/queue`);
    if (state.selectedChat?.id !== chatId) return;
    state.inputQueues.set(chatId, queue.inputs);
    const signature = JSON.stringify(queue.latestTurnRun);
    const changed = state.queueRuns.get(chatId) !== signature;
    state.queueRuns.set(chatId, signature);
    renderInputQueue();
    if (history || (!state.runningTurns.has(chatId) && changed)) {
      const data = await api(`/api/chats/${chatId}`);
      if (state.selectedChat?.id !== chatId) return;
      state.selectedChat = data.chat; state.selectedTask = data.task || null;
      renderMessages(data.messages);
      if (['queued', 'starting', 'running'].includes(data.latestTurnRun?.status)) await resumePersistedTurn(data);
      const running = state.runningTurns.get(chatId);
      if (running) renderLiveTurn(running, shouldAppendLivePrompt(data.messages, running));
      renderActivity(running); updateConcurrencyIndicator(); setComposer(true);
    }
  } catch (error) {
    state.queueRuns.delete(chatId);
    state.queueHistoryPending ||= history;
    throw error;
  } finally { state.queueRefreshing = false; }
}

async function submitQueuedInput() {
  if (state.modelSaving) return toast('模型正在保存，请稍后发送。');
  const chatId = state.selectedChat?.id;
  const prompt = $('#prompt-input').value.trim();
  if (!chatId || !prompt || state.queueSending) return;
  const body = { prompt, mode: $('#mode-select').value, effort: $('#effort-select').value };
  const signature = JSON.stringify([chatId, body]);
  // Reuse the input ID on a network retry so an accepted message cannot be sent twice.
  if (state.pendingInput?.signature !== signature) state.pendingInput = { signature, id: crypto.randomUUID() };
  body.id = state.pendingInput.id;
  state.queueSending = true; setComposer(true);
  try {
    await api(`/api/chats/${chatId}/queue`, { method: 'POST', body });
    state.pendingInput = null;
    if (state.selectedChat?.id === chatId && $('#prompt-input').value.trim() === prompt) {
      $('#prompt-input').value = ''; $('#prompt-input').style.height = '';
    }
    await refreshInputQueue();
  } finally { state.queueSending = false; setComposer(true); }
}


async function loadFiles() {
  if (!state.selectedProject) return;
  const data = await api(`/api/projects/${state.selectedProject.id}/tree`);
  state.fileEntries = data.entries;
  const root = $('#file-tree');
  root.className = 'file-tree';
  root.innerHTML = data.entries.map((entry) => {
    const depth = entry.path.split('/').length - 1;
    return `<button class="file-entry depth-${Math.min(12, depth)} ${state.selectedFile === entry.path ? 'active' : ''}" data-path="${escapeHtml(entry.path)}" data-type="${entry.type}"><span class="file-icon">${entry.type === 'directory' ? '▾' : entry.type === 'symlink' ? '↗' : '·'}</span><span>${escapeHtml(entry.name)}</span>${entry.type === 'file' ? `<span class="file-meta">${formatBytes(entry.size)}</span>` : ''}</button>`;
  }).join('') || '<div class="empty-state">项目为空</div>';
  $$('.file-entry', root).forEach((button) => button.addEventListener('click', () => button.dataset.type === 'file' && openFile(button.dataset.path)));
}

function fileExtension(filePath) {
  const name = String(filePath || '').split('/').pop() || '';
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

const HTML_PREVIEW_EXTENSIONS = new Set(['.html', '.htm']);
const SOURCE_FIRST_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.sh', '.py', '.java', '.go', '.rs', '.yaml', '.yml', '.toml',
]);

function rawFileUrl(filePath) {
  return `/api/projects/${state.selectedProject.id}/raw?path=${encodeURIComponent(filePath)}`;
}

function closeViewer() {
  state.selectedFile = null; state.selectedFileInfo = null; state.fileContent = null; state.viewerMode = 'preview';
  $('#editor-pane')?.classList.add('hidden');
  $('#file-tree-resizer')?.classList.add('hidden');
  $('.files-panel')?.classList.add('viewer-closed');
  if ($('#file-preview')) $('#file-preview').innerHTML = '';
}

function parseDelimited(text, delimiter) {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let index = 0; index < text.length && rows.length < 300; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row.slice(0, 60)); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row.slice(0, 60)); }
  return rows;
}

function columnName(index) {
  let value = index + 1; let label = '';
  while (value) { value -= 1; label = String.fromCharCode(65 + (value % 26)) + label; value = Math.floor(value / 26); }
  return label;
}

function renderGridTable(rows, root, meta = '') {
  root.innerHTML = '';
  const shell = document.createElement('div'); shell.className = 'spreadsheet-shell';
  if (meta) { const info = document.createElement('p'); info.className = 'sheet-meta'; info.textContent = meta; shell.append(info); }
  const table = document.createElement('table'); table.className = 'sheet-table';
  const width = Math.max(0, ...rows.map((row) => row.length));
  const head = document.createElement('thead'); const headRow = document.createElement('tr');
  const corner = document.createElement('th'); corner.className = 'row-index'; headRow.append(corner);
  for (let column = 0; column < width; column += 1) { const th = document.createElement('th'); th.textContent = columnName(column); headRow.append(th); }
  head.append(headRow); table.append(head);
  const body = document.createElement('tbody');
  rows.forEach((values, rowIndex) => {
    const tr = document.createElement('tr'); const number = document.createElement('th'); number.className = 'row-index'; number.textContent = String(rowIndex + 1); tr.append(number);
    for (let column = 0; column < width; column += 1) { const td = document.createElement('td'); td.textContent = values[column] ?? ''; tr.append(td); }
    body.append(tr);
  });
  table.append(body); shell.append(table); root.append(shell);
}

function renderWorkbook(data, root) {
  root.innerHTML = '';
  if (!data.sheets?.length) { root.innerHTML = '<div class="preview-empty"><div><b>空工作簿</b>没有可显示的工作表。</div></div>'; return; }
  const shell = document.createElement('div'); shell.className = 'spreadsheet-shell';
  const tabs = document.createElement('div'); tabs.className = 'sheet-tabs'; shell.append(tabs);
  const content = document.createElement('div'); shell.append(content); root.append(shell);
  const showSheet = (sheet, button) => {
    $$('.sheet-tab', tabs).forEach((item) => item.classList.toggle('active', item === button));
    renderGridTable(sheet.rows, content, `${sheet.name} · ${sheet.rowCount} 行 × ${sheet.columnCount} 列${sheet.truncated ? ' · 仅显示前 300 行 / 60 列' : ''}`);
  };
  data.sheets.forEach((sheet, index) => {
    const button = document.createElement('button'); button.className = `sheet-tab ${index === 0 ? 'active' : ''}`; button.textContent = sheet.name; tabs.append(button);
    button.addEventListener('click', () => showSheet(sheet, button));
    if (index === 0) showSheet(sheet, button);
  });
}

async function renderFilePreview() {
  const root = $('#file-preview'); root.innerHTML = '';
  const filePath = state.selectedFile; const extension = fileExtension(filePath); const raw = rawFileUrl(filePath);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.svg'].includes(extension)) {
    const wrap = document.createElement('div'); wrap.className = 'preview-image-wrap';
    const image = document.createElement('img'); image.className = 'preview-image'; image.src = raw; image.alt = filePath; wrap.append(image); root.append(wrap); return;
  }
  if (extension === '.dot') {
    const sibling = filePath.replace(/\.dot$/i, '.svg');
    if (state.fileEntries.some((entry) => entry.type === 'file' && entry.path === sibling)) {
      const wrap = document.createElement('div'); wrap.className = 'preview-image-wrap';
      const image = document.createElement('img'); image.className = 'preview-image'; image.src = rawFileUrl(sibling); image.alt = `${filePath} 可视化`; wrap.append(image); root.append(wrap); return;
    }
  }
  if (extension === '.pdf') {
    const frame = document.createElement('iframe'); frame.className = 'preview-pdf'; frame.src = raw; frame.title = filePath; root.append(frame); return;
  }
  if (HTML_PREVIEW_EXTENSIONS.has(extension)) {
    const frame = document.createElement('iframe');
    frame.className = 'preview-html';
    frame.src = raw;
    frame.title = `${filePath} 预览`;
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    root.append(frame);
    return;
  }
  if (['.xlsx', '.xlsm'].includes(extension)) {
    root.innerHTML = '<div class="preview-empty"><div><b>正在解析工作簿…</b>读取工作表和单元格。</div></div>';
    const projectId = state.selectedProject.id; const selected = filePath;
    const data = await api(`/api/projects/${projectId}/spreadsheet-preview?path=${encodeURIComponent(filePath)}`);
    if (state.selectedProject?.id === projectId && state.selectedFile === selected) renderWorkbook(data, root);
    return;
  }
  if (state.fileContent !== null) {
    if (extension === '.md' || extension === '.markdown') { const article = document.createElement('article'); article.className = 'preview-markdown'; article.innerHTML = markdown(state.fileContent); root.append(article); return; }
    if (extension === '.csv' || extension === '.tsv') { renderGridTable(parseDelimited(state.fileContent, extension === '.tsv' ? '\t' : ','), root, `${filePath} · 最多显示 300 行 / 60 列`); return; }
    const pre = document.createElement('pre'); pre.className = 'preview-code';
    if (extension === '.json') { try { pre.textContent = JSON.stringify(JSON.parse(state.fileContent), null, 2); } catch { pre.textContent = state.fileContent; } }
    else pre.textContent = state.fileContent;
    root.append(pre); return;
  }
  root.innerHTML = `<div class="preview-empty"><div><b>暂不支持在线预览</b>${escapeHtml(fileExtension(filePath) || '该格式')} 文件可以安全下载到本机查看。</div></div>`;
}

function updateViewerControls() {
  const hasSource = state.fileContent !== null;
  $('#viewer-tabs').classList.toggle('hidden', !hasSource);
  $('#preview-tab').classList.toggle('active', state.viewerMode === 'preview');
  $('#source-tab').classList.toggle('active', state.viewerMode === 'source');
  $('#save-file').classList.toggle('hidden', !hasSource || state.viewerMode !== 'source');
  $('#editor-pane').classList.toggle('preview-mode', state.viewerMode === 'preview');
  $('#editor-pane').classList.toggle('source-mode', state.viewerMode === 'source');
}

async function setViewerMode(mode) {
  if (mode === 'source' && state.fileContent === null) return;
  if (state.viewerMode === 'source') state.fileContent = $('#file-editor').value;
  state.viewerMode = mode;
  if (mode === 'preview') await renderFilePreview();
  updateViewerControls();
}

async function openFile(filePath) {
  const projectId = state.selectedProject.id;
  try {
    state.selectedFile = filePath; state.selectedFileInfo = state.fileEntries.find((entry) => entry.path === filePath) || null; state.fileContent = null;
    const extension = fileExtension(filePath);
    const binaryPreview = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.pdf', '.xlsx', '.xlsm'].includes(extension);
    if (!binaryPreview) {
      try {
        const file = await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`);
        if (state.selectedProject?.id !== projectId || state.selectedFile !== filePath) return;
        state.selectedFileInfo = file;
        state.fileContent = file.content; $('#file-editor').value = file.content;
      } catch (error) {
        if (error.code !== 'BINARY_FILE') throw error;
      }
    }
    state.viewerMode = SOURCE_FIRST_EXTENSIONS.has(extension) ? 'source' : 'preview';
    $('#editor-path').textContent = filePath;
    $('#download-file').href = rawFileUrl(filePath); $('#download-file').download = filePath.split('/').pop();
    $('#editor-pane').classList.remove('hidden'); $('#file-tree-resizer').classList.remove('hidden'); $('.files-panel').classList.remove('viewer-closed');
    updateViewerControls();
    if (state.viewerMode === 'preview') await renderFilePreview();
    await loadFiles();
  } catch (error) { toast(error.message, 'error'); }
}

async function writeFile(filePath, content, successMessage = '', { overwrite = true, expectedVersion = null } = {}) {
  const data = await api(`/api/projects/${state.selectedProject.id}/file?path=${encodeURIComponent(filePath)}&overwrite=${overwrite ? '1' : '0'}`, {
    method: 'PUT', headers: {
      'content-type': 'application/octet-stream',
      ...(expectedVersion ? { 'if-match': `"${expectedVersion}"` } : {}),
    }, body: content,
  });
  if (state.selectedFile === filePath) {
    state.selectedFileInfo = data.file;
    if (typeof content === 'string') state.fileContent = content;
  }
  await loadFiles();
  if (state.selectedFile === filePath && state.viewerMode === 'preview') await renderFilePreview();
  toast(successMessage || `已保存 ${filePath}`);
}

function switchView(view) {
  $('#tasks-view').classList.toggle('hidden', view !== 'tasks');
  $('#workbench-view').classList.toggle('hidden', view !== 'workbench');
  $('#memories-view').classList.toggle('hidden', view !== 'memories');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'memories') void loadMemories().catch((error) => toast(error.message, 'error'));
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function panelNumber(name, fallback) {
  const value = Number.parseFloat(getComputedStyle($('#workbench-view')).getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function clampPanelSizes() {
  if (window.innerWidth <= 820 || $('#app-view').classList.contains('hidden')) return;
  const workbench = $('#workbench-view'); const width = workbench.getBoundingClientRect().width;
  const left = panelNumber('--rail-width', 230); const right = panelNumber('--files-width', 400);
  const nextLeft = clamp(left, 180, width - right - 332);
  const nextRight = clamp(right, 280, width - nextLeft - 332);
  workbench.style.setProperty('--rail-width', `${nextLeft}px`);
  workbench.style.setProperty('--files-width', `${nextRight}px`);
}

function setupResizers() {
  const workbench = $('#workbench-view');
  const savedLeft = Number(localStorage.getItem('codex-harness.rail-width'));
  const savedRight = Number(localStorage.getItem('codex-harness.files-width'));
  const savedTree = Number(localStorage.getItem('codex-harness.file-tree-height'));
  if (savedLeft) workbench.style.setProperty('--rail-width', `${savedLeft}px`);
  if (savedRight) workbench.style.setProperty('--files-width', `${savedRight}px`);
  if (savedTree) workbench.style.setProperty('--file-tree-height', `${savedTree}px`);

  const bindVertical = (selector, side) => {
    const handle = $(selector); let pointerId = null; let startX = 0; let startWidth = 0;
    const apply = (delta) => {
      const total = workbench.getBoundingClientRect().width;
      const other = panelNumber(side === 'left' ? '--files-width' : '--rail-width', side === 'left' ? 400 : 230);
      const next = clamp(startWidth + (side === 'left' ? delta : -delta), side === 'left' ? 180 : 280, total - other - 332);
      const property = side === 'left' ? '--rail-width' : '--files-width';
      workbench.style.setProperty(property, `${next}px`);
      localStorage.setItem(side === 'left' ? 'codex-harness.rail-width' : 'codex-harness.files-width', String(Math.round(next)));
    };
    handle.addEventListener('pointerdown', (event) => {
      if (window.innerWidth <= 820) return;
      pointerId = event.pointerId; startX = event.clientX; startWidth = panelNumber(side === 'left' ? '--rail-width' : '--files-width', side === 'left' ? 230 : 400);
      handle.setPointerCapture(pointerId); handle.classList.add('dragging'); document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (event) => { if (event.pointerId === pointerId) apply(event.clientX - startX); });
    const finish = (event) => { if (event.pointerId !== pointerId) return; pointerId = null; handle.classList.remove('dragging'); document.body.classList.remove('resizing'); };
    handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
    handle.addEventListener('dblclick', () => { const value = side === 'left' ? 230 : 400; workbench.style.setProperty(side === 'left' ? '--rail-width' : '--files-width', `${value}px`); localStorage.removeItem(side === 'left' ? 'codex-harness.rail-width' : 'codex-harness.files-width'); clampPanelSizes(); });
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault();
      startWidth = panelNumber(side === 'left' ? '--rail-width' : '--files-width', side === 'left' ? 230 : 400); apply(event.key === 'ArrowRight' ? 16 : -16);
    });
  };
  bindVertical('#left-resizer', 'left'); bindVertical('#right-resizer', 'right');

  const horizontal = $('#file-tree-resizer'); let pointerId = null; let startY = 0; let startHeight = 0;
  const applyTree = (delta) => {
    const panel = $('.files-panel'); const header = $('.files-header', panel).getBoundingClientRect().height;
    const next = clamp(startHeight + delta, 120, panel.getBoundingClientRect().height - header - 166);
    workbench.style.setProperty('--file-tree-height', `${next}px`); localStorage.setItem('codex-harness.file-tree-height', String(Math.round(next)));
  };
  horizontal.addEventListener('pointerdown', (event) => { pointerId = event.pointerId; startY = event.clientY; startHeight = $('#file-tree').getBoundingClientRect().height; horizontal.setPointerCapture(pointerId); horizontal.classList.add('dragging'); document.body.classList.add('resizing-row'); });
  horizontal.addEventListener('pointermove', (event) => { if (event.pointerId === pointerId) applyTree(event.clientY - startY); });
  const finishTree = (event) => { if (event.pointerId !== pointerId) return; pointerId = null; horizontal.classList.remove('dragging'); document.body.classList.remove('resizing-row'); };
  horizontal.addEventListener('pointerup', finishTree); horizontal.addEventListener('pointercancel', finishTree);
  horizontal.addEventListener('dblclick', () => { workbench.style.setProperty('--file-tree-height', '38%'); localStorage.removeItem('codex-harness.file-tree-height'); });
  horizontal.addEventListener('keydown', (event) => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); startHeight = $('#file-tree').getBoundingClientRect().height; applyTree(event.key === 'ArrowDown' ? 16 : -16); });
  window.addEventListener('resize', clampPanelSizes);
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); $('#login-error').textContent = '';
  try {
    await api('/api/employee/login', { method: 'POST', body: { username: $('#login-username').value, password: $('#login-password').value } });
    $('#login-password').value = ''; await bootstrap();
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#logout-button').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { showLogin(); } });
$('#boss-nav').addEventListener('click', () => location.assign('/boss'));
$$('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$('#refresh-tasks').addEventListener('click', () => Promise.all([loadTasks(), loadProjects()]).then(renderTasks).catch((error) => toast(error.message, 'error')));

$('#memory-create-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const submit = event.submitter; submit.disabled = true;
  try {
    await api('/api/memories', { method: 'POST', body: { body: $('#memory-create-body').value } });
    $('#memory-create-body').value = ''; await loadMemories(); toast('记忆已保存。');
  } catch (error) { toast(error.message, 'error'); } finally { submit.disabled = false; }
});

$('#memory-list').addEventListener('click', async (event) => {
  const card = event.target.closest('.memory-card'); if (!card) return;
  const item = state.memories.find((memory) => memory.id === card.dataset.id); if (!item) return;
  try {
    if (event.target.closest('[data-memory-edit]')) {
      openTextDialog({ eyebrow: 'EDIT MEMORY', title: '编辑私有记忆', label: '修改后，引用旧版本的对话必须重置原生线程',
        value: item.body, submitLabel: '保存修改', multiline: true, onSubmit: async (body) => {
          if (body.trim() === item.body) return;
          const result = await api(`/api/memories/${item.id}`, { method: 'PATCH', body: { body, version: item.version } });
          await loadMemories(); toast(`记忆已更新${result.resetChats ? `，${result.resetChats} 个对话需重置` : ''}。`);
        } });
    } else if (event.target.closest('[data-memory-delete]')) {
      openConfirmDialog({ eyebrow: 'FORGET MEMORY', title: '删除私有记忆',
        message: '删除会立即停止后续召回；引用过它的对话需要重置原生线程。', submitLabel: '确认删除',
        onConfirm: async () => {
          const result = await api(`/api/memories/${item.id}`, { method: 'DELETE', body: { version: item.version } });
          await loadMemories(); toast(`记忆已删除${result.resetChats ? `，${result.resetChats} 个对话需重置` : ''}。`);
        } });
    }
  } catch (error) { toast(error.message, 'error'); }
});

for (const id of ['use-memory', 'save-memory']) {
  $(`#${id}`).addEventListener('change', async () => {
    const chatId = state.selectedChat?.id; if (!chatId) return;
    const body = { useMemory: $('#use-memory').checked, saveMemory: $('#save-memory').checked };
    $('#use-memory').disabled = true; $('#save-memory').disabled = true;
    try {
      const data = await api(`/api/chats/${chatId}/memory`, { method: 'PATCH', body });
      if (state.selectedChat?.id === chatId) Object.assign(state.selectedChat, data.chat);
      toast('对话记忆设置已保存。');
    } catch (error) { toast(error.message, 'error'); }
    finally { if (state.selectedChat?.id === chatId) { $('#use-memory').disabled = false; $('#save-memory').disabled = false; } }
  });
}

$('#mode-select').addEventListener('change', async (event) => {
  if (!state.selectedChat) return;
  const chatId = state.selectedChat.id;
  const previous = state.selectedChat.preferredMode || 'execute';
  const preferredMode = event.target.value;
  state.selectedChat.preferredMode = preferredMode;
  const local = state.chats.find((chat) => chat.id === chatId);
  if (local) local.preferredMode = preferredMode;
  try {
    const data = await api(`/api/chats/${chatId}`, { method: 'PATCH', body: { preferredMode } });
    if (state.selectedChat?.id === chatId) state.selectedChat = { ...state.selectedChat, ...data.chat };
  } catch (error) {
    if (state.selectedChat?.id === chatId) {
      state.selectedChat.preferredMode = previous;
      $('#mode-select').value = previous;
    }
    if (local) local.preferredMode = previous;
    toast(error.message, 'error');
  }
});

$('#approval-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-decision]');
  const card = event.target.closest('.approval-card');
  if (!button || !card || !state.selectedChat) return;
  button.disabled = true;
  try {
    await api(`/api/chats/${state.selectedChat.id}/approvals/${encodeURIComponent(card.dataset.id)}`, {
      method: 'POST', body: { decision: button.dataset.decision },
    });
    card.remove(); updateInsightsVisibility();
  } catch (error) { button.disabled = false; toast(error.message, 'error'); }
});

$('#message-list').addEventListener('click', (event) => {
  const recovery = event.target.closest('[data-thread-recovery]');
  if (recovery && state.selectedChat) {
    const action = recovery.dataset.threadRecovery;
    if (action === 'reset') {
      openConfirmDialog({
        eyebrow: 'RESET CODEX THREAD', title: '建立空白线程',
        message: '原线程标识和恢复谱系会保留，但新线程没有原生上下文。仅在确认接受上下文断点时继续。',
        submitLabel: '确认建立', onConfirm: () => recoverThread(recovery, action),
      });
    } else {
      void recoverThread(recovery, action).catch((error) => toast(error.message, 'error'));
    }
    return;
  }
  const button = event.target.closest('.submit-task-button');
  if (!button || !state.selectedTask || !state.selectedChat) return;
  if (state.selectedTask.workflowRunId) {
    void workGraphUI.inspect(state.selectedTask, { chatId: state.selectedChat.id, turnRunId: button.dataset.turnRunId,
      itemId: button.dataset.itemId }).catch((e) => toast(e.message, 'error'));
    return;
  }
  state.pendingSubmission = {
    taskId: state.selectedTask.id, taskVersion: Number(button.dataset.taskVersion), chatId: state.selectedChat.id,
    turnRunId: button.dataset.turnRunId, itemId: button.dataset.itemId,
  };
  $('#submit-form').reset();
  $('.form-error', $('#submit-form')).textContent = '';
  $('#submit-summary').textContent = `${state.selectedTask.title} · V${state.selectedTask.version}。将保存最终回复、本轮 diff，以及当前工作树的不可变 Git commit/tree 快照。`;
  $('#submit-dialog').showModal();
});

$('#submit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#submit-dialog').close(); return; }
  const pending = state.pendingSubmission;
  if (!pending) return;
  const target = event.currentTarget;
  const form = new FormData(target);
  try {
    await api(`/api/tasks/${pending.taskId}/submissions`, { method: 'POST', body: { ...pending, note: form.get('note') } });
    $('#submit-dialog').close(); state.pendingSubmission = null;
    await loadTasks();
    if (state.selectedChat) await selectChat(state.selectedChat);
    toast('任务快照已提交，等待老板验收');
  } catch (error) { $('.form-error', target).textContent = error.message; }
});

$('#new-project').addEventListener('click', () => {
  $('#project-form').reset(); $('.form-error', $('#project-form')).textContent = '';
  $('#project-dialog').showModal();
});

$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#project-dialog').close();
  const target = event.currentTarget;
  const form = new FormData(target);
  try {
    const data = await api('/api/projects', { method: 'POST', body: { name: form.get('name'), description: form.get('description') } });
    $('#project-dialog').close(); await loadProjects(); await selectProject(data.project); toast('隔离项目已创建');
  } catch (error) { $('.form-error', target).textContent = error.message; }
});

$('#text-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    state.pendingTextAction = null;
    $('#text-dialog').close();
    return;
  }
  const target = event.currentTarget;
  const value = new FormData(target).get('value')?.toString().trim();
  if (!value || !state.pendingTextAction) return;
  const submit = event.submitter || $('#text-dialog-submit');
  submit.disabled = true;
  try {
    await state.pendingTextAction(value);
    state.pendingTextAction = null;
    $('#text-dialog').close();
  } catch (error) {
    $('.form-error', target).textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    state.pendingConfirmAction = null;
    $('#confirm-dialog').close();
    return;
  }
  if (!state.pendingConfirmAction) return;
  const target = event.currentTarget;
  const action = state.pendingConfirmAction;
  const submit = event.submitter || $('#confirm-dialog-submit');
  submit.disabled = true;
  try {
    await action();
    state.pendingConfirmAction = null;
    $('#confirm-dialog').close();
  } catch (error) {
    $('.form-error', target).textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#new-chat').addEventListener('click', () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  const projectId = state.selectedProject.id;
  openTextDialog({
    eyebrow: 'NEW THREAD', title: '新建对话', label: '对话标题', value: '新任务', submitLabel: '创建对话',
    onSubmit: async (title) => {
      const data = await api(`/api/projects/${projectId}/chats`, { method: 'POST', body: { title } });
      await loadChats();
      await selectChat(data.chat);
    },
  });
});

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitQueuedInput().catch((error) => toast(error.message, 'error'));
});
$('#input-queue').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-queue-action]');
  if (!button) return;
  const chatId = state.selectedChat?.id;
  const id = button.closest('[data-input-id]').dataset.inputId;
  const input = (state.inputQueues.get(chatId) || []).find((item) => item.id === id);
  if (!input) return;
  const action = button.dataset.queueAction;
  if (action === 'edit') {
    state.queueEdit = { chatId, id, revision: input.revision };
    $('#queue-edit-input').value = input.prompt;
    $('#queue-edit-error').textContent = '';
    $('#queue-edit-dialog').showModal(); $('#queue-edit-input').focus();
    return;
  }
  if (action === 'resume' && input.reason === 'DELIVERY_UNCERTAIN') {
    openConfirmDialog({ eyebrow: 'RESEND MESSAGE', title: '确认重新排队',
      message: '上次发送可能已被 Codex 接受。请核对对话后确认重发，避免重复执行。', submitLabel: '已核对，重新排队',
      onConfirm: async () => {
        await api(`/api/chats/${chatId}/queue/${id}/resume`, { method: 'POST',
          body: { revision: input.revision, acknowledgeUncertain: true } });
        await refreshInputQueue();
      },
    });
    return;
  }
  button.disabled = true;
  try {
    await api(`/api/chats/${chatId}/queue/${id}${action === 'cancel' ? '' : `/${action}`}`, {
      method: action === 'cancel' ? 'DELETE' : 'POST',
      body: { revision: input.revision, expectedRunId: state.runningTurns.get(chatId)?.turnRunId },
    });
    await refreshInputQueue({ history: action === 'steer' });
  } catch (error) {
    toast(error.message, 'error');
    await refreshInputQueue().catch(() => {});
  } finally { button.disabled = false; }
});
$('#queue-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('#queue-edit-dialog').close(); return; }
  const editing = state.queueEdit;
  if (!editing) return;
  const button = $('#queue-edit-save'); button.disabled = true;
  try {
    await api(`/api/chats/${editing.chatId}/queue/${editing.id}`, { method: 'PATCH',
      body: { revision: editing.revision, prompt: $('#queue-edit-input').value } });
    state.queueEdit = null; $('#queue-edit-dialog').close(); await refreshInputQueue();
  } catch (error) { $('#queue-edit-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#prompt-input').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(180, event.target.scrollHeight)}px`; });
$('#prompt-input').addEventListener('keydown', (event) => { if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); $('#composer').requestSubmit(); } });
$('#stop-turn').addEventListener('click', async () => {
  if (!state.selectedChat) return;
  try { await api(`/api/chats/${state.selectedChat.id}/interrupt`, { method: 'POST' }); await refreshInputQueue(); }
  catch (error) { toast(error.message, 'error'); }
});

$('#refresh-files').addEventListener('click', () => state.selectedProject && loadFiles());
$('#preview-tab').addEventListener('click', () => setViewerMode('preview').catch((error) => toast(error.message, 'error')));
$('#source-tab').addEventListener('click', () => setViewerMode('source').catch((error) => toast(error.message, 'error')));
$('#save-file').addEventListener('click', () => state.selectedFile && writeFile(
  state.selectedFile, $('#file-editor').value, '', { expectedVersion: state.selectedFileInfo?.version || null },
).catch((error) => toast(error.message, 'error')));
$('#new-file').addEventListener('click', () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  openTextDialog({
    eyebrow: 'NEW FILE', title: '新建项目文件', label: '项目内文件路径', value: 'src/index.js', submitLabel: '创建文件',
    onSubmit: async (filePath) => { await writeFile(filePath, ''); await openFile(filePath); },
  });
});
$('#new-folder').addEventListener('click', () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  const projectId = state.selectedProject.id;
  openTextDialog({
    eyebrow: 'NEW FOLDER', title: '新建项目目录', label: '项目内目录路径', value: 'src', submitLabel: '创建目录',
    onSubmit: async (folder) => { await api(`/api/projects/${projectId}/directory`, { method: 'POST', body: { path: folder } }); await loadFiles(); },
  });
});
$('#upload-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  state.pendingUpload = { file, projectId: state.selectedProject.id };
  const form = $('#upload-form'); form.reset(); $('.form-error', form).textContent = '';
  $('#upload-source-name').value = file.name;
  $('#upload-destination').value = file.name;
  $('#upload-file-meta').textContent = `${formatBytes(file.size)}${file.type ? ` · ${file.type}` : ''}`;
  $('#upload-dialog').showModal();
});
$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { state.pendingUpload = null; $('#upload-dialog').close(); return; }
  const target = event.currentTarget;
  const pending = state.pendingUpload;
  const destination = String(new FormData(target).get('destination') || '').trim();
  const errorRoot = $('.form-error', target);
  errorRoot.textContent = '';
  if (!pending || pending.projectId !== state.selectedProject?.id) {
    errorRoot.textContent = '项目已经切换，请重新选择要上传的文件。'; return;
  }
  const exists = state.fileEntries.some((entry) => entry.type === 'file' && entry.path === destination);
  if (exists && !target.elements.overwrite.checked) {
    errorRoot.textContent = '项目中已有同名文件；如需替换，请勾选允许覆盖。'; return;
  }
  const submit = event.submitter || $('.primary', target); submit.disabled = true;
  try {
    await writeFile(destination, await pending.file.arrayBuffer(), `已上传 ${destination}`, { overwrite: target.elements.overwrite.checked });
    state.pendingUpload = null; $('#upload-dialog').close(); await openFile(destination);
  } catch (error) { errorRoot.textContent = error.message; }
  finally { submit.disabled = false; }
});
$('#delete-file').addEventListener('click', () => {
  if (!state.selectedFile) return;
  const projectId = state.selectedProject.id;
  const filePath = state.selectedFile;
  openConfirmDialog({
    eyebrow: 'MOVE TO TRASH', title: '移到可恢复的废纸篓', message: `确认移动 ${filePath}？`, submitLabel: '移到废纸篓',
    onConfirm: async () => {
      await api(`/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
      closeViewer(); await loadFiles(); toast('已移到废纸篓');
    },
  });
});

setInterval(() => {
  if (!document.hidden) void refreshInputQueue().catch(() => {});
}, 1000);
setupResizers(); health(); bootstrap();

function updateModelSelect() {
  const select = $('#model-select');
  select.value = state.selectedChat?.preferredModel || '';
  select.disabled = !state.selectedChat || Boolean(state.modelSaving);
}

$('#model-select').addEventListener('change', async (event) => {
  const chatId = state.selectedChat?.id;
  if (!chatId) return;
  const preferredModel = event.target.value || null;
  state.modelSaving = true;
  event.target.disabled = true;
  try {
    const data = await api(`/api/chats/${chatId}`, { method: 'PATCH', body: { preferredModel } });
    if (state.selectedChat?.id === chatId) Object.assign(state.selectedChat, data.chat);
    const local = state.chats.find((chat) => chat.id === chatId);
    if (local) Object.assign(local, data.chat);
    toast('对话模型已保存，下次发送时生效。');
  } catch (error) { toast(error.message, 'error'); }
  finally { state.modelSaving = false; updateModelSelect(); }
});
