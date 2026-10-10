import { TokenDashboard } from './token-dashboard.js';
import { KanbanBoard } from './kanban.js';
import { loginPage, defaultPage } from './navigation.js';
import { createSessionClient, setAuthState, watchSession } from './session-ui.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { me: null, csrf: '', data: null, pendingRevoke: null, pendingMemoryShare: null };
let employeeBoard; let checkingSession = false;
const tokenDashboard = new TokenDashboard({ root: $('#token-usage'), api });
const sessionClient = createSessionClient({ getCsrf: () => state.csrf, onExpired: expireSession });
const sessionChanges = watchSession(bootstrap);
function expireSession() {
  tokenDashboard.stop();
  sessionClient.reset(); employeeBoard?.destroy(); employeeBoard = null;
  state.me = null; state.csrf = ''; state.data = null; state.pendingRevoke = null; state.pendingMemoryShare = null;
  for (const dialog of $$('dialog')) { if (dialog.open) dialog.close(); }
  for (const form of $$('form')) form.reset();
  for (const id of ['employee-board', 'employee-table', 'project-grid', 'audit-list', 'metric-grid']) $(`#${id}`).replaceChildren();
  setAuthState('checking');
  location.replace(loginPage(location.pathname, `${location.pathname}${location.search}${location.hash}`));
}

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
  return sessionClient.request(url, options);
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
  const query = $('#employee-search').value.trim().toLocaleLowerCase();
  const list = employees().filter(user => `${user.displayName} ${user.username} ${user.profile?.jobTitle || ''}`.toLocaleLowerCase().includes(query));
  employeeBoard ||= new KanbanBoard($('#employee-board'), { key: `${state.me.id}:employees`, onOpen: id => openUser(employees().find(user => user.id === id)) });
  employeeBoard.render([{ id: 'available', title: '可安排', tone: 'done' }, { id: 'limited', title: '有限可用', tone: 'active' },
    { id: 'unavailable', title: '暂不可用', tone: 'blocked' }, { id: 'disabled', title: '已停用', tone: 'waiting' }], employees().map(user => ({
    id: user.id, column: user.status === 'disabled' ? 'disabled' : user.profile?.availability || 'available',
    title: user.displayName, tag: user.profile?.jobTitle || '未设置岗位', person: `@${user.username}`,
    description: `${user.projectCount || 0} 个自有项目 · ${user.sharedProjectCount || 0} 个共享项目\n${(user.profile?.skills || []).join(' · ')}`,
    meta: `空间 ${formatBytes(user.usage?.bytes)}`, search: `${user.displayName} ${user.username} ${user.profile?.jobTitle || ''}`,
  })), query);
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
      if (project.projectType === 'local_private') {
        actions = `<span class="share-state">隐私项目 · 本地 Qwen + DSH · 永不可分享</span><a class="secondary" href="/boss/workbench?project=${project.id}">打开</a>`;
      } else if (project.repoKind !== 'git') {
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
  tokenDashboard.start(data.users);
  renderEmployees();
  renderProjects();
  await loadAudit();
}

async function loadAudit() {
  const data = await api('/api/admin/audit?limit=120');
  renderAudit(data.audit);
}

async function openUser(user = null) {
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
  const save = $('[value=default]', form);
  save.disabled = true;
  form.dataset.profileRevision = '0';
  $('#employee-profile-fields').classList.toggle('hidden', user?.role === 'admin');
  $('#user-dialog').showModal();
  try {
    const profile = user?.role === 'user' ? (await api(`/api/admin/users/${user.id}/profile`)).profile : {};
    if ($('[name=id]', form).value !== (user?.id || '')) return;
    for (const key of ['jobTitle', 'responsibilities', 'deliveryPreference', 'notes']) $('[name=' + key + ']', form).value = profile[key] || '';
    $('[name=skills]', form).value = (profile.skills || []).join(', ');
    $('[name=availability]', form).value = profile.availability || 'available';
    form.dataset.profileRevision = String(profile.revision || 0);
    form.dataset.employeeProfile = String(user?.role !== 'admin');
    save.disabled = false;
  } catch (error) { $('.form-error', form).textContent = error.message; }
}

