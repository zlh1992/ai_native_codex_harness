#!/usr/bin/env node
import { ROOT_MODELS, validateModel, validateEffort, defaultEffort, rootEffort, rootModel } from './models.mjs';
import { formatWechatModelCatalog, parseWechatCommand, resolveWechatModel } from './wechat-channel-commands.mjs';
import { DEFAULT_SESSION_COOKIE, validSessionSelector, selectedCookieName, requestSessionCookieName } from './session-selection.mjs';
import { requestIngress, validateRequestOrigin } from './public-ingress.mjs';
import { pageRoute } from './page-routes.mjs';
import { createStaticAssets } from './static-assets.mjs';

import fs from 'node:fs';
import http from 'node:http';
import { browserRoutes } from './browser-routes.mjs';
import path from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { digestToken, hashPassword, newCsrfToken, newSessionToken, parseCookies, safeEqual, verifyPassword } from './auth.mjs';
import { loadConfig } from './config.mjs';
import { EFFORTS, TURN_MODES } from './codex-service.mjs';
import { AgentRuntimeService } from './agent-runtime-service.mjs';
import { assertStandardProject, isPrivateProject } from './private-projects.mjs';
import { HarnessDatabase } from './db.mjs';
import { HttpError, invariant } from './errors.mjs';
import { WorkspaceService, slugify } from './fs-service.mjs';
import { WorktreeService } from './worktree-service.mjs';
import { WorkGraphStore } from './work-graph-store.mjs';
import { WorkGraphService } from './work-graph-service.mjs';
import { ProjectShareService } from './project-share-service.mjs';
import { TaskReviewService } from './task-review-service.mjs';
import { ProjectContextService } from './project-context-service.mjs';
import { WorkGraphRuntime } from './work-graph-runtime.mjs';
import { WorkflowScheduler } from './workflow-scheduler.mjs';
import { UserMemoryService } from './user-memory-service.mjs';
import { createWorkGraphRoutes } from './work-graph-routes.mjs';
import { parseByteRange, readBody, readJson, securityHeaders, sendJson, serveStatic, sse, sseHeaders } from './http-utils.mjs';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const INLINE_MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'],
  ['.webp', 'image/webp'], ['.avif', 'image/avif'], ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'], ['.pdf', 'application/pdf'], ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'], ['.csv', 'text/csv; charset=utf-8'], ['.tsv', 'text/tab-separated-values; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
]);
const HTML_PREVIEW_CSP = [
  'sandbox allow-scripts', "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  'img-src data: blob:', 'font-src data:', 'media-src data: blob:', "connect-src 'none'",
  "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

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
const staticAssets = createStaticAssets(config);
if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error(`安全策略拒绝非回环监听 HOST=${config.host}；请使用 HTTPS 出站隧道。`);
}
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(config.workspacesRoot, { recursive: true, mode: 0o700 });
const db = new HarnessDatabase(config);
// Runtime rows describe this Portal process, so only the server startup path
// may recover them. Administrative CLI processes must never interrupt turns.
db.recoverInterruptedRuntime();
db.tokenUsage.recover();
const workspace = new WorkspaceService(config);
const worktrees = new WorktreeService(config);
const memory = new UserMemoryService({ config, db });
const codex = new AgentRuntimeService({ config, db, workspace, memory });
const graphStore = new WorkGraphStore(db);
const graphs = new WorkGraphService({ db, store: graphStore, workspace, worktrees, codex });
const shares = new ProjectShareService({ db, store: graphStore, workspace, worktrees, codex, memory });
const reviews = new TaskReviewService({ db, store: graphStore, workspace, worktrees, codex, graphs });
const graphContext = new ProjectContextService({ db, store: graphStore, workspace, worktrees, graphs });
const graphRuntime = new WorkGraphRuntime({ db, store: graphStore, codex, graphs, reviews, context: graphContext });
codex.workGraphRuntime = graphRuntime;
graphStore.recoverJobs();
const workflowScheduler = new WorkflowScheduler({ store: graphStore, handlers: {
  'share.prepare': (job) => shares.prepareWorkflow(job),
  'workflow.reconcile': (job) => graphs.reconcile(job.runId, job.generation),
  'plan.generate': (job) => graphRuntime.plan(job),
  'submission.review': (job) => graphRuntime.review(job),
  'review.apply': (job) => {
    invariant(config.workGraphAutoReviewEnabled, 409, 'AUTO_REVIEW_DISABLED', '自动审核已由运维暂停，请老板人工验收。');
    return reviews.apply(job.payload.reviewId, { ownerId: job.ownerId, job });
  },
}, onLeaseLost: async (job) => {
  const chat = db.listChats({ projectId: job.projectId }).find((c) => c.workflowJobId === job.id);
  if (chat) await codex.interrupt(chat.id);
} });
const workGraphRoutes = createWorkGraphRoutes({ db, store: graphStore, graphs, reviews, runtime: graphRuntime,
  scheduler: workflowScheduler, shares, codex, config, requireMutation, refreshSession, projectFor, requireAdmin, audit });
const loginAttempts = new Map();
const WECHAT_CHANNEL = 'wechat';

