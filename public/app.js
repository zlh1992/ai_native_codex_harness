const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  me: null, csrf: '', projects: [], chats: [], selectedProject: null, selectedChat: null,
  selectedFile: null, selectedFileInfo: null, fileEntries: [], fileContent: null, viewerMode: 'preview',
  runningTurns: new Map(), maxConcurrentTurns: 11, tasks: [], selectedTask: null,
  codexCapacity: null, pendingSubmission: null,
};

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
    throw error;
  }
  return payload;
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  state.me = null;
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
  try {
    const data = await api('/api/me');
    state.me = data.user;
    state.csrf = data.csrfToken;
    if (data.user.role === 'admin' && new URLSearchParams(location.search).get('workbench') !== '1') {
      location.replace('/boss.html');
      return;
    }
    showApp();
    $('#user-chip').textContent = `${data.user.displayName} · ${data.user.role === 'admin' ? '超级管理员' : data.user.username}`;
    $('#model-badge').textContent = data.model;
    $('#codex-status').classList.toggle('online', data.codex.ready);
    $('#boss-nav').classList.toggle('hidden', data.user.role !== 'admin');
    state.codexCapacity = data.codex;
    state.maxConcurrentTurns = data.codex.maxRootTurns || 11;
    updateConcurrencyIndicator();
    updateCapacity(data.codex);
    $('#effort-select').innerHTML = data.efforts.map((value) => `<option value="${value}" ${value === data.defaultEffort ? 'selected' : ''}>${value}</option>`).join('');
    updateUsage(data.usage, data.user.maxStorageBytes);
    await Promise.all([loadProjects(), loadTasks()]);
    const requestedProject = new URLSearchParams(location.search).get('project');
    const selected = requestedProject && state.projects.find((project) => project.id === requestedProject);
    if (selected) { await selectProject(selected); switchView('workbench'); }
    else switchView('tasks');
  } catch { showLogin(); }
}

function updateUsage(usage, quota) {
  $('#storage-label').textContent = `${formatBytes(usage?.bytes)} / ${formatBytes(quota)}`;
  $('#storage-meter').style.width = `${Math.min(100, Number(usage?.bytes || 0) / Number(quota || 1) * 100)}%`;
}

function updateCapacity(capacity = state.codexCapacity || {}) {
  state.codexCapacity = { ...(state.codexCapacity || {}), ...capacity };
  $('#execute-capacity').textContent = `${state.codexCapacity.activeExecuteLeases || 0} / ${state.codexCapacity.maxExecuteLeases || 2}`;
}

async function loadTasks() {
  const data = await api('/api/tasks');
  state.tasks = data.tasks || [];
  renderTasks();
}

function taskStatusLabel(status) {
  return ({ draft: '草稿', ready: '等待前序', active: '进行中', submitted: '待老板验收', passed: '已通过', rework: '需返工' })[status] || status;
}

function renderTasks() {
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
    const actionable = ['active', 'rework'].includes(task.status);
    return `<article class="task-card status-${task.status}">
      <div class="task-card-top"><span class="status-tag ${task.status}">${escapeHtml(taskStatusLabel(task.status))}</span><span>V${task.version} · #${task.position + 1}</span></div>
      <p class="eyebrow">${escapeHtml(task.roadmapTitle || 'DIRECT TASK')} · ${escapeHtml(task.projectName)}</p>
      <h3>${escapeHtml(task.title)}</h3>
      <div class="acceptance"><b>验收标准</b><p>${escapeHtml(task.acceptance)}</p></div>
      <div class="task-card-foot"><span>${formatDate(task.updatedAt, true)}</span>${actionable ? `<button class="primary task-open" data-id="${task.id}">${task.status === 'rework' ? '继续返工' : '进入任务'}</button>` : ''}</div>
    </article>`;
  }).join('');
  $$('.task-open', root).forEach((button) => button.addEventListener('click', () => openTask(button.dataset.id)));
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
  if (clearChat) renderMessages([]);
}

