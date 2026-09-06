const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { me: null, csrf: '', data: null, pendingRevoke: null };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function formatBytes(value) {
  let amount = Number(value || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit && amount < 10 ? 2 : unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(value) {
  return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '从未';
}

function toast(message, kind = '') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('#toast-stack').append(node);
  setTimeout(() => node.remove(), 4500);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && typeof options.body !== 'string') {
    headers.set('content-type', 'application/json');
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== 'GET') headers.set('x-csrf-token', state.csrf);
  const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
  const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401) location.replace('/boss/login');
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

function employees() {
  return (state.data?.users || []).filter((user) => user.role === 'user');
}

function renderMetrics() {
  const { stats, codex } = state.data;
  const staff = employees();
  const myProjects = state.data.projects.filter((project) => project.userId === state.me.id);
  const cards = [
    ['今日活跃', stats.todayActiveUsers, `共 ${staff.filter((user) => user.status === 'active').length} 个启用员工`],
    ['员工账号', staff.length, '账号管理不授予内容权限'],
    ['我的项目', myProjects.length, `全公司 ${stats.projects} 个项目`],
    ['有效共享', stats.activeShares, '每名员工一个独立 worktree'],
    ['活跃 root turn', stats.runningChats, `Portal 全局上限 ${codex.maxRootTurns || 11}`],
    ['执行服务', codex.ready ? '在线' : '启动中', codex.ready ? `${codex.activeTurns || 0} 个活动任务` : 'Codex app-server'],
  ];
  $('#metric-grid').innerHTML = cards.map(([label, value, note]) => `<article class="metric"><small>${label}</small><b>${escapeHtml(value)}</b><span>${escapeHtml(note)}</span></article>`).join('');
}

function renderEmployees() {
  const list = employees();
  $('#employee-table').innerHTML = list.map((user) => `<tr>
    <td><b>${escapeHtml(user.displayName)}</b><small>@${escapeHtml(user.username)}</small></td>
    <td><span class="status ${user.status}">${user.status === 'active' ? '启用' : '停用'}</span></td>
    <td>${user.networkAccess ? '允许' : '关闭'}</td>
    <td>${user.projectCount} 自有 / ${user.sharedProjectCount || 0} 共享</td>
    <td>${formatBytes(user.usage?.bytes)}<small> / ${formatBytes(user.maxStorageBytes)}</small></td>
    <td>${formatDate(user.lastLoginAt)}</td>
    <td><button class="secondary" data-edit-user="${user.id}">管理</button></td>
  </tr>`).join('') || '<tr><td colspan="7" class="empty">还没有员工账号。</td></tr>';
  $$('[data-edit-user]').forEach((button) => button.addEventListener('click', () => openUser(list.find((user) => user.id === button.dataset.editUser))));
}

function employeeOptions(excluded = new Set()) {
  const list = employees().filter((user) => user.status === 'active' && !excluded.has(user.id));
  return `<option value="">选择员工…</option>${list.map((user) => `<option value="${user.id}">${escapeHtml(user.displayName)} (@${escapeHtml(user.username)})</option>`).join('')}`;
}

