import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHmac } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { buildSeatbeltProfile } from './sandbox.mjs';
import { invariant } from './errors.mjs';

const run = promisify(execFile);
const worker = fileURLToPath(new URL('./wechat-desktop-reader.py', import.meta.url));
const help = [
  '/portal  打开老板工作台',
  '/tell 对话ID 指令  向已有任务发送消息',
  '/projects  老板的 Portal 项目',
  '/desktop  桌面 Codex 项目',
  '/files 项目ID [目录]  列目录',
  '/file 项目ID 文件路径  读文本',
  '/chats 项目ID  列项目对话',
  '/chats desktop  列本人桌面对话（含无项目对话）',
  '/chat 对话ID  读对话',
  '翻页时在命令后加 @2，例如 /chats @2 desktop。路径可以含空格。',
].join('\n');
const pageSize = 1500;
const denied = () => invariant(false, 403, 'WECHAT_LIBRARY_DENIED', '该内容不可用。');

export function parseLibraryCommand(text) {
  const m = /^\/(library|portal|tell|projects|desktop|files|file|chats|chat)(?=\s|$)\s*([\s\S]*)$/iu.exec(text.trim());
  if (!m) return null;
  const fields = /^(?:@(\d+)\s*\b\s*)?(?:(\S+)(?:\s+([\s\S]*))?)?$/u.exec(m[2]);
  if (!fields) return { action: 'library', page: 1 };
  return { action: m[1].toLowerCase(), page: Number(fields[1] || 1), target: fields[2] || '', relative: fields[3] || '' };
}

function sliceText(text, page) {
  const chars = Array.from(text);
  const offset = (page - 1) * pageSize;
  const next = chars.length > offset + pageSize ? `\n（下一页 @${page + 1}）` : '';
  return (chars.slice(offset, offset + pageSize).join('') || '本页无内容。') + next;
}

function privatePolicy(config) {
  const file = path.join(config.dataDir, 'wechat-owner-library.json');
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 256 * 1024) return denied();
      return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally { fs.closeSync(fd); }
  } catch { return denied(); }
}

export function checkOwner({ config, db, owner, project, binding, senderId, externalScopeId }) {
  const user = db.getUserById(owner.id);
  const access = db.getProjectForUser(project.id, owner.id);
  const current = db.getChannelBinding('wechat', externalScopeId);
  if (!config.wechatChannelEnabled || !senderId || senderId !== config.wechatChannelSenderId || externalScopeId !== senderId
    || user?.status !== 'active' || user.role !== 'admin' || !user.networkAccess
    || !access || access.userId !== user.id || access.accessKind !== 'owner' || access.projectType !== 'standard'
    || project.id !== config.wechatChannelProjectId || current?.status !== 'active' || current.userId !== user.id
    || current.projectId !== project.id || current.chatId !== binding.chatId) return denied();
  const policy = privatePolicy(config);
  if (policy.ownerId !== user.id) return denied();
  return policy;
}

async function desktopText(ctx, policy, query) {
  const home = path.join(os.homedir(), '.codex');
  const table = path.join(home, 'state_5.sqlite');
  const deniedPaths = [ctx.config.dataDir, ctx.config.workspacesRoot, ctx.config.treesRoot, ctx.config.trashRoot, ctx.config.runtimeRoot].filter(Boolean);
  const managedThreads = ctx.db.db.prepare(`SELECT codex_thread_id AS id FROM chats WHERE codex_thread_id IS NOT NULL
    UNION SELECT codex_thread_id FROM turn_runs UNION SELECT codex_thread_id FROM task_submissions
    UNION SELECT old_thread_id FROM chat_thread_recoveries UNION SELECT new_thread_id FROM chat_thread_recoveries`).all().map(row => row.id).filter(Boolean);
  const roots = policy.projects.filter(p => p.key === query.target && ['files', 'file'].includes(query.action)).map(p => p.path);
  const readableRoots = [worker, table, table + '-wal', table + '-shm', ...roots];
  if (['chats', 'chat', 'target'].includes(query.action)) readableRoots.push(path.join(home, 'sessions'), path.join(home, 'archived_sessions'));
  const metadata = new Set(['/Library']);
  for (const item of [...readableRoots, home]) {
    for (let p = path.dirname(item); p !== path.dirname(p); p = path.dirname(p)) metadata.add(p);
  }
  const profile = buildSeatbeltProfile({ readableRoots, readableMetadataPaths: [...metadata], deniedPaths, networkAccess: false });
  const request = { home, policy, query, deniedPaths, managedThreads, pageSize };
  // The child receives neither a login credential nor the Portal database.
  const promise = run('/usr/bin/sandbox-exec', ['-p', profile, '/Library/Developer/CommandLineTools/usr/bin/python3', '-I', '-B', worker], {
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'en_US.UTF-8' }, timeout: 20000, maxBuffer: 32768,
  });
  promise.child.stdin.on('error', () => {});
  promise.child.stdin.end(JSON.stringify(request));
  try { return JSON.parse((await promise).stdout).text; } catch { return denied(); }
}