function resetProject() {
  state.selectedProject = null; state.selectedChat = null; state.selectedTask = null; closeViewer();
  renderProjects(); renderChats(); renderMessages([]);
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
  const root = $('#chat-list');
  if (!state.selectedProject) { root.className = 'chat-list empty-state'; root.textContent = '请先选择项目'; return; }
  if (!state.chats.length) { root.className = 'chat-list empty-state'; root.textContent = '点击 ＋ 开始第一段对话'; return; }
  root.className = 'chat-list';
  root.innerHTML = state.chats.map((chat) => {
    const running = state.runningTurns.has(chat.id) || chat.status === 'running';
    return `<button class="chat-item ${state.selectedChat?.id === chat.id ? 'active' : ''} ${running ? 'running' : ''}" data-id="${chat.id}"><b>${running ? '<i class="run-dot">●</i> ' : ''}${escapeHtml(chat.title)}</b><span>${running ? '正在运行 · ' : ''}${formatDate(chat.updatedAt, true)}</span></button>`;
  }).join('');
  $$('.chat-item', root).forEach((button) => button.addEventListener('click', () => selectChat(state.chats.find((item) => item.id === button.dataset.id))));
}

async function selectChat(chat) {
  state.selectedChat = chat;
  renderChats();
  $('#chat-title').textContent = chat.title;
  const data = await api(`/api/chats/${chat.id}`);
  state.selectedChat = data.chat;
  state.selectedTask = data.task || null;
  renderMessages(data.messages);
  const running = state.runningTurns.get(chat.id);
  if (running) renderLiveTurn(running, !data.messages.some((message) => message.role === 'user' && message.content === running.prompt));
  renderActivity(running);
  await refreshTurnInsights();
  setComposer(true);
}