async function grant(projectId, fixedUserId = '', memoryConfirmationToken = null) {
  const select = $(`[data-share-user="${projectId}"]`);
  const userId = fixedUserId || select?.value;
  if (!userId) return toast('先选择一名员工。', 'error');
  try {
    const body = { userId, scope: 'files_and_history', ...(memoryConfirmationToken ? { memoryConfirmationToken } : {}) };
    let result;
    try {
      result = await api(`/api/admin/projects/${projectId}/shares`, { method: 'POST', body });
    } catch (error) {
      if (error.code !== 'MEMORY_SHARE_CONFIRMATION_REQUIRED') throw error;
      const employee = employees().find((user) => user.id === userId);
      state.pendingMemoryShare = { projectId, userId, token: error.details?.confirmationToken };
      state.pendingRevoke = null;
      $('#confirm-form .eyebrow').textContent = 'SHARE PRIVATE CONTEXT';
      $('#confirm-form h2').textContent = '确认分享跨项目记忆上下文';
      $('#confirm-message').textContent = `待分享对话包含 ${error.details?.memoryCount || 0} 条来自其他项目的私有记忆引用。接收者：${employee?.displayName || employee?.username || userId}。继续将分享当前对话快照；内容变化后必须重新确认。`;
      $('#confirm-dialog-submit').textContent = '确认分享';
      $('.form-error', $('#confirm-form')).textContent = '';
      $('#confirm-dialog').showModal();
      return;
    }
    toast(result.restored ? '已恢复该员工原有 worktree、对话与授权。' : `已从 Git 基线 ${String(result.access?.baseSha || '').slice(0, 12)} 创建独立 worktree，已复制 ${result.copiedChats || 0} 段对话。`);
    await load();
  } catch (error) { toast(error.message, 'error'); }
}

function requestRevoke(projectId, accessId) {
  state.pendingRevoke = { projectId, accessId };
  state.pendingMemoryShare = null;
  $('#confirm-form .eyebrow').textContent = 'REVOKE ACCESS';
  $('#confirm-form h2').textContent = '撤销项目访问';
  $('#confirm-message').textContent = '员工将立即失去访问权；未提交的脏工作树会保留。';
  $('#confirm-dialog-submit').textContent = '确认撤权';
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
$('#logout').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await api('/api/logout', { method: 'POST', sessionCheck: true }); sessionChanges.announce(); expireSession(); }
  catch (error) { if (error.status === 401) { sessionChanges.announce(); expireSession(); } else toast('退出未确认，请重试；当前登录状态未被清除。', 'error'); }
  finally { button.disabled = false; }
});
$('#employee-search').addEventListener('input', renderEmployees);
$$('[data-people-view]').forEach(button => button.addEventListener('click', () => {
  const board = button.dataset.peopleView === 'board';
  $('#employee-board').hidden = !board; $('#employee-table-view').hidden = board;
  $$('[data-people-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));
function highlightSection() { const hash = location.hash || '#overview'; $$('.cockpit-bar nav a').forEach(link => link.classList.toggle('nav-active', link.getAttribute('href') === hash)); }
window.addEventListener('hashchange', highlightSection); highlightSection();

$('#confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') {
    state.pendingRevoke = null;
    state.pendingMemoryShare = null;
    $('#confirm-dialog').close();
    return;
  }
  if (!state.pendingRevoke && !state.pendingMemoryShare) return;
  const target = event.currentTarget;
  const pending = state.pendingRevoke;
  const pendingShare = state.pendingMemoryShare;
  const submit = event.submitter || $('#confirm-dialog-submit');
  submit.disabled = true;
  try {
    if (pendingShare) await grant(pendingShare.projectId, pendingShare.userId, pendingShare.token);
    else await revoke(pending.projectId, pending.accessId);
    state.pendingRevoke = null; state.pendingMemoryShare = null;
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
    const saved = await api(id ? `/api/admin/users/${id}` : '/api/admin/users', { method: id ? 'PATCH' : 'POST', body });
    // Keep the created account identity if the independent profile save needs retrying.
    $('[name=id]', target).value = saved.user.id;
    $('[name=username]', target).disabled = true;
    $('[name=password]', target).required = false;
    $('[name=password]', target).value = '';
    if (target.dataset.employeeProfile === 'true') {
      const profile = Object.fromEntries(['jobTitle', 'responsibilities', 'deliveryPreference', 'availability', 'notes'].map(key => [key, form.get(key)]));
      profile.skills = String(form.get('skills') || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
      profile.revision = Number(target.dataset.profileRevision);
      const result = await api(`/api/admin/users/${saved.user.id}/profile`, { method: 'PATCH', body: profile });
      target.dataset.profileRevision = String(result.profile.revision);
    }
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
  if (checkingSession) return;
  checkingSession = true; setAuthState('checking');
  try {
    const data = await api('/api/me', { sessionCheck: true, timeoutMs: 12_000 });
    if (data.user.role !== 'admin') return location.replace(defaultPage('user'));
    if (state.me?.id === data.user.id) { state.csrf = data.csrfToken; setAuthState('authenticated'); return; }
    state.me = data.user;
    state.csrf = data.csrfToken;
    await load();
    setAuthState('authenticated');
  } catch (error) {
    if (error.status === 401) expireSession();
    else setAuthState('error', '暂时无法连接服务，请重试；不会因此退出登录。', () => { state.me = null; bootstrap(); });
  } finally { checkingSession = false; }
}

bootstrap();
