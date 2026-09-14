// The selector is not a credential. The corresponding token stays in an HttpOnly cookie.
const key = 'portal.employee.session-selector';
let enabled = false;
let storage;
export function configureEmployeeSession(value, targetStorage) {
  enabled = value;
  if (enabled) {
    try { storage = targetStorage ?? globalThis.sessionStorage; } catch { storage = null; }
  }
}
export function employeeSessionSelector() {
  if (!enabled) return null;
  try { const value = storage?.getItem(key); return /^[a-f0-9]{32}$/.test(value || '') ? value : 'none'; }
  catch { return 'none'; }
}
export function saveEmployeeSession(selector) {
  if (!enabled) return;
  if (!storage || !/^[a-f0-9]{32}$/.test(selector)) throw new Error('请允许当前页面使用标签页存储后再登录。');
  storage.setItem(key, selector);
}
export function clearEmployeeSession() {
  if (enabled) { try { storage?.removeItem(key); } catch { /* No fallback to another account. */ } }
}
export function sessionUrl(path) {
  const selector = employeeSessionSelector();
  if (selector === null || !String(path).startsWith('/api/')) return path;
  return `${path}${String(path).includes('?') ? '&' : '?'}portal_session=${encodeURIComponent(selector)}`;
}
export function sessionFetch(path, options = {}) {
  const selector = employeeSessionSelector();
  if (selector === null || !String(path).startsWith('/api/')) return fetch(path, options);
  const headers = new Headers(options.headers || {}); headers.set('x-portal-session', selector);
  return fetch(path, { ...options, headers });
}