function renderMessages(messages) {
  const root = $('#message-list');
  if (!messages.length) {
    root.innerHTML = `<div class="welcome-message"><span class="mark">C</span><h3>${state.selectedProject ? '准备开始构建。' : '从一个项目开始。'}</h3><p>${state.selectedProject ? '描述目标、错误或想修改的功能，Codex 会直接在这个隔离项目中工作。' : '创建或选择项目，再新建对话。Codex 会在隔离的本机目录中读取、编写和验证代码。'}</p></div>`;
    return;
  }
  root.innerHTML = messages.map(messageHtml).join('');
  const snapshot = [...messages].reverse().find((message) => message.role === 'assistant' && message.metadata);
  renderPlanDiff(snapshot?.metadata?.plan || [], snapshot?.metadata?.diffSnapshot || '');
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
  const usable = enabled && !selectedChatRunning() && Boolean(state.selectedChat);
  $('#prompt-input').disabled = !usable;
  $('#send-button').disabled = !usable;
  $('#stop-turn').classList.toggle('hidden', !selectedChatRunning());
  $('#composer-context').textContent = state.selectedChat
    ? `${state.selectedProject.name} · ${state.selectedChat.title}${state.selectedTask ? ` · 任务 V${state.selectedTask.version}` : ''}${selectedChatRunning() ? ' · 正在运行，可切换到其他对话并行提问' : ''}`
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
    || !$('#plan-panel').classList.contains('hidden') || !$('#diff-panel').classList.contains('hidden');
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

async function sendTurn(prompt) {
  const chat = { ...state.selectedChat, status: 'running' };
  const project = { ...state.selectedProject };
  const mode = $('#mode-select').value;
  const entry = { chatId: chat.id, projectId: project.id, prompt, mode, text: '', events: [], approvals: [], plan: [], diff: '', statusText: 'Codex 正在思考…' };
  state.runningTurns.set(chat.id, entry);
  state.selectedChat = chat;
  const localChat = state.chats.find((item) => item.id === chat.id); if (localChat) localChat.status = 'running';
  renderChats(); updateConcurrencyIndicator(); setComposer(true);
  appendMessage('user', prompt);
  renderLiveTurn(entry);
  renderActivity(entry);
  try {
    const response = await fetch(`/api/chats/${chat.id}/turns`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf },
      credentials: 'same-origin', body: JSON.stringify({ prompt, effort: $('#effort-select').value, mode }),
    });
    if (!response.ok || !response.body) {
      const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
      throw new Error(payload?.error?.message || `任务启动失败 (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n'); buffer = frames.pop() || '';
      for (const frame of frames) {
        let event = 'message'; let data = null;
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) { try { data = JSON.parse(line.slice(5)); } catch { data = {}; } }
        }
        if (!data) continue;
        if (event === 'assistant_delta') {
          entry.text += data.delta || ''; renderLiveTurn(entry);
        } else if (event === 'tool_started') {
          entry.events.push({ callId: data.callId, name: data.name, done: false }); renderActivity(entry);
        } else if (event === 'tool_completed') {
          const tool = entry.events.find((item) => item.callId === data.callId); if (tool) tool.done = true; renderActivity(entry);
        } else if (event === 'turn_status') {
          entry.statusText = data.status === 'running' ? `Codex 正在执行 · ${entry.mode.toUpperCase()}` : 'Codex 正在启动…'; renderActivity(entry);
        } else if (event === 'turn_queued') {
          entry.statusText = `${data.mode} 正在排队 · 前方 ${Math.max(0, Number(data.position) - 1)} 个任务`;
          updateCapacity({ activeExecuteLeases: data.executeLeases, maxExecuteLeases: data.maxExecuteLeases });
          renderActivity(entry);
        } else if (event === 'approval_required') {
          entry.approvals.push({ id: data.approvalId, kind: data.kind, request: data.request });
          if (state.selectedChat?.id === chat.id) renderApprovals(entry.approvals);
          entry.statusText = '等待你批准操作…'; renderActivity(entry);
        } else if (event === 'approval_resolved') {
          entry.approvals = entry.approvals.filter((approval) => approval.id !== data.approvalId);
          if (state.selectedChat?.id === chat.id) renderApprovals(entry.approvals);
          entry.statusText = 'Codex 继续执行…'; renderActivity(entry);
        } else if (event === 'plan_updated') {
          entry.plan = data.plan || [];
          if (state.selectedChat?.id === chat.id) renderPlanDiff(entry.plan, entry.diff);
        } else if (event === 'diff_updated') {
          entry.diff = data.diff || '';
          if (state.selectedChat?.id === chat.id) renderPlanDiff(entry.plan, entry.diff);
        } else if (event === 'subagent_updated') {
          const count = Number(data.count) > 0 ? `${data.count}/${data.limit || 3}` : `上限 ${data.limit || 3}`;
          entry.events.push({ name: `子代理 ${count} · ${data.model || 'gpt-5.6-luna'}`, done: data.phase === 'completed' });
          renderActivity(entry);
        } else if (event === 'native_item') {
          const item = data.item || {};
          const label = item.type === 'fileChange' ? '原生文件 diff' : item.type === 'commandExecution' ? '原生命令' : item.tool || item.type;
          const existing = entry.events.find((value) => value.callId === item.id);
          if (existing) existing.done = data.phase === 'completed';
          else entry.events.push({ callId: item.id, name: label, done: data.phase === 'completed' });
          renderActivity(entry);
        } else if (event === 'turn_error' || event === 'codex_error') {
          throw new Error(data.message || 'Codex 任务失败');
        }
      }
    }
  } catch (error) {
    if (state.selectedChat?.id === chat.id) appendMessage('error', error.message);
    toast(`${chat.title}: ${error.message}`, 'error');
  } finally {
    state.runningTurns.delete(chat.id);
    const visibleChat = state.selectedChat?.id === chat.id;
    if (visibleChat) state.selectedChat.status = 'idle';
    updateConcurrencyIndicator(); renderActivity(state.runningTurns.get(state.selectedChat?.id)); setComposer(true);
    if (state.selectedProject) await loadChats();
    if (visibleChat) {
      const data = await api(`/api/chats/${chat.id}`);
      state.selectedChat = data.chat; state.selectedTask = data.task || null;
      renderMessages(data.messages); setComposer(true); await refreshTurnInsights();
    }
    await loadTasks();
    if (state.selectedProject?.id === project.id) await Promise.all([loadFiles(), refreshUsage()]);
  }
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
        state.fileContent = file.content; $('#file-editor').value = file.content;
      } catch (error) {
        if (error.code !== 'BINARY_FILE') throw error;
      }
    }
    state.viewerMode = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.sh', '.py', '.java', '.go', '.rs', '.yaml', '.yml', '.toml'].includes(extension) ? 'source' : 'preview';
    $('#editor-path').textContent = filePath;
    $('#download-file').href = rawFileUrl(filePath); $('#download-file').download = filePath.split('/').pop();
    $('#editor-pane').classList.remove('hidden'); $('#file-tree-resizer').classList.remove('hidden'); $('.files-panel').classList.remove('viewer-closed');
    updateViewerControls();
    if (state.viewerMode === 'preview') await renderFilePreview();
    await loadFiles();
  } catch (error) { toast(error.message, 'error'); }
}

async function writeFile(filePath, content) {
  await api(`/api/projects/${state.selectedProject.id}/file?path=${encodeURIComponent(filePath)}`, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: content,
  });
  if (state.selectedFile === filePath && typeof content === 'string') state.fileContent = content;
  await loadFiles();
  if (state.selectedFile === filePath && state.viewerMode === 'preview') await renderFilePreview();
  toast(`已保存 ${filePath}`);
}

function switchView(view) {
  $('#tasks-view').classList.toggle('hidden', view !== 'tasks');
  $('#workbench-view').classList.toggle('hidden', view !== 'workbench');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
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
    await api('/api/login', { method: 'POST', body: { username: $('#login-username').value, password: $('#login-password').value } });
    $('#login-password').value = ''; await bootstrap();
  } catch (error) { $('#login-error').textContent = error.message; }
});

$('#logout-button').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { showLogin(); } });
$('#boss-nav').addEventListener('click', () => location.assign('/boss.html'));
$$('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$('#refresh-tasks').addEventListener('click', () => Promise.all([loadTasks(), loadProjects()]).then(renderTasks).catch((error) => toast(error.message, 'error')));

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
  const button = event.target.closest('.submit-task-button');
  if (!button || !state.selectedTask || !state.selectedChat) return;
  state.pendingSubmission = {
    taskId: state.selectedTask.id, taskVersion: Number(button.dataset.taskVersion), chatId: state.selectedChat.id,
    turnRunId: button.dataset.turnRunId, itemId: button.dataset.itemId,
  };
  $('#submit-form').reset();
  $('.form-error', $('#submit-form')).textContent = '';
  $('#submit-summary').textContent = `${state.selectedTask.title} · V${state.selectedTask.version}。将保存这条最终回复及本轮 diff 的不可变快照。`;
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

$('#new-chat').addEventListener('click', async () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  const title = window.prompt('对话标题', '新任务'); if (!title) return;
  try { const data = await api(`/api/projects/${state.selectedProject.id}/chats`, { method: 'POST', body: { title } }); await loadChats(); await selectChat(data.chat); } catch (error) { toast(error.message, 'error'); }
});

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault(); const prompt = $('#prompt-input').value.trim(); if (!prompt || selectedChatRunning()) return;
  $('#prompt-input').value = ''; $('#prompt-input').style.height = ''; void sendTurn(prompt).catch((error) => toast(error.message, 'error'));
});
$('#prompt-input').addEventListener('input', (event) => { event.target.style.height = 'auto'; event.target.style.height = `${Math.min(180, event.target.scrollHeight)}px`; });
$('#prompt-input').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') $('#composer').requestSubmit(); });
$('#stop-turn').addEventListener('click', async () => { if (state.selectedChat) await api(`/api/chats/${state.selectedChat.id}/interrupt`, { method: 'POST' }); });

$('#refresh-files').addEventListener('click', () => state.selectedProject && loadFiles());
$('#preview-tab').addEventListener('click', () => setViewerMode('preview').catch((error) => toast(error.message, 'error')));
$('#source-tab').addEventListener('click', () => setViewerMode('source').catch((error) => toast(error.message, 'error')));
$('#save-file').addEventListener('click', () => state.selectedFile && writeFile(state.selectedFile, $('#file-editor').value).catch((error) => toast(error.message, 'error')));
$('#new-file').addEventListener('click', async () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  const filePath = window.prompt('项目内文件路径', 'src/index.js'); if (!filePath) return;
  try { await writeFile(filePath, ''); await openFile(filePath); } catch (error) { toast(error.message, 'error'); }
});
$('#new-folder').addEventListener('click', async () => {
  if (!state.selectedProject) return toast('请先选择项目', 'error');
  const folder = window.prompt('项目内目录路径', 'src'); if (!folder) return;
  try { await api(`/api/projects/${state.selectedProject.id}/directory`, { method: 'POST', body: { path: folder } }); await loadFiles(); } catch (error) { toast(error.message, 'error'); }
});
$('#upload-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]; if (!file || !state.selectedProject) return;
  const destination = window.prompt('上传到项目路径', file.name); if (!destination) return;
  try { await writeFile(destination, await file.arrayBuffer()); } catch (error) { toast(error.message, 'error'); } finally { event.target.value = ''; }
});
$('#delete-file').addEventListener('click', async () => {
  if (!state.selectedFile || !window.confirm(`将 ${state.selectedFile} 移到可恢复的废纸篓？`)) return;
  try { await api(`/api/projects/${state.selectedProject.id}/file?path=${encodeURIComponent(state.selectedFile)}`, { method: 'DELETE' }); closeViewer(); await loadFiles(); toast('已移到废纸篓'); } catch (error) { toast(error.message, 'error'); }
});

setupResizers(); health(); bootstrap();