function renderProjects() {
  const projects = state.data.projects;
  $('#project-grid').innerHTML = projects.map((project) => {
    const mine = project.userId === state.me.id;
    const shares = project.sharedAccesses || [];
    const sharedUserIds = new Set(shares.map((access) => access.userId));
    const shareRows = shares.map((access) => `<div class="share-row"><span class="share-state">${escapeHtml(access.displayName || access.username)} (@${escapeHtml(access.username)}) · 独立文件与对话 · 基线 ${escapeHtml((access.baseSha || 'unknown').slice(0, 12))}</span><button class="secondary danger" data-revoke="${project.id}" data-access="${access.id}">撤权</button></div>`).join('');
    let actions = '<span class="share-state">🔒 老板无内容访问权</span>';
    if (mine) {
      if (project.repoKind !== 'git') {
        actions = `<button class="primary" data-init-git="${project.id}">初始化 Git</button><a class="secondary" href="/boss/workbench?project=${project.id}">打开</a>`;
      } else {
        const available = employees().some((user) => user.status === 'active' && !sharedUserIds.has(user.id));
        actions = `${shareRows}<p class="share-state">新共享包含当前文件与老板已有全部对话；双方后续独立。</p><div class="share-add">${available ? `<select data-share-user="${project.id}">${employeeOptions(sharedUserIds)}</select><button class="primary" data-grant="${project.id}">共享 / 恢复</button>` : ''}<a class="secondary" href="/boss/workbench?project=${project.id}">打开</a></div>`;
      }
    }
    return `<article class="project-card ${mine ? 'mine' : ''}">
      <div class="project-top"><div><h3>${escapeHtml(project.name)}</h3><p>${escapeHtml(project.description || project.slug)}</p></div><span class="scope-tag">${mine ? 'OWNER' : 'METADATA ONLY'}</span></div>
      <div class="project-meta"><div><small>所有者</small><b>${escapeHtml(project.displayName || project.username)}</b></div><div><small>授权工作树</small><b>${shares.length ? `${shares.length} 个独立 worktree` : project.repoKind === 'git' ? 'Git ready' : '未初始化 Git'}</b></div></div>
      <div class="project-actions">${actions}</div>
    </article>`;
  }).join('') || '<div class="empty">还没有项目。</div>';

  $$('[data-grant]').forEach((button) => button.addEventListener('click', () => grant(button.dataset.grant, button.dataset.grantUser)));
  $$('[data-revoke]').forEach((button) => button.addEventListener('click', () => requestRevoke(button.dataset.revoke, button.dataset.access)));
  $$('[data-init-git]').forEach((button) => button.addEventListener('click', () => initializeGit(button.dataset.initGit)));
}

function renderAudit(entries) {
  $('#audit-list').innerHTML = entries.map((entry) => `<div class="audit-row"><time>${formatDate(entry.createdAt)}</time><div><b>${escapeHtml(entry.action)}</b><span>${escapeHtml(entry.actorUsername)} · ${escapeHtml(entry.targetType)} ${escapeHtml(entry.targetId || '')}</span></div></div>`).join('') || '<div class="empty">暂无审计记录。</div>';
}

async function load() {
  const data = await api('/api/admin/dashboard');
  state.data = data;
  $('[name=maxConcurrentTurns]', $('#user-form')).max = String(data.codex.maxConcurrentTurns || 40);
  $('#boss-chip').textContent = `${state.me.displayName} · 超级账户`;
  $('#codex-light').classList.toggle('online', data.codex.ready);
  $('#codex-label').textContent = data.codex.ready ? 'Codex 在线' : '服务已启动 / Codex 连接中';
  renderMetrics();
  renderEmployees();
  renderProjects();
  await loadAudit();
}

async function loadAudit() {
  const data = await api('/api/admin/audit?limit=120');
  renderAudit(data.audit);
}

function openUser(user = null) {
  const form = $('#user-form');
  form.reset();
  $('[name=id]', form).value = user?.id || '';
  $('[name=username]', form).value = user?.username || '';
  $('[name=username]', form).disabled = Boolean(user);
  $('[name=displayName]', form).value = user?.displayName || '';
  $('[name=password]', form).required = !user;
  $('[name=maxProjects]', form).value = user?.maxProjects || 100;
  $('[name=maxStorageGb]', form).value = Math.max(1, Math.round((user?.maxStorageBytes || 2 * 1024 ** 3) / 1024 ** 3));
  $('[name=maxConcurrentTurns]', form).value = user?.maxConcurrentTurns || 40;
  $('[name=networkAccess]', form).checked = Boolean(user?.networkAccess);
  $('[name=active]', form).checked = !user || user.status === 'active';
  $('#status-field').classList.toggle('hidden', !user);
  $('#user-dialog-title').textContent = user ? `管理 ${user.username}` : '创建员工';
  $('.form-error', form).textContent = '';
  $('#user-dialog').showModal();
}