function log(level, message, detail) {
  const record = { time: new Date().toISOString(), level, message, ...(detail ? { detail } : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(record));
}

codex.on('log', (record) => log(record.level || 'info', 'codex', record.message));
memory.onLog = (record) => log(record.level || 'warn', 'memory-index', record.message);

function clientIp(req) {
  return requestIngress(req, config).ip;
}

function checkOrigin(req) {
  validateRequestOrigin(req, config);
}

function cookie(req, token, maxAge, name = DEFAULT_SESSION_COOKIE) {
  const { secure } = requestIngress(req, config);
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[requestSessionCookieName(req)];
  return token ? db.getSession(digestToken(token)) : null;
}

function requireSession(req) {
  const session = sessionFor(req);
  invariant(session, 401, 'AUTH_REQUIRED', '请先登录。');
  return session;
}

const sessionStreams = new Map();
function registerSessionStream(session, close) {
  if (!sessionStreams.has(session.tokenHash)) sessionStreams.set(session.tokenHash, new Set());
  const entries = sessionStreams.get(session.tokenHash); entries.add(close);
  return () => { entries.delete(close); if (!entries.size) sessionStreams.delete(session.tokenHash); };
}
function closeSessionStreams(tokenHash) {
  for (const close of [...(sessionStreams.get(tokenHash) || [])]) close();
}

function refreshSession(session) {
  const current = db.getSession(session.tokenHash);
  invariant(current && current.user.id === session.user.id, 401, 'AUTH_REQUIRED', '会话已失效，请重新登录。');
  return current;
}

function requireMutation(req, session) {
  checkOrigin(req);
  invariant(safeEqual(req.headers['x-csrf-token'], session.csrfToken), 403, 'CSRF_REJECTED', 'CSRF 校验失败，请刷新页面后重试。');
}

function requireAdmin(session) {
  invariant(session.user.role === 'admin', 403, 'ADMIN_REQUIRED', '此操作仅限超级管理员。');
}

function activeUserFor(session) {
  const user = db.getUserById(session.user.id);
  invariant(user?.status === 'active', 403, 'USER_DISABLED', '账号已停用，请重新登录。');
  return user;
}

function projectFor(session, id) {
  activeUserFor(session);
  const project = db.getProjectForUser(id, session.user.id);
  invariant(project, 403, 'PROJECT_FORBIDDEN', '项目不存在或未向你授权。');
  return project;
}

function chatFor(session, id) {
  const chat = db.getChat(id);
  invariant(chat, 404, 'CHAT_NOT_FOUND', '对话不存在。');
  invariant(chat.userId === session.user.id, 403, 'CHAT_FORBIDDEN', '无权访问该对话。');
  const project = projectFor(session, chat.projectId);
  invariant(project.accessId === chat.projectAccessId, 403, 'PROJECT_ACCESS_REVOKED', '该对话对应的项目授权已撤销。');
  return chat;
}

function ownerProject(project) {
  invariant(project.accessKind === 'owner', 403, 'PROJECT_OWNER_REQUIRED', '只有项目所有者可以执行此操作。');
  return project;
}

function taskFor(session, id) {
  activeUserFor(session);
  const task = db.getTaskForUser(id, session.user.id);
  invariant(task, 403, 'TASK_FORBIDDEN', '任务不存在或不属于你。');
  return task;
}

function projectPayload(project) {
  if (!project) return null;
  const { treePath, branchName, ...safe } = project;
  return safe;
}

function accessPayload(access) {
  if (!access) return null;
  const { treePath, ...safe } = access;
  return safe;
}

function chatPayload(chat) {
  if (!chat) return null;
  const { treePath, projectAccessId, memoryContextResetAt, localSessionId, ...safe } = chat;
  return safe;
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

function turnMode(value, fallback = 'execute') {
  const mode = String(value || fallback).toLowerCase();
  invariant(TURN_MODES.has(mode), 400, 'INVALID_TURN_MODE', '任务模式必须是 EDIT 或 EXECUTE。');
  return mode;
}

function expectedFileVersion(req) {
  const raw = String(req.headers['if-match'] || '').trim();
  if (!raw) return null;
  const value = raw.replace(/^W\//, '').replace(/^"|"$/g, '');
  invariant(/^[0-9a-f]{64}$/i.test(value), 400, 'INVALID_FILE_VERSION', 'If-Match 文件版本标识无效。');
  return value;
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

function userUsage(userId) {
  return workspace.usageForUser(userId, db.listProjectsForUser(userId));
}

function requireWorkspaceIdle(project) {
  invariant(!codex.workspaceBusy(project.accessId), 409, 'WORKSPACE_BUSY', '该工作树正在被 Codex 使用，请等待任务结束或先停止任务。');
}

async function bootstrapAdmin() {
  if (db.countAdmins() > 0 || !config.adminUsername || !config.adminPassword) return;
  const username = validateUsername(config.adminUsername);
  invariant(config.adminPassword.length >= 12 && config.adminPassword.length <= 256, 500, 'INVALID_ADMIN_PASSWORD', '首次启动超级管理员密码长度必须为 12–256 个字符。');
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
    const codexStatus = codex.status();
    const codexState = codexStatus.ready ? 'ready' : codexStatus.lastError ? 'failed' : 'starting';
    sendJson(res, 200, { ok: true, codex: codexStatus.ready, codexState, initialized: db.countAdmins() > 0,
      memory: memory.status(), localQwen: codex.local.status() }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/internal/channels/wechat/events') {
    invariant(config.wechatChannelEnabled, 404, 'CHANNEL_NOT_FOUND', '微信渠道未启用。');
    const remote = req.socket.remoteAddress || '';
    invariant(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote), 403, 'CHANNEL_LOOPBACK_REQUIRED', '微信渠道只允许本机回环调用。');
    const timestamp = String(req.headers['x-wechat-timestamp'] || '');
    const nonce = String(req.headers['x-wechat-nonce'] || '');
    const signature = String(req.headers['x-wechat-signature'] || '');
    invariant(/^\d{10,13}$/.test(timestamp) && nonce.length >= 16 && nonce.length <= 128 && /^[a-f0-9]{64}$/i.test(signature),
      401, 'CHANNEL_AUTH_INVALID', '微信渠道认证信息无效。');
    const timestampMs = Number(timestamp.length === 10 ? `${timestamp}000` : timestamp);
    invariant(Math.abs(Date.now() - timestampMs) <= 60_000, 401, 'CHANNEL_AUTH_EXPIRED', '微信渠道请求已过期。');
    let secret;
    try { secret = fs.readFileSync(config.wechatChannelSecretFile); } catch { throw new HttpError(503, 'CHANNEL_SECRET_UNAVAILABLE', '微信渠道密钥不可用。'); }
    invariant(secret.length >= 32, 503, 'CHANNEL_SECRET_UNAVAILABLE', '微信渠道密钥配置无效。');
    const raw = await readBody(req, 256 * 1024);
    const expected = createHmac('sha256', secret).update(`${timestamp}.${nonce}.`).update(raw).digest('hex');
    invariant(safeEqual(expected, signature.toLowerCase()), 401, 'CHANNEL_AUTH_INVALID', '微信渠道签名无效。');
    let body;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { throw new HttpError(400, 'INVALID_JSON', '请求 JSON 无效。'); }
    const eventId = String(body.eventId || '').trim();
    const externalScopeId = String(body.scopeId || '').trim();
    const senderId = String(body.senderId || '').trim();
    const text = String(body.text || '').trim();
    invariant(/^[\w.:-]{1,180}$/u.test(eventId), 400, 'CHANNEL_EVENT_INVALID', '微信事件 ID 无效。');
    invariant(externalScopeId.length >= 1 && externalScopeId.length <= 240, 400, 'CHANNEL_EVENT_INVALID', '微信会话标识无效。');
    invariant(!body.chatType || body.chatType === 'dm', 403, 'CHANNEL_GROUP_DISABLED', '微信渠道不接受群聊。');
    invariant(!config.wechatChannelSenderId || senderId === config.wechatChannelSenderId,
      403, 'CHANNEL_SENDER_FORBIDDEN', '微信发送者未绑定。');
    invariant(text.length >= 1 && text.length <= 100_000, 400, 'CHANNEL_EVENT_INVALID', '微信消息内容无效。');
    const existing = db.getChannelEvent(WECHAT_CHANNEL, eventId);
    if (existing) {
      if (existing.status === 'completed' || existing.status === 'failed') {
        sendJson(res, 200, { ok: existing.status === 'completed', duplicate: true, status: existing.status, text: existing.responseText || '该消息已处理。' }, config);
        return;
      }
      throw new HttpError(409, 'CHANNEL_EVENT_PROCESSING', '该微信消息正在处理。');
    }
    const adminRow = db.db.prepare("SELECT id FROM users WHERE role='admin' AND status='active' ORDER BY created_at LIMIT 1").get();
    invariant(adminRow?.id, 503, 'CHANNEL_OWNER_UNAVAILABLE', '老板账号不可用。');
    const owner = db.getUserById(adminRow.id);
    const project = db.getProjectForUser(config.wechatChannelProjectId, owner.id);
    invariant(project && project.accessKind === 'owner' && project.userId === owner.id, 503, 'CHANNEL_PROJECT_UNAVAILABLE', '微信固定项目不存在或不属于老板。');
    assertStandardProject(project);
    const command = parseWechatCommand(text);
    let binding = db.getChannelBinding(WECHAT_CHANNEL, externalScopeId);
    invariant(!binding || binding.status === 'active', 409, 'CHANNEL_BINDING_REVOKED', '微信会话绑定已撤销，请重新扫码绑定。');
    if (binding && (binding.userId !== owner.id || binding.projectId !== project.id)) {
      throw new HttpError(409, 'CHANNEL_BINDING_CHANGED', '微信会话绑定已变化。');
    }
    let bindingCreated = false;
    if (!binding) {
      const chat = db.createChat({
        projectId: project.id, userId: owner.id, projectAccessId: project.accessId, treePath: project.treePath,
        title: `微信对话 ${createHmac('sha256', secret).update(externalScopeId).digest('hex').slice(0, 10)}`,
        preferredMode: 'execute',
      });
      binding = db.createChannelBinding({ channel: WECHAT_CHANNEL, externalScopeId, userId: owner.id, projectId: project.id, chatId: chat.id });
      if (binding.chatId !== chat.id) db.deleteChat(chat.id);
      bindingCreated = true;
    }
    if (command?.type === 'new' && !bindingCreated) {
      const currentChat = db.getChat(binding.chatId);
      invariant(currentChat, 503, 'CHANNEL_CHAT_UNAVAILABLE', '微信固定对话不存在。');
      invariant(!codex.chatBusy(currentChat.id) && !db.listChatInputs(currentChat.id).length,
        409, 'CHAT_RUNNING', '当前微信对话仍在运行，请稍后再发送 /new。');
      db.db.exec('BEGIN IMMEDIATE');
      try {
        const lockedBinding = db.getChannelBinding(WECHAT_CHANNEL, externalScopeId);
        invariant(lockedBinding?.chatId === binding.chatId && lockedBinding.status === 'active',
          409, 'CHANNEL_BINDING_CHANGED', '微信会话绑定已变化。');
        const freshChat = db.createChat({
          projectId: project.id, userId: owner.id, projectAccessId: project.accessId, treePath: project.treePath,
          title: `微信对话 ${createHmac('sha256', secret).update(`${externalScopeId}:${Date.now()}`).digest('hex').slice(0, 10)}`,
          preferredMode: 'execute',
        });
        binding = db.rebindChannelBindingChat({ channel: WECHAT_CHANNEL, externalScopeId,
          expectedChatId: binding.chatId, chatId: freshChat.id });
        db.db.exec('COMMIT');
      } catch (error) {
        try { db.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    const event = db.createChannelEvent({ channel: WECHAT_CHANNEL, externalEventId: eventId, externalScopeId, chatId: binding.chatId });
    if (!event.created) {
      if (event.status === 'processing') throw new HttpError(409, 'CHANNEL_EVENT_PROCESSING', '该微信消息正在处理。');
      sendJson(res, 200, { ok: event.status === 'completed', duplicate: true, status: event.status,
        text: event.responseText || '该消息已处理。' }, config);
      return;
    }
    const chat = db.getChat(binding.chatId);
    invariant(chat, 503, 'CHANNEL_CHAT_UNAVAILABLE', '微信固定对话不存在。');
    let responseText = '';
    try {
      if (command?.type === 'new') {
        responseText = '已开启新对话。后续消息将进入新的 Portal 对话，旧对话历史已保留。';
      } else if (command?.type === 'models') {
        responseText = formatWechatModelCatalog({ config, chat, user: owner });
      } else if (command?.type === 'model') {
        invariant(!codex.chatBusy(chat.id) && !db.listChatInputs(chat.id).length,
          409, 'CHAT_RUNNING', '当前微信对话仍在运行，请稍后再切换模型。');
        const preferredModel = resolveWechatModel(command.value);
        db.updateChat(chat.id, { preferredModel });
        const updatedChat = db.getChat(chat.id);
        responseText = preferredModel
          ? `已将当前微信对话切换到 ${preferredModel}。`
          : `已恢复当前微信对话的默认模型（${rootModel(config, updatedChat, owner)}）。`;
      } else {
        const result = await codex.runTurn({ chat, project, user: owner, prompt: text, effort: chat.preferredEffort || undefined, mode: 'execute', emit: () => {} });
        responseText = String(result?.text || '').trim() || '任务已完成，但没有可发送的文字结果。';
      }
      db.completeChannelEvent(WECHAT_CHANNEL, event.externalEventId, { responseText });
      db.audit({ actorUserId: owner.id, action: command ? 'channel.wechat.command' : 'channel.wechat.turn', targetType: 'chat', targetId: chat.id,
        detail: { projectId: project.id, eventId, ...(command ? { command: command.type } : {}), externalScopeIdHash: createHmac('sha256', secret).update(externalScopeId).digest('hex').slice(0, 16) } });
      sendJson(res, 200, { ok: true, status: 'completed', text: responseText }, config);
    } catch (error) {
      const code = error.code || 'CHANNEL_TURN_FAILED';
      responseText = '任务未完成，请稍后重试或打开老板工作台查看详情。';
      db.completeChannelEvent(WECHAT_CHANNEL, event.externalEventId, { status: 'failed', responseText, errorCode: code });
      sendJson(res, 200, { ok: false, status: 'failed', code, text: responseText }, config);
    }
    return;
  }
  if (req.method === 'POST' && ['/api/login', '/api/boss/login', '/api/employee/login'].includes(pathname)) {
    checkOrigin(req);
    const ip = clientIp(req);
    invariant(!loginLimited(ip), 429, 'LOGIN_RATE_LIMIT', '登录尝试过多，请 15 分钟后重试。');
    const body = await readJson(req, 16 * 1024);
    let row = db.getUserAuthByUsername(String(body.username || '').trim());
    const verified = row && row.status === 'active' && await verifyPassword(body.password, row.password_hash);
    const currentRow = verified ? db.getUserAuthByUsername(row.username) : null;
    const valid = Boolean(currentRow && currentRow.id === row.id && currentRow.status === 'active'
      && currentRow.password_hash === row.password_hash);
    if (valid) row = currentRow;
    if (!valid) {
      recordLoginFailure(ip);
      db.audit({ action: 'auth.login_failed', targetType: 'user', targetId: row?.id || null, ip, detail: { username: String(body.username || '').slice(0, 64) } });
      throw new HttpError(401, 'LOGIN_FAILED', '用户名或密码错误，或账号已停用。');
    }
    const expectedRole = pathname === '/api/boss/login' ? 'admin' : pathname === '/api/employee/login' ? 'user' : null;
    invariant(!expectedRole || row.role === expectedRole, 403, 'LOGIN_ROLE_MISMATCH', '该账号不属于此登录入口，请使用对应的老板或员工入口。');
    const selector = body.sessionSelector;
    invariant(selector === undefined || (pathname === '/api/employee/login' && validSessionSelector(selector)),
      400, 'INVALID_SESSION_SELECTOR', '登录会话选择无效。');
    loginAttempts.delete(ip);
    db.cleanSessions();
    const token = newSessionToken();
    const csrfToken = newCsrfToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000).toISOString();
    db.createSession({ tokenHash: digestToken(token), userId: row.id, csrfToken, expiresAt, ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 500) });
    db.markLogin(row.id);
    db.audit({ actorUserId: row.id, action: 'auth.login', targetType: 'session', ip });
    sendJson(res, 200, { ok: true, ...(selector ? { sessionSelector: selector } : {}) }, config,
      { 'set-cookie': cookie(req, token, config.sessionTtlSeconds, selector ? selectedCookieName(selector) : DEFAULT_SESSION_COOKIE) });
    return;
  }

  if (!pathname.startsWith('/api/')) {
    const page = pageRoute(url, config, requestIngress(req, config));
    if (page.redirect) {
      res.writeHead(page.status, { ...securityHeaders(config), location: page.redirect });
      res.end();
      return;
    }
    if (staticAssets.serve(res, page.file || pathname)) return;
    if (pathname.startsWith('/assets/')) {
      sendJson(res, 404, { error: { code: 'ASSET_VERSION_NOT_FOUND', message: '页面资源版本已更新，请刷新页面。' } }, config);
      return;
    }
    if (pathname === '/vendor/sortable.js') {
      if (!serveStatic(res, { ...config, publicDir: path.join(config.rootDir, 'node_modules/sortablejs/modular') }, '/sortable.complete.esm.js')) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '看板组件未安装。' } }, config);
      return;
    }
    if (!serveStatic(res, config, page.file || pathname)) sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在。' } }, config);
    return;
  }

  let session = requireSession(req);
  if (await workGraphRoutes(req, res, url, session)) return;
  if (req.method === 'POST' && pathname === '/api/logout') {
    requireMutation(req, session);
    await codex.browser.closeSession(session.tokenHash);
    db.deleteSession(session.tokenHash);
    closeSessionStreams(session.tokenHash);
    audit(req, session, 'auth.logout', 'session');
    sendJson(res, 200, { ok: true }, config, { 'set-cookie': cookie(req, '', 0, requestSessionCookieName(req)) });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/me') {
    const usage = userUsage(session.user.id);
    sendJson(res, 200, {
      workGraphEnabled: config.workGraphEnabled,
      user: session.user, csrfToken: session.csrfToken, usage,
      model: config.codexModel, models: ROOT_MODELS, defaultEffort: defaultEffort(config, session.user),
      efforts: [...EFFORTS], turnModes: [...TURN_MODES], codex: codex.status(), memory: memory.status(),
    }, config);
    return;
  }

  if (await handleBrowser(req, res, url, session)) return;
  const scopedMemory = pathname.match(/^\/api\/projects\/([^/]+)\/memories(?:\/([^/]+))?$/);
  let scopeProjectId = null;
  if (scopedMemory) {
    const project = projectFor(session, scopedMemory[1]);
    invariant(isPrivateProject(project), 400, 'PRIVATE_PROJECT_REQUIRED', '普通项目请使用“我的记忆”。');
    scopeProjectId = project.id;
  }
  const memoryCollection = pathname === '/api/memories' || (scopedMemory && !scopedMemory[2]);
  if (req.method === 'GET' && memoryCollection) {
    sendJson(res, 200, { memories: memory.list(session.user.id, { scopeProjectId }), status: memory.status() }, config);
    return;
  }
  if (req.method === 'POST' && memoryCollection) {
    requireMutation(req, session);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    const saved = memory.create({ userId: session.user.id, body: body.body, sourceKind: 'manual', scopeProjectId });
    audit(req, session, 'memory.create', 'user_memory', saved.id, { version: saved.version, sourceKind: saved.sourceKind });
    sendJson(res, 201, { memory: saved }, config);
    return;
  }
  const memoryMatch = scopedMemory?.[2] ? [pathname, scopedMemory[2]] : pathname.match(/^\/api\/memories\/([^/]+)$/);
  if (memoryMatch && req.method === 'PATCH') {
    requireMutation(req, session);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    const before = memory.get(memoryMatch[1]);
    invariant(before?.userId === session.user.id && before.scopeProjectId === scopeProjectId, 404, 'MEMORY_NOT_FOUND', '记忆不存在。');
    const affected = memory.dependentChatIds(before.id, session.user.id);
    await Promise.all(affected.map((chatId) => codex.interruptAndWait(chatId)));
    session = refreshSession(session);
    const saved = memory.update({ id: before.id, userId: session.user.id, version: body.version, body: body.body, scopeProjectId });
    memory.invalidateThreads([before.id]);
    audit(req, session, 'memory.update', 'user_memory', saved.id, { version: saved.version, affectedChats: affected.length });
    sendJson(res, 200, { memory: saved, resetChats: affected.length }, config);
    return;
  }
  if (memoryMatch && req.method === 'DELETE') {
    requireMutation(req, session);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    const before = memory.get(memoryMatch[1]);
    invariant(before?.userId === session.user.id && before.scopeProjectId === scopeProjectId, 404, 'MEMORY_NOT_FOUND', '记忆不存在。');
    const affected = memory.dependentChatIds(before.id, session.user.id);
    await Promise.all(affected.map((chatId) => codex.interruptAndWait(chatId)));
    session = refreshSession(session);
    const result = memory.delete({ id: before.id, userId: session.user.id, version: body.version, scopeProjectId });
    memory.invalidateThreads([before.id]);
    audit(req, session, 'memory.delete', 'user_memory', before.id, { affectedChats: affected.length });
    sendJson(res, 200, { ...result, resetChats: affected.length }, config);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: db.listProjectsForUser(session.user.id).map(projectPayload) }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/projects') {
    requireMutation(req, session);
    const body = await readJson(req);
    session = refreshSession(session);
    const ownerId = session.user.id;
    const owner = db.getUserById(ownerId);
    invariant(owner && owner.status === 'active', 404, 'USER_NOT_FOUND', '项目所有者不存在或已停用。');
    const projectLimit = owner.role === 'user' ? Math.min(owner.maxProjects, 100) : owner.maxProjects;
    invariant(db.listProjects(ownerId).length < projectLimit, 413, 'PROJECT_QUOTA', '已达到项目数量上限。');
    const name = shortText(body.name, '项目名称');
    const description = String(body.description || '').trim().slice(0, 1000);
    const projectType = body.projectType ?? 'standard';
    invariant(['standard', 'local_private'].includes(projectType), 400, 'INVALID_PROJECT_TYPE', '项目类型无效。');
    if (projectType === 'local_private') requireAdmin(session);
    const project = db.createProject({ userId: ownerId, slug: slugify(name), name, description, projectType });
    try {
      workspace.createProject(project);
      worktrees.initialize(workspace.projectRoot(project));
      db.setProjectRepoKind(project.id, 'git');
    } catch (error) {
      try { workspace.trashProject(project); } catch { /* best-effort rollback */ }
      db.deleteProject(project.id);
      throw error;
    }
    audit(req, session, 'project.create', 'project', project.id, { ownerId, projectType });
    sendJson(res, 201, { project: projectPayload(db.getProjectForUser(project.id, ownerId)) }, config);
    return;
  }

  let match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    const usage = userUsage(session.user.id);
    sendJson(res, 200, { project: projectPayload(project), usage }, config);
    return;
  }
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    let project = ownerProject(projectFor(session, match[1]));
    const expectedAccessId = project.accessId;
    const body = await readJson(req);
    session = refreshSession(session);
    project = ownerProject(projectFor(session, match[1]));
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    invariant(body.projectType === undefined || body.projectType === project.projectType, 409, 'PROJECT_TYPE_IMMUTABLE', '项目类型创建后不可切换。');
    const updated = db.updateProject(project.id, {
      name: body.name === undefined ? project.name : shortText(body.name, '项目名称'),
      description: body.description === undefined ? project.description : String(body.description).trim().slice(0, 1000),
    });
    audit(req, session, 'project.update', 'project', project.id);
    sendJson(res, 200, { project: projectPayload(db.getProjectForUser(updated.id, session.user.id)) }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    let project = ownerProject(projectFor(session, match[1]));
    invariant(!db.listProjectAccess(project.id, { activeOnly: true }).some((access) => access.accessKind === 'shared'), 409, 'PROJECT_SHARED', '请先撤销员工授权再删除项目。');
    invariant(!db.runtimeForProject(project.id).busy && !codex.workspaceBusy(project.accessId),
      409, 'PROJECT_BUSY', '项目仍有排队、运行或恢复中的任务，不能删除。');
    const retained = db.listProjectAccess(project.id).filter((access) => access.accessKind === 'shared'
      && access.status === 'revoked' && worktrees.isReusableShare({ treePath: access.treePath }));
    invariant(retained.length === 0, 409, 'RETAINED_WORKTREES', '项目仍有撤权后保留的工作树；请先恢复授权并处理其中的修改。');
    invariant(!graphStore.runs({ projectId: project.id }).length, 409, 'PROJECT_WORKFLOW_HISTORY', '项目保留工作图交付历史，不能删除。');
    const sourceMemories = memory.memoryIdsForSourceProject(project.id, session.user.id);
    const affectedMemoryChats = [...new Set(sourceMemories.flatMap((id) => memory.dependentChatIds(id, session.user.id)))];
    await Promise.all(affectedMemoryChats.map((chatId) => codex.interruptAndWait(chatId)));
    session = refreshSession(session); project = ownerProject(projectFor(session, project.id));
    invariant(!db.runtimeForProject(project.id).busy && !codex.workspaceBusy(project.accessId),
      409, 'PROJECT_BUSY', '项目仍有排队、运行或恢复中的任务，不能删除。');
    memory.invalidateThreads(sourceMemories);
    const trashed = workspace.trashProject(project);
    db.deleteProject(project.id);
    memory.refreshIndex(session.user.id);
    audit(req, session, 'project.trash', 'project', project.id, { recoverable: trashed.recoverable });
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
    const isHtmlPreview = extension === '.html' || extension === '.htm';
    const filename = path.basename(file.path);
    let range;
    try { range = parseByteRange(req.headers.range, file.size); }
    catch (error) {
      if (error.code !== 'INVALID_RANGE') throw error;
      sendJson(res, 416, { error: { code: error.code, message: error.message } }, config,
        { 'content-range': `bytes */${file.size}`, 'accept-ranges': 'bytes' });
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? file.size - 1;
    const status = range ? 206 : 200;
    const body = file.buffer.subarray(start, end + 1);
    res.writeHead(status, {
      ...securityHeaders(config),
      'content-security-policy': isHtmlPreview
        ? HTML_PREVIEW_CSP
        : "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
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
    let project = projectFor(session, match[1]);
    const expectedAccessId = project.accessId;
    const preview = await workspace.spreadsheetPreview(project, url.searchParams.get('path') || '');
    const currentSession = refreshSession(session);
    project = projectFor(currentSession, project.id);
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    sendJson(res, 200, preview, config);
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
    let project = projectFor(session, match[1]);
    const expectedAccessId = project.accessId;
    requireWorkspaceIdle(project);
    const body = await readBody(req, config.uploadMaxBytes);
    session = refreshSession(session);
    project = projectFor(session, match[1]);
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    requireWorkspaceIdle(project);
    const quotaUser = activeUserFor(session);
    const expectedVersion = expectedFileVersion(req);
    let previous = 0;
    let exists = false;
    let currentVersion = null;
    try {
      const metadata = workspace.fileMetadata(project, url.searchParams.get('path') || '');
      previous = metadata.size;
      currentVersion = metadata.version;
      exists = true;
    } catch { /* new file */ }
    invariant(!exists || url.searchParams.get('overwrite') === '1', 409, 'FILE_EXISTS', '文件已存在；请明确允许覆盖。');
    invariant(!expectedVersion || (exists && currentVersion === expectedVersion),
      409, 'FILE_VERSION_CONFLICT', '文件已被其他操作修改，请刷新后合并或重试。');
    const usage = userUsage(quotaUser.id);
    invariant(usage.bytes - previous + body.length <= quotaUser.maxStorageBytes, 413, 'STORAGE_QUOTA', '写入将超过用户存储配额。');
    const file = workspace.writeFile(project, url.searchParams.get('path') || '', body, { expectedVersion });
    db.touchProject(project.id);
    audit(req, session, 'file.write', 'project', project.id, { path: file.path, bytes: body.length });
    sendJson(res, 200, { file }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const project = projectFor(session, match[1]);
    requireWorkspaceIdle(project);
    const result = workspace.moveToTrash(project, url.searchParams.get('path') || '');
    db.touchProject(project.id);
    audit(req, session, 'file.trash', 'project', project.id, { path: result.path });
    sendJson(res, 200, result, config);
    return;
  }
  match = pathname.match(/^\/api\/projects\/([^/]+)\/directory$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let project = projectFor(session, match[1]);
    const expectedAccessId = project.accessId;
    requireWorkspaceIdle(project);
    const body = await readJson(req);
    session = refreshSession(session);
    project = projectFor(session, match[1]);
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    requireWorkspaceIdle(project);
    const result = workspace.makeDirectory(project, body.path);
    db.touchProject(project.id);
    audit(req, session, 'directory.create', 'project', project.id, { path: result.path });
    sendJson(res, 201, result, config);
    return;
  }

  match = pathname.match(/^\/api\/projects\/([^/]+)\/chats$/);
  if (match && req.method === 'GET') {
    const project = projectFor(session, match[1]);
    sendJson(res, 200, { chats: db.listChats({ projectId: project.id, userId: session.user.id }).filter((chat) => chat.projectAccessId === project.accessId).map(chatPayload) }, config);
    return;
  }
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let project = projectFor(session, match[1]);
    const expectedAccessId = project.accessId;
    const body = await readJson(req);
    session = refreshSession(session);
    project = projectFor(session, match[1]);
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    invariant(!codex.sharingAccesses.has(project.accessId), 409, 'WORKSPACE_BUSY', '项目正在共享，请稍后重试。');
    const chat = db.createChat({
      projectId: project.id,
      userId: session.user.id,
      projectAccessId: project.accessId,
      treePath: project.treePath,
      title: shortText(body.title || '新对话', '对话标题', 120),
      preferredMode: turnMode(body.preferredMode),
    });
    audit(req, session, 'chat.create', 'chat', chat.id, { projectId: project.id });
    sendJson(res, 201, { chat: chatPayload(chat) }, config);
    return;
  }

  match = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const expectedThreadId = chat.codexThreadId || chat.localSessionId;
    const authorize = () => {
      const currentSession = refreshSession(session);
      const currentChat = chatFor(currentSession, chat.id);
      invariant((currentChat.codexThreadId || currentChat.localSessionId) === expectedThreadId, 409, 'THREAD_MAPPING_CHANGED', '对话线程已变化，请刷新后重试。');
      return { currentSession, currentChat };
    };
    const messages = await codex.historyForChat(chat, authorize);
    const { currentSession, currentChat } = authorize();
    const task = currentChat.taskId ? taskFor(currentSession, currentChat.taskId) : null;
    sendJson(res, 200, {
      chat: chatPayload(currentChat), task: task ? graphs.publicTask(task) : null, messages,
      latestTurnRun: db.getLatestTurnRunForChat(currentChat.id), latestEventId: db.getLatestTurnEventId(currentChat.id),
    }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/memory$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    sendJson(res, 200, { settings: memory.settings(chat), references: memory.refsForChat(chat, session.user.id) }, config);
    return;
  }
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    let chat = chatFor(session, match[1]);
    invariant(!codex.chatBusy(chat.id), 409, 'CHAT_RUNNING', '请等待当前任务结束后修改记忆设置。');
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session); chat = chatFor(session, match[1]);
    invariant(!codex.chatBusy(chat.id), 409, 'CHAT_RUNNING', '请等待当前任务结束后修改记忆设置。');
    const updated = memory.updateSettings(chat, body);
    audit(req, session, 'chat.memory_settings', 'chat', chat.id, memory.settings(updated));
    sendJson(res, 200, { chat: chatPayload(updated), settings: memory.settings(updated) }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/turn-runs\/([^/]+)\/memory-references$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const run = db.getTurnRun(match[2]);
    invariant(run?.chatId === chat.id && run.userId === session.user.id, 403, 'TURN_FORBIDDEN', '运行不存在或不属于你。');
    sendJson(res, 200, { references: memory.refsForTurn(run.id, session.user.id) }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)$/);
  if (match && req.method === 'PATCH') {
    requireMutation(req, session);
    let chat = chatFor(session, match[1]);
    const body = await readJson(req);
    session = refreshSession(session);
    chat = chatFor(session, match[1]);
    invariant(!codex.sharingAccesses.has(chat.projectAccessId), 409, 'WORKSPACE_BUSY', '项目正在共享，请稍后重试。');
    const patch = {};
    if (body.title !== undefined) patch.title = shortText(body.title, '对话标题', 120);
    if (body.preferredMode !== undefined) patch.preferredMode = turnMode(body.preferredMode);
    if (body.preferredModel !== undefined || body.preferredEffort !== undefined) {
      assertStandardProject(db.getProject(chat.projectId));
      invariant(!chat.purpose || chat.purpose === 'normal', 403, 'WORKFLOW_JOB_REQUIRED', '后台对话由工作图调度器管理。');
      invariant(!codex.chatBusy(chat.id) && !db.listChatInputs(chat.id).length, 409, 'CHAT_RUNNING', '请等待当前任务和消息队列结束后切换模型。');
      if (body.preferredModel !== undefined) patch.preferredModel = validateModel(body.preferredModel);
      if (body.preferredEffort !== undefined) patch.preferredEffort = validateEffort(body.preferredEffort);
    }
    if (body.controlMode !== undefined) {
      invariant(isPrivateProject(db.getProject(chat.projectId)), 400, 'PRIVATE_PROJECT_REQUIRED', '只有隐私项目支持本地控制模式。');
      invariant(!codex.chatBusy(chat.id) && !db.listChatInputs(chat.id).length, 409, 'CHAT_RUNNING', '请等待运行及队列结束再改变审批模式。');
      invariant(['manual', 'auto'].includes(body.controlMode), 400, 'INVALID_CONTROL_MODE', '审批模式无效。');
      patch.controlMode = body.controlMode;
    }
    invariant(Object.keys(patch).length > 0, 400, 'INVALID_CHAT_UPDATE', '没有可更新的对话字段。');
    const updated = db.updateChat(chat.id, patch);
    audit(req, session, 'chat.update', 'chat', chat.id, { preferredMode: patch.preferredMode || null });
    sendJson(res, 200, { chat: chatPayload(updated) }, config);
    return;
  }
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const chat = chatFor(session, match[1]);
    invariant(!codex.chatBusy(chat.id), 409, 'CHAT_RUNNING', '请先停止正在运行、排队或恢复中的任务。');
    invariant(!chat.workflowJobId, 409, 'CHAT_HAS_WORKFLOW', '后台工作图对话用于恢复与审核，不可删除。');
    invariant(!db.chatHasSubmission(chat.id), 409, 'CHAT_HAS_SUBMISSION', '该对话包含不可变的任务提交证据，不能删除。');
    try { db.deleteChat(chat.id); } catch (error) { throw new HttpError(409, 'CHAT_DELETE_REJECTED', error.message); }
    audit(req, session, 'chat.delete', 'chat', chat.id);
    sendJson(res, 200, { ok: true }, config);
    return;
  }

  match = pathname.match(/^\/api\/chats\/([^/]+)\/queue(?:\/([^/]+)(?:\/(steer|resume))?)?$/);
  if (match) {
    let chat = chatFor(session, match[1]);
    const inputId = match[2];
    const action = match[3];
    const inputPayload = (input) => input && ({
      id: input.id, prompt: input.prompt, mode: input.mode, effort: input.effort,
      status: input.status, revision: input.revision, reason: input.reason,
      turnRunId: input.turn_run_id, createdAt: input.created_at,
    });
    if (req.method === 'GET' && !inputId) {
      const run = db.getLatestTurnRunForChat(chat.id);
      sendJson(res, 200, { inputs: db.listChatInputs(chat.id).map(inputPayload),
        latestTurnRun: run && { id: run.id, status: run.status, mode: run.mode } }, config);
      return;
    }
    requireMutation(req, session);
    const body = await readJson(req, 512 * 1024);
    invariant(body && typeof body === 'object' && !Array.isArray(body), 400, 'INVALID_JSON_BODY', '请求必须是 JSON 对象。');
    session = refreshSession(session);
    chat = chatFor(session, match[1]);
    let input;
    if (req.method === 'POST' && !inputId) input = codex.inputQueue.enqueue(chat.id, body);
    else if (req.method === 'PATCH' && inputId && !action) input = codex.inputQueue.edit(chat.id, inputId, body.revision, body.prompt);
    else if (req.method === 'DELETE' && inputId && !action) input = codex.inputQueue.cancel(chat.id, inputId, body.revision);
    else if (req.method === 'POST' && action === 'resume') input = codex.inputQueue.resume(chat.id, inputId, body.revision, body.acknowledgeUncertain);
    else if (req.method === 'POST' && action === 'steer') input = await codex.inputQueue.steer(chat.id, inputId, body.revision, body.expectedRunId);
    else throw new HttpError(405, 'METHOD_NOT_ALLOWED', '不支持此队列操作。');
    session = refreshSession(session);
    chatFor(session, chat.id);
    audit(req, session, `input.${action || req.method.toLowerCase()}`, 'chat', chat.id, { inputId: input.id, status: input.status });
    sendJson(res, 200, { input: inputPayload(input) }, config);
    return;
  }

  match = pathname.match(/^\/api\/chats\/([^/]+)\/turns$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let chat = chatFor(session, match[1]);
    let project = projectFor(session, chat.projectId);
    invariant(project.accessId === chat.projectAccessId, 403, 'PROJECT_ACCESS_REVOKED', '该对话对应的项目授权已撤销。');
    const body = await readJson(req, 256 * 1024);
    session = refreshSession(session);
    chat = chatFor(session, match[1]);
    project = projectFor(session, chat.projectId);
    invariant(project.accessId === chat.projectAccessId, 403, 'PROJECT_ACCESS_REVOKED', '该对话对应的项目授权已撤销。');
    invariant(!codex.sharingAccesses.has(project.accessId), 409, 'WORKSPACE_BUSY', '项目正在共享，请稍后重试。');
    const mode = turnMode(body.mode, chat.preferredMode || 'execute');
    const effort = rootEffort(config, chat, session.user, body.effort);
    if (chat.preferredMode !== mode) chat = db.updateChat(chat.id, { preferredMode: mode });
    sseHeaders(res, config);
    const close = () => {
      if (res.writableEnded) return;
      // Preserve the legacy terminal-frame contract without releasing any
      // task content after the Web session has been revoked.
      sse(res, 'turn_error', { code: 'AUTH_REQUIRED', message: '登录状态已失效，请重新登录。' });
      res.end();
    };
    const unregister = registerSessionStream(session, close);
    const emit = (event, data) => {
      if (!db.getSession(session.tokenHash)) { close(); return; }
      sse(res, event, data);
    };
    const heartbeat = setInterval(() => emit('ping', { at: Date.now() }), 15_000);
    audit(req, session, 'turn.start', 'chat', chat.id, { effort, mode });
    try {
      await codex.runTurn({ chat, project, user: session.user, prompt: body.prompt, effort, mode, emit });
    } catch (error) {
      if (!error.turnEventEmitted) emit('turn_error', { message: error.message, code: error.code || 'TURN_FAILED' });
    } finally {
      clearInterval(heartbeat);
      unregister();
      if (!res.writableEnded) res.end();
    }
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/tool-calls$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const run = url.searchParams.has('runId') ? db.getTurnRun(url.searchParams.get('runId')) : db.getLatestTurnRunForChat(chat.id);
    invariant(!run || (run.chatId === chat.id && run.userId === session.user.id), 403, 'TURN_FORBIDDEN', '运行记录不属于此对话。');
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    sendJson(res, 200, run ? { runId: run.id, ...codex.toolDetails.list(chat.id, run.id, after) } : { runId: null, items: [], cursor: 0, hasMore: false }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/events$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const afterId = Math.max(0, Number(url.searchParams.get('after')) || 0);
    sendJson(res, 200, {
      events: db.listTurnEvents(chat.id, { afterId, limit: Number(url.searchParams.get('limit')) || 1000 }),
      latestTurnRun: db.getLatestTurnRunForChat(chat.id), latestEventId: db.getLatestTurnEventId(chat.id),
    }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/turn-runs\/([^/]+)\/events$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const run = db.getTurnRun(match[2]);
    invariant(run && run.chatId === chat.id && run.userId === session.user.id, 403, 'TURN_FORBIDDEN', '运行记录不存在或不属于你。');
    const headerCursor = Number(req.headers['last-event-id']);
    const queryCursor = Number(url.searchParams.get('after'));
    let lastSent = Math.max(0, Number.isSafeInteger(headerCursor) ? headerCursor : Number.isSafeInteger(queryCursor) ? queryCursor : 0);
    const buffered = [];
    let replaying = true;
    let closed = false;
    let heartbeat;
    let unregisterSession = () => {};
    const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unregisterSession();
      codex.off('turnEvent', onEvent);
      codex.off('turnLiveEvent', onLiveEvent);
    };
    const sendEvent = (event, live = false) => {
      if (closed || (!live && event.id <= lastSent) || event.turnRunId !== run.id) return;
      const currentSession = db.getSession(session.tokenHash);
      const currentUser = currentSession?.user.id === session.user.id ? currentSession.user : null;
      const currentChat = db.getChat(chat.id);
      const currentAccess = currentUser?.status === 'active' && currentChat
        ? db.getProjectForUser(currentChat.projectId, currentUser.id) : null;
      if (!currentUser || currentUser.status !== 'active' || !currentChat || !currentAccess
        || currentAccess.accessId !== currentChat.projectAccessId) {
        cleanup(); if (!res.writableEnded) res.end(); return;
      }
      if (!live) lastSent = event.id;
      sse(res, event.eventType, { ...event.payload, turnRunId: event.turnRunId, ...(!live ? { eventId: event.id } : {}) });
      const currentRun = db.getTurnRun(run.id);
      if (currentRun && terminal.has(currentRun.status) && ['turn_completed', 'turn_error'].includes(event.eventType)) {
        cleanup(); if (!res.writableEnded) res.end();
      }
    };
    const onEvent = (event) => {
      if (event.turnRunId !== run.id) return;
      if (replaying) buffered.push(event);
      else sendEvent(event);
    };
    const onLiveEvent = (event) => { if (!replaying) sendEvent(event, true); };
    codex.on('turnEvent', onEvent);
    codex.on('turnLiveEvent', onLiveEvent);
    unregisterSession = registerSessionStream(session, () => { cleanup(); if (!res.writableEnded) res.end(); });
    sseHeaders(res, config);
    const waterline = db.getLatestTurnEventIdForRun(run.id);
    while (!closed && lastSent < waterline) {
      const page = db.listTurnEvents(chat.id, { afterId: lastSent, turnRunId: run.id, throughId: waterline, limit: 1000 });
      if (!page.length) break;
      page.forEach((event) => sendEvent(event));
    }
    replaying = false;
    buffered.sort((a, b) => a.id - b.id).forEach((event) => sendEvent(event));
    if (!closed && terminal.has(db.getTurnRun(run.id)?.status)) {
      cleanup(); if (!res.writableEnded) res.end();
    } else if (!closed) {
      heartbeat = setInterval(() => {
        if (!db.getSession(session.tokenHash)) { cleanup(); if (!res.writableEnded) res.end(); return; }
        sse(res, 'ping', { at: Date.now() });
      }, 15_000);
      req.on('close', cleanup);
    }
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/(?:thread-recovery|thread\/recover)$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let chat = chatFor(session, match[1]);
    let project = projectFor(session, chat.projectId);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    chat = chatFor(session, match[1]);
    project = projectFor(session, chat.projectId);
    const recovered = await codex.recoverChatThread({
      chat, project, user: session.user, action: String(body.action || ''),
      acknowledgeHistoryBreak: body.acknowledgeHistoryBreak === true || body.acknowledgeContextReset === true,
    });
    audit(req, session, 'chat.thread_recovered', 'chat', chat.id, {
      strategy: body.action === 'reset' ? 'explicit_reset' : 'resume_retry',
      mappingChanged: (chat.codexThreadId || chat.localSessionId || null) !== (recovered.codexThreadId || recovered.localSessionId || null),
    });
    sendJson(res, 200, { chat: chatPayload(recovered), recoveries: db.listChatThreadRecoveries(chat.id) }, config);
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

  match = pathname.match(/^\/api\/chats\/([^/]+)\/goal$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    const expectedThreadId = chat.codexThreadId || chat.localSessionId;
    const authorize = () => {
      const currentSession = refreshSession(session);
      const currentChat = chatFor(currentSession, chat.id);
      invariant((currentChat.codexThreadId || currentChat.localSessionId) === expectedThreadId, 409, 'THREAD_MAPPING_CHANGED', '对话线程已变化，请刷新后重试。');
    };
    const goal = await codex.getGoal(chat, authorize);
    authorize();
    sendJson(res, 200, { goal }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/approvals$/);
  if (match && req.method === 'GET') {
    const chat = chatFor(session, match[1]);
    sendJson(res, 200, { approvals: codex.pendingApprovalsForChat(chat.id, session.user.id) }, config);
    return;
  }
  match = pathname.match(/^\/api\/chats\/([^/]+)\/approvals\/([^/]+)$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let chat = chatFor(session, match[1]);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    chat = chatFor(session, match[1]);
    const approval = codex.resolveApproval({
      chatId: chat.id, userId: session.user.id, approvalId: decodeURIComponent(match[2]), decision: String(body.decision || ''), query: body.query,
    });
    audit(req, session, 'turn.approval', 'turn_approval', approval.id, { chatId: chat.id, decision: body.decision });
    sendJson(res, 200, { approval }, config);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tasks') {
    sendJson(res, 200, { tasks: db.listTasks({ userId: session.user.id }).filter((task) => db.getProjectForUser(task.projectId, session.user.id) && (!task.workflowRunId
      || (!['cancelled', 'superseded'].includes(graphStore.run(task.workflowRunId)?.status)
        && db.getRoadmap(task.roadmapId)?.currentWorkflowId === task.workflowRunId))).map((task) => graphs.publicTask(task)) }, config);
    return;
  }
  match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (match && req.method === 'GET') {
    const task = taskFor(session, match[1]);
    sendJson(res, 200, { task, submissions: db.listSubmissionsForTask(task.id).filter((item) => item.submitterUserId === session.user.id) }, config);
    return;
  }
  match = pathname.match(/^\/api\/tasks\/([^/]+)\/chat$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const task = taskFor(session, match[1]);
    if (task.workflowRunId) graphs.taskFor(task.id, session.user.id);
    invariant(['active', 'rework'].includes(task.status), 409, 'TASK_NOT_ACTIVE', '任务尚未激活、正在审核或已经通过。');
    const project = projectFor(session, task.projectId);
    invariant(!codex.sharingAccesses.has(project.accessId), 409, 'WORKSPACE_BUSY', '项目正在共享，请稍后重试。');
    let chat = db.listChats({ projectId: project.id, userId: session.user.id })
      .find((candidate) => candidate.taskId === task.id && candidate.taskVersion === task.version
        && candidate.projectAccessId === project.accessId);
    if (!chat) chat = db.createChat({
      projectId: project.id, userId: session.user.id, projectAccessId: project.accessId, treePath: project.treePath,
      title: `任务 · ${task.title}`.slice(0, 120), taskId: task.id, taskVersion: task.version,
    });
    audit(req, session, 'task.chat_open', 'task', task.id, { chatId: chat.id, taskVersion: task.version });
    sendJson(res, 200, { task: graphs.publicTask(task), project: projectPayload(project), chat: chatPayload(chat) }, config);
    return;
  }
  match = pathname.match(/^\/api\/tasks\/([^/]+)\/submissions$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    let task = taskFor(session, match[1]);
    let project = projectFor(session, task.projectId);
    const expectedAccessId = project.accessId;
    const body = await readJson(req, 32 * 1024);
    session = refreshSession(session);
    task = taskFor(session, match[1]);
    project = projectFor(session, task.projectId);
    invariant(project.accessId === expectedAccessId, 403, 'PROJECT_ACCESS_REVOKED', '任务对应的项目授权已变化。');
    requireWorkspaceIdle(project);
    invariant(['active', 'rework'].includes(task.status) && Number(body.taskVersion) === task.version,
      409, 'TASK_VERSION_CHANGED', '任务版本已变化，请刷新后重新提交。');
    const note = String(body.note || '').trim();
    invariant(note.length <= 4000, 400, 'INVALID_NOTE', '提交说明不能超过 4000 个字符。');
    const run = db.getTurnRun(String(body.turnRunId || ''));
    invariant(run && run.userId === session.user.id, 403, 'TURN_FORBIDDEN', 'Codex 回复不存在或不属于你。');
    invariant(run.taskId === task.id && run.chatId === String(body.chatId || ''), 403, 'TASK_TURN_MISMATCH', 'Codex 回复不属于这个任务。');
    invariant(run.finalItemId === String(body.itemId || ''), 409, 'FINAL_ITEM_REQUIRED', '只能提交已完成的最终 Codex 回复。');
    const snapshot = worktrees.createSubmissionSnapshot({
      treePath: project.treePath, taskId: task.id, taskVersion: Number(body.taskVersion),
    });
    let submission;
    try {
      submission = db.submitTask({
        taskId: task.id, taskVersion: Number(body.taskVersion), submitterUserId: session.user.id,
        projectAccessId: project.accessId, chatId: run.chatId, turnRunId: run.id, itemId: run.finalItemId, note,
        snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha,
      });
    } catch (error) {
      throw new HttpError(409, 'TASK_SUBMISSION_REJECTED', error.message);
    }
    audit(req, session, 'task.submit', 'task_submission', submission.id, {
      taskId: task.id, taskVersion: submission.taskVersion, turnRunId: run.id,
      projectAccessId: project.accessId, snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha,
    });
    sendJson(res, 201, { submission, task: taskFor(session, task.id) }, config);
    return;
  }

  if (pathname.startsWith('/api/admin/')) requireAdmin(session);
  if (req.method === 'GET' && pathname === '/api/admin/roadmaps') {
    const owned = new Set(db.listProjects(session.user.id).map((project) => project.id));
    sendJson(res, 200, { roadmaps: db.listRoadmaps().filter((roadmap) => owned.has(roadmap.projectId)) }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/roadmaps') {
    requireMutation(req, session);
    const body = await readJson(req, 256 * 1024);
    session = refreshSession(session);
    const project = ownerProject(projectFor(session, String(body.projectId || '')));
    assertStandardProject(project);
    invariant(Array.isArray(body.steps) && body.steps.length > 0 && body.steps.length <= 100, 400, 'INVALID_ROADMAP_STEPS', '路线图必须包含 1–100 个线性步骤。');
    const activeAccess = db.listProjectAccess(project.id, { activeOnly: true });
    const steps = body.steps.map((step, index) => {
      const assignee = db.getUserById(String(step.assigneeUserId || ''));
      invariant(assignee && assignee.role === 'user' && assignee.status === 'active', 400, 'INVALID_ASSIGNEE', `第 ${index + 1} 步的员工无效。`);
      invariant(activeAccess.some((access) => access.accessKind === 'shared' && access.userId === assignee.id), 409, 'ASSIGNEE_PROJECT_ACCESS_REQUIRED', `第 ${index + 1} 步的员工尚未获得该项目授权。`);
      return {
        assigneeUserId: assignee.id,
        title: shortText(step.title, `第 ${index + 1} 步标题`, 160),
        acceptance: shortText(step.acceptance, `第 ${index + 1} 步验收标准`, 4000),
      };
    });
    const status = body.status === 'ready' ? 'ready' : 'draft';
    const roadmap = db.createRoadmap({ projectId: project.id, title: shortText(body.title, '路线图标题', 160), steps, status });
    audit(req, session, 'roadmap.create', 'roadmap', roadmap.id, { projectId: project.id, steps: steps.length, status });
    sendJson(res, 201, { roadmap }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/roadmaps\/([^/]+)\/activate$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const roadmap = db.getRoadmap(match[1]);
    invariant(roadmap, 404, 'ROADMAP_NOT_FOUND', '路线图不存在。');
    ownerProject(projectFor(session, roadmap.projectId));
    let updated;
    try { updated = db.activateRoadmap(roadmap.id); } catch (error) { throw new HttpError(409, 'ROADMAP_ACTIVATE_REJECTED', error.message); }
    audit(req, session, 'roadmap.activate', 'roadmap', roadmap.id);
    sendJson(res, 200, { roadmap: updated }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/task-submissions') {
    const owned = new Set(db.listProjects(session.user.id).map((project) => project.id));
    const submissions = db.listSubmissions().filter((submission) => owned.has(db.getTask(submission.taskId)?.projectId));
    sendJson(res, 200, { submissions }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/task-submissions\/([^/]+)\/review$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    reviews.context(match[1], session.user.id);
    const body = await readJson(req, 16 * 1024);
    session = refreshSession(session);
    let result;
    try { result = reviews.legacy({ submissionId: match[1], ownerId: session.user.id, verdict: body.verdict }); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(409, 'SUBMISSION_REVIEW_REJECTED', error.message);
    }
    audit(req, session, 'task.review', 'task_submission', result.submission.id,
      { taskId: result.task.id, verdict: body.verdict, deliveryCommitSha: result.delivery?.deliveryCommitSha || null,
        alreadyDelivered: result.delivery?.alreadyDelivered || false });
    sendJson(res, 200, { submission: result.submission, task: result.task }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/token-usage') {
    sendJson(res, 200, { ...db.tokenUsage.dashboard(Object.fromEntries(url.searchParams)), localQwen: codex.local.status() }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
    const users = db.listUsers().map((user) => ({ ...user, usage: userUsage(user.id), profile: graphStore.profile(user.id) }));
    sendJson(res, 200, {
      stats: db.stats(), codex: codex.status(), users,
      defaults: { networkAccess: config.defaultNetworkAccess },
      projects: db.listAdminProjects().filter((project) => !isPrivateProject(project) || project.userId === session.user.id).map(projectPayload),
    }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/initialize-git$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const project = ownerProject(projectFor(session, match[1]));
    const result = worktrees.initialize(workspace.projectRoot(project));
    db.setProjectRepoKind(project.id, 'git');
    audit(req, session, 'project.git_initialize', 'project', project.id);
    sendJson(res, 200, { ok: true, ...result }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/shares$/);
  if (match && req.method === 'POST') {
    requireMutation(req, session);
    const project = ownerProject(projectFor(session, match[1]));
    const body = await readJson(req, 32 * 1024);
    const authorize = () => {
      session = refreshSession(session);
      const current = ownerProject(projectFor(session, project.id));
      invariant(current.accessId === project.accessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已变化。');
    };
    authorize();
    const result = await shares.grant({ project, userId: String(body.userId || ''), authorize,
      scope: body.scope || 'files_and_history', memoryConfirmationToken: body.memoryConfirmationToken || null });
    audit(req, session, result.restored ? 'project.share_restore' : 'project.share_grant', 'project_access', result.access.id,
      { projectId: project.id, employeeId: result.access.userId, baseSha: result.access.baseSha,
        copiedChats: result.copiedChats, scope: body.scope || 'files_and_history' });
    sendJson(res, result.restored ? 200 : 201, { ...result, access: accessPayload(result.access) }, config);
    return;
  }
  match = pathname.match(/^\/api\/admin\/projects\/([^/]+)\/shares\/([^/]+)$/);
  if (match && req.method === 'DELETE') {
    requireMutation(req, session);
    const project = ownerProject(projectFor(session, match[1]));
    const access = db.getProjectAccessById(match[2]);
    invariant(access && access.projectId === project.id && access.accessKind === 'shared'
      && ['active', 'revoked'].includes(access.status), 404, 'SHARE_NOT_FOUND', '授权不存在。');
    if (access.status === 'active') db.revokeProjectAccess(access.id);
    try { await Promise.all([codex.interruptAccessAndWait(access.id), graphRuntime.interruptMember(access.userId, project.id)]); }
    catch (error) {
      if (error.code === 'TURN_DRAIN_TIMEOUT') throw new HttpError(409, 'SHARE_DRAIN_TIMEOUT', '撤权已生效，但运行尚未完全排空；工作树已保留，可稍后重试清理。');
      throw error;
    }
    const sourceMemories = memory.memoryIdsForSourceProject(project.id, access.userId);
    const affectedMemoryChats = [...new Set(sourceMemories.flatMap((id) => memory.dependentChatIds(id, access.userId)))];
    await Promise.all(affectedMemoryChats.map((chatId) => codex.interruptAndWait(chatId)));
    memory.invalidateThreads(sourceMemories);
    memory.refreshIndex(access.userId);
    invariant(!db.runtimeForAccess(access.id).busy, 409, 'ACCESS_BUSY', '授权仍有未排空的运行时状态，工作树已保留。');
    let cleanup;
    try {
      cleanup = worktrees.removeShare({ projectRoot: workspace.projectRoot(project), treePath: access.treePath });
    } catch (error) {
      cleanup = { removed: false, dirty: true, error: error.message };
    }
    audit(req, session, 'project.share_revoke', 'project_access', access.id, {
      projectId: project.id, employeeId: access.userId, treeRemoved: cleanup.removed, dirtyTreePreserved: cleanup.dirty,
    });
    sendJson(res, 200, {
      ok: true,
      cleanup: { removed: Boolean(cleanup.removed), dirty: Boolean(cleanup.dirty), missing: Boolean(cleanup.missing), error: cleanup.error },
    }, config);
    return;
  }
  if (req.method === 'GET' && pathname === '/api/admin/users') {
    sendJson(res, 200, { users: db.listUsers().map((user) => ({ ...user, usage: userUsage(user.id) })) }, config);
    return;
  }
  if (req.method === 'POST' && pathname === '/api/admin/users') {
    requireMutation(req, session);
    const body = await readJson(req, 64 * 1024);
    session = refreshSession(session);
    const username = validateUsername(body.username);
    invariant(!db.getUserAuthByUsername(username), 409, 'USERNAME_EXISTS', '用户名已存在。');
    const displayName = shortText(body.displayName || username, '显示名称', 64);
    const password = String(body.password || '');
    invariant(password.length >= 12 && password.length <= 256, 400, 'INVALID_PASSWORD', '密码长度必须为 12–256 个字符。');
    const passwordHash = await hashPassword(password);
    session = refreshSession(session);
    requireAdmin(session);
    invariant(!db.getUserAuthByUsername(username), 409, 'USERNAME_EXISTS', '用户名已存在。');
    const user = db.createUser({
      username, displayName, passwordHash, role: 'user',
      networkAccess: Boolean(body.networkAccess ?? config.defaultNetworkAccess),
      maxProjects: boundedInteger(body.maxProjects ?? config.defaultMaxProjects, '项目上限', 1, 100),
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
    let target = db.getUserById(match[1]);
    invariant(target, 404, 'USER_NOT_FOUND', '用户不存在。');
    const body = await readJson(req, 64 * 1024);
    session = refreshSession(session);
    requireAdmin(session);
    target = db.getUserById(match[1]);
    invariant(target, 404, 'USER_NOT_FOUND', '用户不存在。');
    invariant(!(target.role === 'admin' && body.status && body.status !== 'active'), 400, 'ADMIN_DISABLE_BLOCKED', '不能停用超级管理员账号。');
    const patch = {};
    if (body.displayName !== undefined) patch.displayName = shortText(body.displayName, '显示名称', 64);
    if (body.status !== undefined) { invariant(['active', 'disabled'].includes(body.status), 400, 'INVALID_STATUS', '账号状态无效。'); patch.status = body.status; }
    if (body.networkAccess !== undefined) patch.networkAccess = Boolean(body.networkAccess);
    if (body.maxProjects !== undefined) patch.maxProjects = boundedInteger(body.maxProjects, '项目上限', 1, target.role === 'user' ? 100 : 10000);
    if (body.maxStorageBytes !== undefined) patch.maxStorageBytes = boundedInteger(body.maxStorageBytes, '存储上限', 1024 * 1024, Number.MAX_SAFE_INTEGER);
    if (body.maxConcurrentTurns !== undefined) patch.maxConcurrentTurns = boundedInteger(body.maxConcurrentTurns, '并发上限', 1, config.codexMaxConcurrentTurns);
    if (body.password !== undefined && String(body.password).length) {
      const password = String(body.password);
      invariant(password.length >= 12 && password.length <= 256, 400, 'INVALID_PASSWORD', '密码长度必须为 12–256 个字符。');
      patch.passwordHash = await hashPassword(password);
      session = refreshSession(session);
      requireAdmin(session);
      target = db.getUserById(match[1]);
      invariant(target, 404, 'USER_NOT_FOUND', '用户不存在。');
    }
    const updated = db.updateUser(target.id, patch);
    if (patch.status === 'disabled' || patch.passwordHash) db.deleteUserSessions(target.id);
    if (patch.status === 'disabled' || patch.passwordHash || (patch.networkAccess !== undefined && patch.networkAccess !== target.networkAccess)) {
      try {
        await Promise.all([codex.interruptUserAndWait(target.id), graphRuntime.interruptMember(target.id)]);
      } catch (error) {
        audit(req, session, 'user.update', 'user', target.id, {
          fields: Object.keys(patch).filter((key) => key !== 'passwordHash'),
          passwordReset: Boolean(patch.passwordHash), drainComplete: false,
        });
        if (error.code === 'USER_DRAIN_TIMEOUT') {
          throw new HttpError(409, 'USER_DRAIN_TIMEOUT', '账号策略已更新并已阻止新请求，但既有运行尚未完全排空。');
        }
        throw error;
      }
    }
    audit(req, session, 'user.update', 'user', target.id, {
      fields: Object.keys(patch).filter((key) => key !== 'passwordHash'),
      passwordReset: Boolean(patch.passwordHash), drainComplete: true,
    });
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

const handleBrowser = browserRoutes({ codex, config, chatFor, requireMutation, refreshSession, checkOrigin });
await bootstrapAdmin();
db.cleanSessions();

const server = http.createServer(async (req, res) => {
  try {
    requestIngress(req, config);
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
  if (config.workGraphDispatchEnabled) workflowScheduler.start();
  else workflowScheduler.stop();
  memory.start();
  codex.start().then(() => log('info', 'Codex app-server 已就绪')).catch((error) => log('error', 'Codex app-server 启动失败；首次对话会重试', { message: error.message }));
});

function shutdown(signal) {
  log('info', `收到 ${signal}，正在关闭`);
  workflowScheduler.stop();
  memory.stop();
  const stopped = codex.stop();
  server.close(async () => {
    await Promise.allSettled([...workflowScheduler.inFlight.values()].map(entry => entry.promise));
    await codex.local.drain();
    await stopped;
    db.close(); process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { server, config, db, workspace, codex, securityHeaders };
