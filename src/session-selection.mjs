import { invariant } from './errors.mjs';

export const DEFAULT_SESSION_COOKIE = 'codex_harness_session';
export const validSessionSelector = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
export const selectedCookieName = selector => `${DEFAULT_SESSION_COOKIE}_${selector}`;

export function requestSessionCookieName(req) {
  const query = new URL(req.url || '/', 'http://localhost').searchParams.get('portal_session');
  const header = req.headers['x-portal-session'];
  const selector = header ?? query;
  if (selector == null) return DEFAULT_SESSION_COOKIE; // Existing clients and boss portal.
  invariant(validSessionSelector(selector) && (header == null || query == null || header === query),
    401, 'AUTH_REQUIRED', '请在当前标签页登录。');
  return selectedCookieName(selector);
}
