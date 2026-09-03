#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestToken, hashPassword, newCsrfToken, newSessionToken, parseCookies, safeEqual, verifyPassword } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { CodexService, EFFORTS } from './codex-service.mjs';
import { HarnessDatabase } from './db.mjs';
import { HttpError, invariant } from './errors.mjs';
import { WorkspaceService, slugify } from './fs-service.mjs';
import { readBody, readJson, securityHeaders, sendJson, serveStatic, sse, sseHeaders } from './http-utils.mjs';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INLINE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'], ['.pdf', 'application/pdf'], ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'], ['.csv', 'text/csv; charset=utf-8'], ['.tsv', 'text/tab-separated-values; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
]);

function loadDotEnv(file = path.resolve(CURRENT_DIR, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadDotEnv();
process.umask(0o077);
const config = loadConfig();
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error(`安全策略拒绝非回环监听 HOST=${config.host}；请使用 HTTPS 出站隧道。`);
}
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.workspacesRoot, { recursive: true, mode: 0o700 });
const db = new HarnessDatabase(config);
const workspace = new WorkspaceService(config);
const codex = new CodexService({ config, db, workspace });
const loginAttempts = new Map();

function log(level, message, detail) {
  const record = { time: new Date().toISOString(), level, message, ...(detail ? { detail } : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(record));
}

codex.on('log', (record) => log(record.level || 'info', 'codex', record.message));

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function requestOrigin(req) {
  const proto = config.trustProxy ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0] : 'http';
  return `${proto}://${req.headers.host || `${config.host}:${config.port}`}`;
}

function checkOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  const allowed = new Set([requestOrigin(req)]);
  if (config.publicOrigin) allowed.add(config.publicOrigin);
  invariant(allowed.has(origin), 403, 'ORIGIN_REJECTED', '请求来源不受信任。');
}

