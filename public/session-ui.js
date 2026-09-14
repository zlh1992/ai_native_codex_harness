import { sessionFetch } from './employee-session.js';

export function setAuthState(phase, message = '', retry = null) {
  document.body.dataset.auth = phase;
  const panel = document.querySelector('#auth-status');
  if (!panel) return;
  panel.hidden = !['checking', 'error'].includes(phase);
  panel.querySelector('p').textContent = message || '正在验证登录状态…';
  const button = panel.querySelector('button');
  button.hidden = phase !== 'error'; button.onclick = retry;
}

export function createSessionClient({ getCsrf, onExpired, fetcher = sessionFetch }) {
  let epoch = 0;
  const requests = new Set();
  const reset = () => { epoch++; for (const request of requests) request.abort(); requests.clear(); };
  const stale = () => new DOMException('已忽略过期页面请求', 'AbortError');
  async function request(path, options = {}) {
    const generation = epoch;
    const controller = new AbortController(); requests.add(controller);
    const timeout = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (body && typeof body !== 'string' && !(body instanceof ArrayBuffer) && !(body instanceof Blob)) {
      headers.set('content-type', 'application/json'); body = JSON.stringify(body);
    }
    if (options.method && options.method !== 'GET') headers.set('x-csrf-token', getCsrf());
    try {
      const response = await fetcher(path, { ...options, body, headers, credentials: 'same-origin', signal: controller.signal });
      const payload = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
      if (generation !== epoch) throw stale();
      if (!response.ok) {
        const error = Object.assign(new Error(payload?.error?.message || `请求失败 (${response.status})`),
          { status: response.status, code: payload?.error?.code, details: payload?.error?.details });
        if (response.status === 401 && !path.endsWith('/login') && !options.sessionCheck) { reset(); onExpired(); }
        throw error;
      }
      return payload;
    } catch (error) {
      if (generation !== epoch && error.status !== 401) throw stale();
      throw error;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  return { request, reset, generation: () => epoch };
}

export function watchSession(verify) {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('portal-auth') : null;
  channel?.addEventListener('message', () => verify());
  // BFCache snapshots must never restore an authenticated screen before /me.
  window.addEventListener('pagehide', () => setAuthState('checking'));
  window.addEventListener('pageshow', (event) => { if (event.persisted) verify(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verify(); });
  return { announce: () => channel?.postMessage({ changed: true }) };
}