async function grant(projectId, fixedUserId = '') {
  const select = $(`[data-share-user="${projectId}"]`);
  const userId = fixedUserId || select?.value;
  if (!userId) return toast('先选择一名员工。', 'error');
  try {
    const result = await api(`/api/admin/projects/${projectId}/shares`, { method: 'POST', body: { userId } });
    toast(result.restored ? '已恢复该员工原有 worktree、对话与授权。' : `已从 Git 基线 ${String(result.access?.baseSha || '').slice(0, 12)} 创建独立 worktree，已复制 ${result.copiedChats || 0} 段对话。`);
    await load();
  } catch (error) { toast(error.message, 'error'); }
}

function requestRevoke(projectId, accessId) {
  state.pendingRevoke = { projectId, accessId };
  $('.form-error', $('#confirm-form')).textContent = '';
  $('#confirm-dialog').showModal();
}

async function revoke(projectId, accessId) {
  const result = await api(`/api/admin/projects/${projectId}/shares/${accessId}`, { method: 'DELETE' });
  toast(result.cleanup.dirty ? '权限已撤销；检测到未提交修改，工作树已保留。' : '权限已撤销，干净工作树已移除。');
  await load();
}

async function initializeGit(projectId) {
  try {
    await api(`/api/admin/projects/${projectId}/initialize-git`, { method: 'POST' });
    toast('项目已初始化 Git，可以授权员工。');
    await load();
  } catch (error) { toast(error.message, 'error'); }
}

$('#new-user').addEventListener('click', () => openUser());
$('#new-project').addEventListener('click', () => { $('#project-form').reset(); $('.form-error', $('#project-form')).textContent = ''; $('#project-dialog').showModal(); });
$('#refresh').addEventListener('click', () => load().catch((error) => toast(error.message, 'error')));
$('#refresh-audit').addEventListener('click', () => loadAudit().catch((error) => toast(error.message, 'error')));
$('#logout').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } finally { location.replace('/boss/login'); } });

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    state.pendingRevoke = null;
    $('#confirm-dialog').close();
    return;
  }
  if (!state.pendingRevoke) return;
  const target = event.currentTarget;
  const pending = state.pendingRevoke;
  const submit = event.submitter || $('#confirm-dialog-submit');
  submit.disabled = true;
  try {
    await revoke(pending.projectId, pending.accessId);
    state.pendingRevoke = null;
    $('#confirm-dialog').close();
  } catch (error) {
    $('.form-error', target).textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('#user-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#user-dialog').close();
  const target = event.currentTarget;
  const form = new FormData(target);
  const id = form.get('id');
  const body = {
    displayName: form.get('displayName'),
    maxProjects: Number(form.get('maxProjects')),
    maxStorageBytes: Number(form.get('maxStorageGb')) * 1024 ** 3,
    maxConcurrentTurns: Number(form.get('maxConcurrentTurns')),
    networkAccess: form.get('networkAccess') === 'on',
  };
  if (!id) body.username = form.get('username');
  if (form.get('password')) body.password = form.get('password');
  if (id) body.status = form.get('active') === 'on' ? 'active' : 'disabled';
  try {
    await api(id ? `/api/admin/users/${id}` : '/api/admin/users', { method: id ? 'PATCH' : 'POST', body });
    $('#user-dialog').close();
    toast(id ? '员工策略已更新。' : '员工账号已创建。');
    await load();
  } catch (error) { $('.form-error', target).textContent = error.message; }
});

$('#project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') return $('#project-dialog').close();
  const target = event.currentTarget;
  const form = new FormData(target);
  try {
    await api('/api/projects', { method: 'POST', body: { name: form.get('name'), description: form.get('description') } });
    $('#project-dialog').close();
    toast('老板项目已创建并初始化 Git。');
    await load();
  } catch (error) { $('.form-error', target).textContent = error.message; }
});

async function bootstrap() {
  try {
    const data = await api('/api/me');
    if (data.user.role !== 'admin') return location.replace('/employee');
    state.me = data.user;
    state.csrf = data.csrfToken;
    await load();
  } catch (error) {
    if (!state.me) location.replace('/boss/login');
    else toast(error.message, 'error');
  }
}

bootstrap();
