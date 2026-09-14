const views = new Set(['tasks', 'workbench', 'memories']);

export function defaultPage(role) {
  return role === 'admin' ? '/boss/workbench?view=tasks' : '/employee?view=tasks';
}

export function safeReturnTo(value, role) {
  const fallback = defaultPage(role);
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return fallback;
  const url = new URL(value, 'https://portal.invalid');
  const allowed = role === 'admin' ? ['/boss', '/boss/workbench'] : ['/employee'];
  if (url.origin !== 'https://portal.invalid' || !allowed.includes(url.pathname)) return fallback;
  const params = new URLSearchParams();
  for (const key of ['view', 'project', 'chat']) {
    const item = url.searchParams.get(key);
    if (item && (key !== 'view' || views.has(item))) params.set(key, item.slice(0, 128));
  }
  return `${url.pathname}${params.size ? `?${params}` : ''}${['#overview', '#people', '#projects', '#audit'].includes(url.hash) ? url.hash : ''}`;
}

export function loginPage(pathname, current = '') {
  const boss = pathname.startsWith('/boss');
  const role = boss ? 'admin' : 'user';
  const base = boss ? '/boss/login' : '/employee';
  return `${base}?returnTo=${encodeURIComponent(safeReturnTo(current, role))}`;
}

export function readView(search = '') {
  const params = new URLSearchParams(search);
  return { view: views.has(params.get('view')) ? params.get('view') : params.has('project') ? 'workbench' : 'tasks',
    project: params.get('project'), chat: params.get('chat') };
}

export function viewUrl(pathname, { view, project, chat }) {
  const params = new URLSearchParams({ view: views.has(view) ? view : 'tasks' });
  if (project) params.set('project', project);
  if (project && chat) params.set('chat', chat);
  return `${pathname}?${params}`;
}

// Selection generations reject A→B→A stale reads as well as ordinary A→B races.
export class SelectionClock {
  version = 0;
  next() { return ++this.version; }
  current(version) { return this.version === version; }
}