function cookie(req, token, maxAge) {
  const forwardedProto = config.trustProxy
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
    : '';
  const secure = config.cookieSecure || forwardedProto === 'https';
  return `codex_harness_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function sessionFor(req) {
  const token = parseCookies(req.headers.cookie).codex_harness_session;
  return token ? db.getSession(digestToken(token)) : null;
}

function requireSession(req) {
  const session = sessionFor(req);
  invariant(session, 401, 'AUTH_REQUIRED', '请先登录。');
  return session;
}

function requireMutation(req, session) {
  checkOrigin(req);
  invariant(safeEqual(req.headers['x-csrf-token'], session.csrfToken), 403, 'CSRF_REJECTED', 'CSRF 校验失败，请刷新页面后重试。');
}

function requireAdmin(session) {
  invariant(session.user.role === 'admin', 403, 'ADMIN_REQUIRED', '此操作仅限超级管理员。');
}

function projectFor(session, id) {
  const project = db.getProject(id);
  invariant(project, 404, 'PROJECT_NOT_FOUND', '项目不存在。');
  invariant(session.user.role === 'admin' || project.userId === session.user.id, 403, 'PROJECT_FORBIDDEN', '无权访问该项目。');
  return project;
}

function chatFor(session, id) {
  const chat = db.getChat(id);
  invariant(chat, 404, 'CHAT_NOT_FOUND', '对话不存在。');
  invariant(session.user.role === 'admin' || chat.userId === session.user.id, 403, 'CHAT_FORBIDDEN', '无权访问该对话。');
  return chat;
}

function validateUsername(value) {
  const username = String(value || '').trim();
  invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(username), 400, 'INVALID_USERNAME', '用户名须为 3–32 位字母、数字、点、下划线或连字符。');
  return username;
}

function shortText(value, field, max = 80) {
  const text = String(value || '').trim();
  invariant(text.length > 0 && text.length <= max, 400, 'INVALID_FIELD', `${field} 长度必须为 1–${max}。`);
  return text;
}

function boundedInteger(value, field, min, max) {
  const number = Number(value);
  invariant(Number.isInteger(number) && number >= min && number <= max, 400, 'INVALID_FIELD', `${field} 必须在 ${min}–${max} 之间。`);
  return number;
}

function loginLimited(ip) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  const recent = (loginAttempts.get(ip) || []).filter((timestamp) => timestamp > cutoff);
  loginAttempts.set(ip, recent);
  return recent.length >= 8;
}

function recordLoginFailure(ip) {
  loginAttempts.set(ip, [...(loginAttempts.get(ip) || []), Date.now()]);
}

function audit(req, session, action, targetType, targetId, detail = {}) {
  db.audit({ actorUserId: session?.user?.id || null, action, targetType, targetId, ip: clientIp(req), detail });
}

async function bootstrapAdmin() {
  if (db.countAdmins() > 0 || !config.adminUsername || !config.adminPassword) return;
  const username = validateUsername(config.adminUsername);
  const user = db.createUser({
    username,
    displayName: '超级管理员',
    passwordHash: await hashPassword(config.adminPassword),
    role: 'admin',
    networkAccess: true,
    maxProjects: 1000,
    maxStorageBytes: 1024 * 1024 * 1024 * 1024,
    maxConcurrentTurns: config.codexMaxConcurrentTurns,
  });
  workspace.ensureUserRoot(user.id);
  db.audit({ action: 'admin.bootstrap', targetType: 'user', targetId: user.id, detail: { username } });
  log('info', '已通过首次启动环境变量创建超级管理员', { username });
}

async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${config.host}:${config.port}`}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, codex: codex.status().ready, initialized: db.countAdmins() > 0 }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    checkOrigin(req);
    const ip = clientIp(req);
    invariant(!loginLimited(ip), 429, 'LOGIN_RATE_LIMIT', '登录尝试过多，请 15 分钟后重试。');
    const body = await readJson(req, 16 * 1024);
    const row = db.getUserAuthByUsername(String(body.username || '').trim());
    const valid = row && row.status === 'active' && await verifyPassword(body.password, row.password_hash);
    if (!valid) {
      recordLoginFailure(ip);
      db.audit({ action: 'auth.login_failed', targetType: 'user', targetId: row?.id || null, ip, detail: { username: String(body.username || '').slice(0, 64) } });
      throw new HttpError(401, 'LOGIN_FAILED', '用户名或密码错误，或账号已停用。');
    }
    loginAttempts.delete(ip);
    db.cleanSessions();
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
    db.createSession({ tokenHash: digestToken(token), userId: row.id, csrfToken, expiresAt, ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
    db.markLogin(row.id);
    db.audit({ actorUserId: row.id, action: 'auth.login', targetType: 'session', ip });
    sendJson(res, 200, { ok: true }, config, { 'set-cookie': cookie(req, token, config.sessionTtlSeconds) });
    return;
  }

  if (!pathname.startsWith('/api/')) {
    if (!serveStatic(res, config, pathname)) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在。' } }, config);
    return;
  }

  const session = requireSession(req);
  if (req.method === 'POST' && pathname === '/api/logout') {
    requireMutation(req, session);
    db.deleteSession(session.tokenHash);
    audit(req, session, 'auth.logout', 'session');
    sendJson(res, 200, { ok: true }, config, { 'set-cookie': cookie(req, '', 0) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/me') {
    const usage = workspace.usage(session.user.id);
    sendJson(res, 200, {
      user: session.user, csrfToken: session.csrfToken, usage,
      model: config.codexModel, defaultEffort: config.codexReasoningEffort,
      efforts: [...EFFORTS], codex: codex.status(),
    }, config);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: db.listProjects(session.user.role === 'admin' && url.searchParams.get('all') === '1' ? null : session.user.id) }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/projects') {
    requireMutation(req, session);
    const body = await readJson(req);
    const ownerId = session.user.role === 'admin' && body.userId ? String(body.userId) : session.user.id;
    const owner = db.getUserById(ownerId);
    invariant(owner && owner.status === 'active', 404, 'USER_NOT_FOUND', '项目所有者不存在或已停用。');
    invariant(db.listProjects(ownerId).length < owner.maxProjects, 413, 'PROJECT_QUOTA', '已达到项目数量上限。');
    const name = shortText(body.name, '项目名称');
    const description = String(body.description || '').trim().slice(0, 1000);
    const project = db.createProject({ userId: ownerId, slug: slugify(name), name, description });
    try { workspace.createProject(project); } catch (error) { db.deleteProject(project.id); throw error; }
    audit(req, session, 'project.create', 'project', project.id, { ownerId, name });
    sendJson(res, 201, { project }, config);
    return;
  }

  let match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, { project, usage: workspace.usage(project.userId) }, config);
    return;
  }
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const body = await readJson(req);
    const updated = db.updateProject(project.id, {
      name: body.name === undefined ? project.name : shortText(body.name, '项目名称'),
      description: body.description === undefined ? project.description : String(body.description).trim().slice(0, 1000),
    });
    audit(req, session, 'project.update', 'project', project.id);
    sendJson(res, 200, { project: updated }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const trashed = workspace.trashProject(project);
    db.deleteProject(project.id);
    audit(req, session, 'project.trash', 'project', project.id, { name: project.name, recoverable: trashed.recoverable });
    sendJson(res, 200, { ok: true, recoverable: trashed.recoverable }, config);
    return;
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/tree$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, workspace.tree(project, url.searchParams.get('path') || '', 20), config);
    return;
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/raw$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    const file = workspace.readBuffer(project, url.searchParams.get('path') || '');
    const extension = path.extname(file.path).toLowerCase();
    const mime = INLINE_MIME.get(extension) || 'application/octet-stream';
    const filename = path.basename(file.path);
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    const range = String(req.headers.range || '');
    if (range) {
      const parsed = range.match(/^bytes=(\d*)-(\d*)$/);
      invariant(parsed, 416, 'INVALID_RANGE', '文件范围请求无效。');
      if (parsed[1]) start = Number(parsed[1]);
      if (parsed[2]) end = Number(parsed[2]);
      if (!parsed[1] && parsed[2]) start = Math.max(0, file.size - Number(parsed[2]));
      invariant(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && end < file.size, 416, 'INVALID_RANGE', '文件范围请求越界。');
      status = 206;
    }
    const body = file.buffer.subarray(start, end + 1);
    res.writeHead(status, {
      ...securityHeaders(config),
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      'x-frame-options': 'SAMEORIGIN',
      'content-type': mime,
      'content-length': String(body.length),
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'accept-ranges': 'bytes',
      ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}),
    });
    res.end(body);
    return;
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/spreadsheet-preview$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, await workspace.spreadsheetPreview(project, url.searchParams.get('path') || ''), config);
    return;
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, workspace.readFile(project, url.searchParams.get('path') || ''), config);
    return;
  }
  if (match && req.method === 'PUT') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const owner = db.getUserById(project.userId);
    const body = await readBody(req, config.uploadMaxBytes);
    let previous = 0;
    try { previous = fs.statSync(workspace.resolve(project, url.searchParams.get('path') || '', { mustExist: true }).target).size; } catch { /* new file */ }
    const usage = workspace.usage(owner.id);
    invariant(usage.bytes - previous + body.length <= owner.maxStorageBytes, 413, 'STORAGE_QUOTA', '写入将超过用户存储配额。');
    const file = workspace.writeFile(project, url.searchParams.get('path') || '', body);
    db.touchProject(project.id);
    audit(req, session, 'file.write', 'project', project.id, { path: file.path, bytes: body.length });
    sendJson(res, 200, { file }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const result = workspace.moveToTrash(project, url.searchParams.get('path') || '');
    db.touchProject(project.id);
    audit(req, session, 'file.trash', 'project', project.id, { path: result.path });
    sendJson(res, 200, result, config);
    return;
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/directory$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const body = await readJson(req);
    const result = workspace.makeDirectory(project, body.path);
    db.touchProject(project.id);
    audit(req, session, 'directory.create', 'project', project.id, { path: result.path });
    sendJson(res, 201, result, config);
    return;
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/chats$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, { chats: db.listChats({ projectId: project.id }) }, config);
    return;
  }
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    const body = await readJson(req);
    const chat = db.createChat({ projectId: project.id, userId: project.userId, title: shortText(body.title || '新对话', '对话标题', 120) });
    audit(req, session, 'chat.create', 'chat', chat.id, { projectId: project.id });
    sendJson(res, 201, { chat }, config);
    return;
  }

  match = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    sendJson(res, 200, { chat, messages: db.listMessages(chat.id) }, config);
    return;
  }
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    const chat = chatFor(session, match[1]);
    const body = await readJson(req);
    const updated = db.updateChat(chat.id, { title: shortText(body.title, '对话标题', 120) });
    audit(req, session, 'chat.update', 'chat', chat.id);
    sendJson(res, 200, { chat: updated }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const chat = chatFor(session, match[1]);
    invariant(chat.status !== 'running', 409, 'CHAT_RUNNING', '请先停止正在运行的任务。');
    db.deleteChat(chat.id);
    audit(req, session, 'chat.delete', 'chat', chat.id);
    sendJson(res, 200, { ok: true }, config);
    return;
  }

  match = pathname.match(/^\/api\/chats\/([^/]+)\/turns$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const chat = chatFor(session, match[1]);
    const project = projectFor(session, chat.projectId);
    const owner = db.getUserById(chat.userId);
    invariant(owner?.status === 'active', 403, 'USER_DISABLED', '该项目所有者已停用。');
    const body = await readJson(req, 256 * 1024);
    sseHeaders(res, config);
    const heartbeat = setInterval(() => sse(res, 'ping', { at: Date.now() }), 15_000);
    audit(req, session, 'turn.start', 'chat', chat.id, { effort: body.effort || config.codexReasoningEffort });
    try {
      await codex.runTurn({ chat, project, user: owner, prompt: body.prompt, effort: body.effort, emit: (event, data) => sse(res, event, data) });
    } catch (error) {
      if (!error.turnEventEmitted) sse(res, 'turn_error', { message: error.message, code: error.code || 'TURN_FAILED' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/interrupt$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const chat = chatFor(session, match[1]);
    const interrupted = await codex.interrupt(chat.id);
    audit(req, session, 'turn.interrupt', 'chat', chat.id, { interrupted });
    sendJson(res, 200, { interrupted }, config);
    return;
  }

  if (pathname.startsWith('/api/admin/')) requireAdmin(session);
  if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
    const users = db.listUsers().map((user) => ({ ...user, usage: workspace.usage(user.id) }));
    sendJson(res, 200, { stats: db.stats(), codex: codex.status(), users, projects: db.listProjects() }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    sendJson(res, 200, { users: db.listUsers().map((user) => ({ ...user, usage: workspace.usage(user.id) })) }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/users') {
    requireMutation(req, session);
    const body = await readJson(req, 64 * 1024);
    const username = validateUsername(body.username);
    invariant(!db.getUserAuthByUsername(username), 409, 'USERNAME_EXISTS', '用户名已存在。');
    const displayName = shortText(body.displayName || username, '显示名称', 64);
    const password = String(body.password || '');
    invariant(password.length >= 12 && password.length <= 256, 400, 'INVALID_PASSWORD', '密码长度必须为 12–256 个字符。');
    const user = db.createUser({
      username, displayName, passwordHash: await hashPassword(password), role: 'user',
      networkAccess: Boolean(body.networkAccess ?? config.defaultNetworkAccess),
      maxProjects: boundedInteger(body.maxProjects ?? config.defaultMaxProjects, '项目上限', 1, 10000),
      maxStorageBytes: boundedInteger(body.maxStorageBytes ?? config.defaultMaxStorageBytes, '存储上限', 1024 * 1024, Number.MAX_SAFE_INTEGER),
      maxConcurrentTurns: boundedInteger(body.maxConcurrentTurns ?? config.defaultMaxConcurrentTurns, '并发上限', 1, config.codexMaxConcurrentTurns),
    });
    workspace.ensureUserRoot(user.id);
    audit(req, session, 'user.create', 'user', user.id, { username });
    sendJson(res, 201, { user }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    const target = db.getUserById(match[1]);
    invariant(target, 404, 'USER_NOT_FOUND', '用户不存在。');
    const body = await readJson(req, 64 * 1024);
    invariant(!(target.role === 'admin' && body.status && body.status !== 'active'), 400, 'ADMIN_DISABLE_BLOCKED', '不能停用超级管理员账号。');
    const patch = {};
    if (body.displayName !== undefined) patch.displayName = shortText(body.displayName, '显示名称', 64);
    if (body.status !== undefined) { invariant(['active', 'disabled'].includes(body.status), 400, 'INVALID_STATUS', '账号状态无效。'); patch.status = body.status; }
    if (body.networkAccess !== undefined) patch.networkAccess = Boolean(body.networkAccess);
    if (body.maxProjects !== undefined) patch.maxProjects = boundedInteger(body.maxProjects, '项目上限', 1, 10000);
    if (body.maxStorageBytes !== undefined) patch.maxStorageBytes = boundedInteger(body.maxStorageBytes, '存储上限', 1024 * 1024, Number.MAX_SAFE_INTEGER);
    if (body.maxConcurrentTurns !== undefined) patch.maxConcurrentTurns = boundedInteger(body.maxConcurrentTurns, '并发上限', 1, config.codexMaxConcurrentTurns);
    if (body.password !== undefined && String(body.password).length) {
      const password = String(body.password);
      invariant(password.length >= 12 && password.length <= 256, 400, 'INVALID_PASSWORD', '密码长度必须为 12–256 个字符。');
      patch.passwordHash = await hashPassword(password);
    }
    const updated = db.updateUser(target.id, patch);
    if (patch.status === 'disabled' || patch.passwordHash) db.deleteUserSessions(target.id);
    if (patch.status === 'disabled' || (patch.networkAccess !== undefined && patch.networkAccess !== target.networkAccess)) {
      await codex.interruptUser(target.id);
    }
    audit(req, session, 'user.update', 'user', target.id, { fields: Object.keys(patch).filter((key) => key !== 'passwordHash'), passwordReset: Boolean(patch.passwordHash) });
    sendJson(res, 200, { user: updated }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/audit') {
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    sendJson(res, 200, { audit: db.listAudit(limit) }, config);
    return;
  }

  throw new HttpError(404, 'NOT_FOUND', '接口不存在。');
}

await bootstrapAdmin();
db.cleanSessions();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
    if (status >= 500) log('error', error.message, { stack: error.stack });
    sendJson(res, status, { error: { code, message: status >= 500 && !(error instanceof HttpError) ? '服务器内部错误。' : error.message, details: error.details } }, config);
  }
});

server.requestTimeout = config.codexRequestTimeoutMs + 60_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 65_000;
server.listen(config.port, config.host, () => {
  log('info', 'Codex Harness Remote 已启动', { url: `http://${config.host}:${config.port}`, model: config.codexModel });
  if (db.countAdmins() === 0) log('error', '尚无超级管理员，请另开终端运行 ./bin/create-super-admin.sh');
  codex.start().then(() => log('info', 'Codex app-server 已就绪')).catch((error) => log('error', 'Codex app-server 启动失败；首次对话会重试', { message: error.message }));
});

function shutdown(signal) {
  log('info', `收到 ${signal}，正在关闭`);
  codex.stop();
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, config, db, workspace, codex, securityHeaders };
