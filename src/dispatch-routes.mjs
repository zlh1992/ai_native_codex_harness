import { invariant } from './errors.mjs';
import { readBody, readJson, sendJson } from './http-utils.mjs';
import { MATERIAL_LIMIT } from './task-materials.mjs';
import { rasterType } from './raster-image.mjs';

export function createDispatchRoutes({ config, db, service, materials, requireMutation, refreshSession }) {
  return async (req, res, url, session) => {
    const route = url.pathname;
    if (!/^\/api\/(task-dispatches|task-notifications|task-materials|projects\/[^/]+\/materials|tasks\/[^/]+\/inputs)(?:\/|$)/.test(route)) return false;
    invariant(config.taskDispatchEnabled, 404, 'DISPATCH_DISABLED', '任务资料功能尚未启用。');
    const reply = (status, data) => sendJson(res, status, data, config);
    const bodyFor = async () => { requireMutation(req, session); const body = await readJson(req, 256 * 1024); session = refreshSession(session); return body; };
    let match = route.match(/^\/api\/projects\/([^/]+)\/materials(?:\/(capture|pack))?$/);
    if (match) {
      const project = materials.access(session.user.id, match[1]);
      const chatId = url.searchParams.get('chat');
      if (req.method === 'GET') reply(200, { materials: materials.list(session.user.id, project.id, chatId) });
      else if (req.method === 'POST' && match[2]) {
        const body = await bodyFor(); materials.access(session.user.id, project.id, project.accessId);
        const input = { ...body, userId: session.user.id, projectId: project.id, chatId };
        const file = match[2] === 'capture' ? materials.capture(input) : await materials.pack({ ...input, authorize: () => { session = refreshSession(session); materials.access(session.user.id, project.id, project.accessId); } });
        session = refreshSession(session); materials.access(session.user.id, project.id, project.accessId); reply(201, { material: file });
      } else if (req.method === 'POST') {
        requireMutation(req, session);
        const bytes = await readBody(req, MATERIAL_LIMIT);
        session = refreshSession(session); materials.access(session.user.id, project.id, project.accessId);
        reply(201, { material: materials.storeFile({ userId: session.user.id, projectId: project.id, chatId, bytes,
          name: url.searchParams.get('name'), idempotencyKey: req.headers['idempotency-key'] }) });
      } else return false;
      return true;
    }
    if (route === '/api/task-dispatches') {
      if (req.method === 'POST') reply(202, { dispatch: service.request(session.user.id, await bodyFor()) });
      else if (req.method === 'GET') {
        const chat = db.getChat(url.searchParams.get('chat'));
        invariant(chat?.userId === session.user.id, 403, 'CHAT_FORBIDDEN', '对话不可访问。');
        reply(200, { dispatches: service.list(session.user.id, chat.id) });
      } else return false;
      return true;
    }
    match = route.match(/^\/api\/task-dispatches\/([^/]+)$/);
    if (match && req.method === 'GET') { reply(200, { dispatch: service.receipt(match[1], session.user.id) }); return true; }
    if (route === '/api/task-notifications' && req.method === 'GET') { reply(200, { notifications: materials.notifications(session.user.id) }); return true; }
    match = route.match(/^\/api\/task-notifications\/([^/]+)\/read$/);
    if (match && req.method === 'POST') {
      await bodyFor();
      const notification = materials.notifications(session.user.id).find(n => n.id === match[1]);
      invariant(notification, 404, 'NOTIFICATION_NOT_FOUND', '提醒不可访问。');
      db.db.prepare('UPDATE task_notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?')
        .run(new Date().toISOString(), notification.id, session.user.id); reply(200, { ok: true }); return true;
    }
    match = route.match(/^\/api\/tasks\/([^/]+)\/inputs(?:\/([^/]+))?$/);
    if (match) {
      materials.taskAccess(match[1], session.user.id);
      if (req.method === 'POST' && !match[2]) reply(201, { inputs: materials.append(match[1], session.user.id, await bodyFor()) });
      else if (req.method === 'GET' && !match[2]) reply(200, { inputs: materials.current(match[1]) });
      else if (req.method === 'GET') {
        const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : null;
        const file = materials.readTask(match[1], session.user.id, match[2], revision);
        if (url.searchParams.get('preview') === '1') {
          const mimeType = rasterType(file.bytes);
          invariant(mimeType, 415, 'PREVIEW_UNSUPPORTED', '此文件请下载查看；仅支持位图预览。');
          res.writeHead(200, { 'content-type': mimeType, 'content-length': file.bytes.length,
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
          res.end(file.bytes);
        } else if (url.searchParams.get('download') === '1') {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.bytes.length,
            'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" });
          res.end(file.bytes);
        } else {
          const text = await materials.text(file); session = refreshSession(session); materials.taskAccess(match[1], session.user.id);
          reply(200, { file: { ...text, mimeType: rasterType(file.bytes) } });
        }
      } else return false;
      return true;
    }
    return false;
  };
}
