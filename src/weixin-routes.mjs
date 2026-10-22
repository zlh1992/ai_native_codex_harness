import { invariant } from './errors.mjs';
import { readJson, sendJson } from './http-utils.mjs';

export function createWeixinRoutes({ config, service, requireMutation, refreshSession }) {
  return async (req, res, url, session) => {
    if (url.pathname !== '/api/me/weixin') return false;
    invariant(service.enabledFor(session.user.id) && config.taskDispatchEnabled, 404, 'WEIXIN_DISABLED', '微信入口尚未启用。');
    let result;
    if (req.method === 'GET') result = service.public(session.user.id);
    else {
      requireMutation(req, session); const body = await readJson(req, 4096); session = refreshSession(session);
      if (req.method === 'POST') result = service.bind(session.user.id, body.projectId, () => { session = refreshSession(session); });
      else if (req.method === 'PATCH') result = service.switchProject(session.user.id, body.projectId);
      else if (req.method === 'DELETE') { service.revoke(session.user.id); result = { connection: null }; }
      else return false;
    }
    sendJson(res, 200, result, config); return true;
  };
}
