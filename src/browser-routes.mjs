import { readJson, sendJson, securityHeaders } from './http-utils.mjs';
import { invariant } from './errors.mjs';

export function browserRoutes({ codex, config, chatFor, requireMutation, refreshSession, checkOrigin, projectFor }) {
  return async (req, res, url, session) => {
    const match = url.pathname.match(/^\/api\/chats\/([^/]+)\/browser(?:\/(frame|actions|control))?$/);
    if (!match) return false;
    checkOrigin(req);
    if (req.method !== 'GET') requireMutation(req, session);
    const body = req.method === 'POST' ? await readJson(req, 32 * 1024) : {};
    session = refreshSession(session); const chat = chatFor(session, match[1]);
    const browser = codex.browser;
    const active = browser.sessions.get(chat.id)?.active || codex.activeByChat.get(chat.id) || {
      manual: true, user: session.user, chat, project: projectFor(session, chat.projectId), mode: chat.preferredMode,
    };
    const state = () => ({ ...browser.state(match[1]), canControl: browser.sessions.get(match[1])?.controller === session.tokenHash });
    const guard = () => { refreshSession(session); chatFor(session, match[1]); browser.authorize(active); };
    if (req.method === 'GET' && !match[2]) {
      if (browser.sessions.has(match[1])) { guard(); const s = browser.sessions.get(match[1]); s.activity = Date.now(); s.viewers.add(session.tokenHash); }
      sendJson(res, 200, state(), config); return true;
    }
    guard();
    if (req.method === 'POST' && !match[2]) {
      await browser.open(active, body.url, { humanToken: session.tokenHash }); guard();
      browser.sessions.get(chat.id).viewers.add(session.tokenHash);
      sendJson(res, 200, state(), config);
    } else if (req.method === 'GET' && match[2] === 'frame') {
      const frame = await browser.frame(active); guard();
      res.writeHead(200, { ...securityHeaders(config), 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' }); res.end(frame);
    } else if (req.method === 'POST' && match[2] === 'actions') {
      const result = await browser.action(active, body, 'human', session.tokenHash); guard(); sendJson(res, 200, result, config);
    } else if (req.method === 'POST' && match[2] === 'control') {
      await browser.control(active, body.decision, session.tokenHash);
      refreshSession(session); chatFor(session, match[1]); sendJson(res, 200, state(), config);
    } else if (req.method === 'DELETE' && !match[2]) {
      await browser.close(match[1], 'user_closed'); sendJson(res, 200, browser.state(match[1]), config);
    } else invariant(false, 405, 'METHOD_NOT_ALLOWED', '浏览器接口不支持此操作。');
    return true;
  };
}
