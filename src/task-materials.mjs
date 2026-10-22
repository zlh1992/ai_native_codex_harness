import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { invariant } from './errors.mjs';
import { assertStandardProject } from './private-projects.mjs';
import { graphRelativePath } from './work-graph-contract.mjs';
import { artifactText } from './artifact-text.mjs';

export const MATERIAL_LIMIT = 50 * 1024 * 1024;
const hash = b => createHash('sha256').update(b).digest('hex');
const now = () => new Date().toISOString();
export function materialName(value) {
  const name = String(value || '').normalize('NFKC');
  invariant(name && name.length <= 180 && !/[\\/\x00-\x1f\x7f]/u.test(name) && !['.', '..'].includes(name),
    400, 'INVALID_MATERIAL_NAME', '资料名称无效。');
  graphRelativePath(name);
  return name;
}
export function operationKey(value) {
  invariant(typeof value === 'string' && /^[A-Za-z0-9_-]{16,100}$/.test(value), 400, 'INVALID_IDEMPOTENCY_KEY', '操作须携带幂等标识。');
  return value;
}

export class TaskMaterials {
  constructor({ config, db, workspace, store, codex }) {
    Object.assign(this, { config, db, workspace, store, codex });
    this.sql = db.db; this.root = path.join(config.dataDir, 'task-materials');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  access(userId, projectId, accessId = null) {
    const user = this.db.getUserById(userId), project = this.db.getProjectForUser(projectId, userId);
    invariant(user?.status === 'active' && project && (!accessId || project.accessId === accessId), 403, 'PROJECT_ACCESS_REVOKED', '资料所属项目授权已失效。');
    assertStandardProject(project); return project;
  }
  owned(row, userId) {
    invariant(row?.owner_id === userId, 403, 'MATERIAL_FORBIDDEN', '资料不存在或不属于当前账号。');
    this.access(userId, row.project_id, row.access_id); return row;
  }
  row(id) { return this.sql.prepare('SELECT * FROM task_materials WHERE id=?').get(String(id || '')); }
  public(row) { return { id: row.id, name: row.name, size: row.size, sha256: row.sha256, projectId: row.project_id,
    createdAt: row.created_at, path: `inputs/${row.id}/${row.name}` }; }
  list(userId, projectId, chatId = null) {
    this.access(userId, projectId);
    return this.sql.prepare('SELECT * FROM task_materials WHERE owner_id=? AND project_id=? AND (? IS NULL OR chat_id=?) ORDER BY created_at DESC LIMIT 100')
      .all(userId, projectId, chatId, chatId).map(row => this.public(row));
  }
  bytes(row) {
    invariant(/^[a-f0-9-]{36}$/.test(row.id), 500, 'MATERIAL_INVALID', '资料标识损坏。');
    const file = path.join(this.root, row.id);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      invariant(stat.isFile() && stat.size === row.size && stat.size <= MATERIAL_LIMIT, 409, 'MATERIAL_CHANGED', '资料完整性校验失败。');
      const bytes = fs.readFileSync(fd);
      invariant(hash(bytes) === row.sha256, 409, 'MATERIAL_CHANGED', '资料完整性校验失败。'); return bytes;
    } finally { fs.closeSync(fd); }
  }
  storeFile({ userId, projectId, chatId = null, name, bytes, sourcePath = null, idempotencyKey }) {
    operationKey(idempotencyKey); name = materialName(name);
    const project = this.access(userId, projectId);
    if (chatId) invariant(this.db.getChat(chatId)?.userId === userId && this.db.getChat(chatId)?.projectAccessId === project.accessId,
      403, 'CHAT_FORBIDDEN', '资料对话不属于当前项目。');
    invariant(Buffer.isBuffer(bytes) && bytes.length <= MATERIAL_LIMIT, 413, 'MATERIAL_LIMIT', '资料最多 50 MiB。');
    const sha = hash(bytes);
    const old = this.sql.prepare('SELECT * FROM task_materials WHERE owner_id=? AND idempotency_key=?').get(userId, idempotencyKey);
    if (old) {
      this.owned(old, userId);
      invariant(old.sha256 === sha && old.project_id === projectId && old.name === name, 409, 'IDEMPOTENCY_CONFLICT', '上传标识已用于另一份资料。');
      return this.public(old);
    }
    const user = this.db.getUserById(userId);
    invariant(this.workspace.usageForUser(userId, this.db.listProjectsForUser(userId)).bytes + bytes.length <= user.maxStorageBytes,
      413, 'STORAGE_QUOTA', '资料将超过存储配额。');
    const id = randomUUID(); const file = path.join(this.root, id);
    fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
    try {
      this.sql.prepare(`INSERT INTO task_materials(id,owner_id,project_id,access_id,chat_id,name,size,sha256,source_path,created_at,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, projectId, project.accessId, chatId, name, bytes.length, sha, sourcePath, now(), idempotencyKey);
    } catch (error) { fs.unlinkSync(file); throw error; }
    return this.public(this.row(id));
  }
  capture({ userId, projectId, chatId = null, relative, idempotencyKey }) {
    const project = this.store.owner(projectId, userId);
    const file = this.workspace.readBuffer(project, graphRelativePath(relative), MATERIAL_LIMIT);
    return this.storeFile({ userId, projectId, chatId, name: file.path.split('/').at(-1), bytes: file.buffer,
      sourcePath: file.path, idempotencyKey });
  }
  async pack({ userId, projectId, chatId = null, paths, name, idempotencyKey, authorize = () => {} }) {
    const project = this.store.owner(projectId, userId);
    invariant(Array.isArray(paths) && paths.length > 0 && paths.length <= 30, 400, 'MATERIAL_LIMIT', '请选择 1–30 个文件或目录。');
    const files = new Set();
    for (const entry of paths) {
      const relative = graphRelativePath(entry);
      try { this.workspace.fileMetadata(project, relative); files.add(relative); }
      catch (error) {
        if (error.code !== 'NOT_A_FILE') throw error;
        const tree = this.workspace.tree(project, relative, 30, 5000);
        invariant(!tree.truncated, 413, 'MATERIAL_LIMIT', '目录文件过多，请缩小选择范围。');
        for (const item of tree.entries) if (item.type === 'file') files.add(item.path);
      }
    }
    invariant(files.size > 0 && files.size <= 5000, 413, 'MATERIAL_LIMIT', '打包文件数量无效。');
    const zip = new JSZip(); let total = 0;
    for (const relative of files) {
      const file = this.workspace.readBuffer(project, relative, MATERIAL_LIMIT - total);
      total += file.size; invariant(total <= MATERIAL_LIMIT, 413, 'MATERIAL_LIMIT', '打包原文件合计最多 50 MiB。');
      zip.file(relative, file.buffer);
    }
    const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    authorize(); this.access(userId, projectId, project.accessId);
    return this.storeFile({ userId, projectId, chatId, name: String(name || '项目资料.zip'), bytes, idempotencyKey });
  }
  select(ids, userId, { checkSource = false } = {}) {
    invariant(Array.isArray(ids) && ids.length <= 30 && new Set(ids).size === ids.length, 400, 'MATERIAL_LIMIT', '每批最多 30 个不重复附件。');
    const rows = ids.map(id => this.owned(this.row(id), userId));
    invariant(rows.reduce((n, r) => n + r.size, 0) <= MATERIAL_LIMIT, 413, 'MATERIAL_LIMIT', '每批资料合计最多 50 MiB。');
    if (checkSource) for (const row of rows) if (row.source_path) {
      const project = this.access(userId, row.project_id, row.access_id);
      invariant(this.workspace.fileMetadata(project, row.source_path).version === row.sha256,
        409, 'MATERIAL_SOURCE_CHANGED', '选定的源文件已改变，请重新选择后派发。');
    }
    return rows.map(row => this.public(row));
  }
  validatePlan(graph, ownerId) {
    const ids = [...new Set(graph.nodes.flatMap(n => n.inputAttachmentIds || []))];
    return this.select(ids, ownerId);
  }
  taskAccess(taskId, userId) {
    const task = this.db.getTask(taskId);
    invariant(task && this.db.getUserById(userId)?.status === 'active', 403, 'TASK_FORBIDDEN', '任务不可访问。');
    const project = this.access(userId, task.projectId);
    invariant(project.accessKind === 'owner' || (task.assigneeUserId === userId && task.assignedAccessId === project.accessId),
      403, 'TASK_FORBIDDEN', '任务不属于当前账号。');
    return { task, project };
  }
  current(taskId, revision = null) {
    const row = revision == null
      ? this.sql.prepare('SELECT * FROM task_input_revisions WHERE task_id=? ORDER BY revision DESC LIMIT 1').get(taskId)
      : this.sql.prepare('SELECT * FROM task_input_revisions WHERE task_id=? AND revision=?').get(taskId, revision);
    return { revision: row?.revision || 0, files: row ? JSON.parse(row.manifest_json) : [] };
  }
  freezeRun(run) {
    const plan = this.store.plan(run.planId);
    for (const task of this.store.tasks(run.id)) {
      const ids = plan.graph.nodes.find(n => n.key === task.nodeKey).inputAttachmentIds || [];
      if (this.current(task.id).revision) continue;
      const files = this.select(ids, run.ownerId);
      this.sql.prepare('INSERT INTO task_input_revisions(task_id,revision,task_version,manifest_json,created_at,idempotency_key) VALUES (?,1,?,?,?,?)')
        .run(task.id, task.version, JSON.stringify(files), now(), `initial-${run.id}`);
    }
  }
  append(taskId, userId, { attachmentIds, expectedRevision, taskVersion, idempotencyKey }) {
    operationKey(idempotencyKey);
    const { task } = this.taskAccess(taskId, userId); this.store.owner(task.projectId, userId);
    invariant(this.store.run(task.workflowRunId)?.status === 'running' && ['ready', 'active', 'rework'].includes(task.status)
      && task.version === taskVersion, 409, 'TASK_VERSION_CHANGED', '已提交或已结束的任务不能补充资料。');
    const old = this.sql.prepare('SELECT revision FROM task_input_revisions WHERE task_id=? AND idempotency_key=?').get(taskId, idempotencyKey);
    if (old) return this.current(taskId, old.revision);
    const current = this.current(taskId);
    invariant(current.revision === expectedRevision, 409, 'MATERIAL_REVISION_CHANGED', '任务资料已更新，请刷新。');
    const added = this.select(attachmentIds, userId, { checkSource: true });
    invariant(added.length && added.every(f => !current.files.some(oldFile => oldFile.id === f.id)), 400, 'MATERIAL_DUPLICATE', '请选择尚未加入任务的资料。');
    const files = [...current.files, ...added];
    invariant(files.length <= 30 && files.reduce((s, f) => s + f.size, 0) <= MATERIAL_LIMIT, 413, 'MATERIAL_LIMIT', '任务资料最多 30 份、50 MiB。');
    this.store.transaction(() => {
      this.sql.prepare('INSERT INTO task_input_revisions(task_id,revision,task_version,manifest_json,created_at,idempotency_key) VALUES (?,?,?,?,?,?)')
        .run(taskId, current.revision + 1, task.version, JSON.stringify(files), now(), idempotencyKey);
      this.notify(task, 'materials', current.revision + 1);
    });
    return this.current(taskId);
  }
  readTask(taskId, userId, id, revision = null) {
    this.taskAccess(taskId, userId);
    const input = this.current(taskId, revision);
    const file = input.files.find(f => f.id === id);
    invariant(file, 404, 'MATERIAL_NOT_FOUND', '资料不属于此任务版本。');
    const row = this.row(id);
    invariant(row && row.sha256 === file.sha256, 409, 'MATERIAL_CHANGED', '任务资料不一致。');
    return { ...file, revision: input.revision, bytes: this.bytes(row) };
  }
  async text(file) {
    const extracted = await artifactText({ path: file.name, bytes: file.bytes, size: file.size }, 64 * 1024);
    return { id: file.id, name: file.name, sha256: file.sha256, ...extracted };
  }
  importFiles(project, files) {
    const userId = project.accessUserId || project.userId;
    const user = this.db.getUserById(userId);
    let extra = 0;
    const pending = [];
    for (const file of files) {
      try {
        const existing = this.workspace.fileMetadata(project, file.path);
        invariant(existing.version === file.sha256, 409, 'MATERIAL_PATH_CONFLICT', '输入资料路径已有不同内容，未覆盖。');
      } catch (error) {
        if (error.code !== 'PATH_NOT_FOUND') throw error;
        extra += file.size; pending.push(file);
      }
    }
    if (pending.length) invariant(!this.codex.workspaceBusy(project.accessId), 409, 'WORKSPACE_BUSY', '等待工作区空闲后导入资料。');
    invariant(this.workspace.usageForUser(userId, this.db.listProjectsForUser(userId)).bytes + extra <= user.maxStorageBytes,
      413, 'STORAGE_QUOTA', '导入资料将超过存储配额。');
    for (const file of pending) this.workspace.writeFile(project, file.path, this.bytes(this.row(file.id)));
  }
  notify(task, kind, revision = 0) {
    this.sql.prepare(`INSERT OR IGNORE INTO task_notifications(id,user_id,task_id,task_version,kind,revision,created_at)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), task.assigneeUserId, task.id, task.version, kind, revision, now());
  }
  notifications(userId) {
    return this.sql.prepare('SELECT id,task_id AS taskId,task_version AS taskVersion,kind,revision,created_at AS createdAt,read_at AS readAt FROM task_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 200')
      .all(userId).filter(n => { try { this.taskAccess(n.taskId, userId); return true; } catch { return false; } });
  }
}