export async function desktopTarget(ctx, policy, target) {
  const text = await desktopText(ctx, policy, { action: 'target', target, relative: '', page: 1 });
  return JSON.parse(text);
}

async function libraryText(ctx, command, policy) {
  const { db, workspace, owner } = ctx;
  const { action, page, target, relative } = command;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return help;
  if (action === 'library') return help;
  if (action === 'portal') return (ctx.config.bossPublicOrigin || ctx.config.publicOrigin || `http://127.0.0.1:${ctx.config.port}`) + '/boss';
  if (action === 'desktop' || target === 'desktop' || target?.startsWith('d-')) return desktopText(ctx, policy, command);
  const projects = db.listProjectsForUser(owner.id).filter(p => p.userId === owner.id && p.accessKind === 'owner');
  if (action === 'projects') return sliceText(projects.map(p => `${p.name}（${p.projectType === 'local_private' ? '本地隐私' : '普通'}） ${p.id}`).join('\n'), page);
  if (action === 'chat') {
    const chat = db.getChat(target);
    if (!chat || chat.userId !== owner.id || !projects.some(p => p.id === chat.projectId && p.accessId === chat.projectAccessId)) return denied();
    const rows = db.db.prepare("SELECT role,content FROM messages WHERE chat_id=? AND role IN ('user','assistant') AND kind='message' ORDER BY created_at,rowid").iterate(target);
    const end = page * pageSize;
    let count = 0;
    const pieces = [];
    for (const row of rows) {
      const msg = Array.from(`${row.role === 'user' ? '老板' : '助手'}：${row.content}\n`);
      if (count + msg.length > end - pageSize) pieces.push(msg.slice(Math.max(0, end - pageSize - count), end + 1 - count).join(''));
      count += msg.length;
      if (count > end) break;
    }
    return (Array.from(pieces.join('')).slice(0, pageSize).join('') || '本页无内容。') + (count > end ? `\n（下一页 @${page + 1}）` : '');
  }
  const project = projects.find(p => p.id === target);
  if (!project) return denied();
  if (action === 'chats') return sliceText(db.listChats({ userId: owner.id, projectId: project.id })
    .filter(c => c.projectAccessId === project.accessId).map(c => `${c.title} ${c.id}`).join('\n'), page);
  if (action === 'files') {
    const tree = workspace.tree(project, relative, 1, 10000);
    return sliceText(tree.entries.map(e => e.name + (e.type === 'directory' ? '/' : '')).join('\n') + (tree.truncated ? '\n目录超过显示上限。' : ''), page);
  }
  if (action === 'file' && relative) return sliceText(workspace.readFile(project, relative).content, page);
  return help;
}

export async function answerLibrary(ctx, command) {
  const policy = checkOwner(ctx);
  const { db, eventId, externalScopeId, binding, secret, text } = ctx;
  const marker = 'owner-read/' + createHmac('sha256', secret).update(externalScopeId + '\0' + text).digest('hex');
  const existing = db.getChannelEvent('wechat', eventId);
  if (existing && (existing.externalScopeId !== externalScopeId || existing.chatId !== binding.chatId
    || existing.responseText !== marker)) return denied();
  // No model turn, transcript, tool detail or plaintext replay cache for direct queries.
  let result;
  try { result = await libraryText(ctx, command, policy); }
  catch { result = '该内容不可用。发送 /library 查看查询格式。'; }
  if (JSON.stringify(checkOwner(ctx)) !== JSON.stringify(policy)) return denied();
  if (!existing) {
    const event = db.createChannelEvent({ channel: 'wechat', externalEventId: eventId, externalScopeId, chatId: binding.chatId });
    if (!event.created && event.responseText !== marker) return denied();
    if (event.created) db.completeChannelEvent('wechat', eventId, { responseText: marker });
  }
  return { ok: true, status: 'completed', text: result, duplicate: Boolean(existing) };
}
