import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HttpError, invariant } from './errors.mjs';
import { MemoryIndexClient } from './memory-index-client.mjs';

const SECRET_CUE = /(?:password|passwd|密码|secret|token|bearer|credential|access[_ -]?key|api[_ -]?key|private[_ -]?key|BEGIN [A-Z ]*PRIVATE KEY|\bsk-[A-Za-z0-9_-]{12,}|\bgh[oprsu]_[A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{12,})/i;

function now() { return new Date().toISOString(); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function safeUserId(value) { return /^[A-Za-z0-9-]{1,80}$/.test(value); }

export class UserMemoryService {
  constructor({ config, db }) {
    this.config = config;
    this.db = db;
    this.index = new MemoryIndexClient(config);
    this.indexTimers = new Map();
    this.index.on('log', (entry) => this.onLog?.(entry));
  }

  start() {
    if (!this.config.memoryEnabled) return;
    this.index.start();
    const users = this.db.db.prepare("SELECT DISTINCT user_id FROM user_memories WHERE status='active'").all();
    for (const row of users) this.#queueIndex(row.user_id);
    this.db.db.prepare("UPDATE memory_extraction_jobs SET status='failed',error_code='REPLACED_BY_MEMORY_TOOLS',updated_at=? WHERE status IN ('queued','running')").run(now());
  }

  stop() {
    for (const timer of this.indexTimers.values()) clearTimeout(timer);
    this.indexTimers.clear();
    this.index.stop();
  }

  status() {
    return { enabled: this.config.memoryEnabled, nativeCodexMemory: false, index: this.index.status(),
      recallLimit: this.config.memoryRecallLimit };
  }

  #row(row) {
    if (!row) return null;
    const sources = this.db.db.prepare(`SELECT project_id,chat_id,turn_run_id,created_at
      FROM user_memory_sources WHERE memory_id=? ORDER BY created_at`).all(row.id).map((source) => ({
      projectId: source.project_id, chatId: source.chat_id, turnRunId: source.turn_run_id, createdAt: source.created_at,
    }));
    return { id: row.id, userId: row.user_id, body: row.body, version: row.version, status: row.status,
      sourceKind: row.source_kind, sourceChatId: row.source_chat_id, sourceTurnRunId: row.source_turn_run_id,
      createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at, sources };
  }

  get(id) { return this.#row(this.db.db.prepare('SELECT * FROM user_memories WHERE id=?').get(id)); }

  #accessible(memory, userId) {
    return memory?.userId === userId && memory.status === 'active'
      && memory.sources.every((source) => Boolean(this.db.getProjectForUser(source.projectId, userId)));
  }

  list(userId, { includeDeleted = false } = {}) {
    return this.db.db.prepare(`SELECT * FROM user_memories WHERE user_id=? ${includeDeleted ? '' : "AND status='active'"}
      ORDER BY updated_at DESC,id`).all(userId).map((row) => this.#row(row))
      .filter((memory) => memory.status === 'deleted' || this.#accessible(memory, userId));
  }

  create({ userId, body, sourceKind = 'manual', sourceProjectId = null, sourceChatId = null, sourceTurnRunId = null }) {
    const text = String(body || '').trim();
    invariant(this.config.memoryEnabled, 409, 'MEMORY_DISABLED', 'Portal 用户记忆已由运维关闭。');
    invariant(text.length > 0 && text.length <= 4000, 400, 'INVALID_MEMORY', '记忆长度必须为 1–4000 个字符。');
    invariant(!SECRET_CUE.test(text), 400, 'MEMORY_SECRET_REJECTED', '不能保存密码、token 或密钥。');
    invariant(['manual', 'turn'].includes(sourceKind), 400, 'INVALID_MEMORY_SOURCE', '记忆来源无效。');
    if (sourceKind === 'turn') {
      invariant(sourceProjectId && sourceChatId && sourceTurnRunId, 400, 'INVALID_MEMORY_SOURCE', '自动记忆必须绑定项目、对话和运行。');
      invariant(this.db.getProjectForUser(sourceProjectId, userId), 403, 'PROJECT_FORBIDDEN', '记忆来源项目已不可访问。');
    }
    const duplicate = this.db.db.prepare("SELECT * FROM user_memories WHERE user_id=? AND status='active' AND body=?").get(userId, text);
    if (duplicate) {
      invariant(this.#accessible(this.#row(duplicate), userId), 404, 'MEMORY_NOT_FOUND', '同内容旧记忆的来源已不可访问。');
      // Exact duplicates do not change the original record or its provenance.
      return this.get(duplicate.id);
    }
    const id = randomUUID(); const timestamp = now();
    this.db.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.db.prepare(`INSERT INTO user_memories
        (id,user_id,body,version,status,source_kind,source_chat_id,source_turn_run_id,created_at,updated_at)
        VALUES (?,?,?,1,'active',?,?,?,?,?)`).run(id, userId, text, sourceKind, sourceChatId, sourceTurnRunId, timestamp, timestamp);
      if (sourceProjectId) this.db.db.prepare(`INSERT INTO user_memory_sources
        (memory_id,project_id,chat_id,turn_run_id,created_at) VALUES (?,?,?,?,?)`)
        .run(id, sourceProjectId, sourceChatId, sourceTurnRunId, timestamp);
      this.db.db.exec('COMMIT');
    } catch (error) { this.db.db.exec('ROLLBACK'); throw error; }
    this.#queueIndex(userId);
    return this.get(id);
  }

  update({ id, userId, version, body, sourceProjectId = null, sourceChatId = null, sourceTurnRunId = null }) {
    const text = String(body || '').trim();
    invariant(text.length > 0 && text.length <= 4000, 400, 'INVALID_MEMORY', '记忆长度必须为 1–4000 个字符。');
    invariant(this.config.memoryEnabled, 409, 'MEMORY_DISABLED', 'Portal 记忆已关闭。');
    invariant(!SECRET_CUE.test(text), 400, 'MEMORY_SECRET_REJECTED', '不能保存密码、token 或密钥。');
    invariant(this.#accessible(this.get(id), userId), 404, 'MEMORY_NOT_FOUND', '记忆不存在或来源项目已不可访问。');
    if (sourceProjectId) invariant(sourceChatId && sourceTurnRunId && this.db.getProjectForUser(sourceProjectId, userId),
      403, 'PROJECT_FORBIDDEN', '记忆来源项目已不可访问。');
    this.db.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.db.prepare(`UPDATE user_memories SET body=?,version=version+1,updated_at=?
        WHERE id=? AND user_id=? AND status='active' AND version=?`).run(text, now(), id, userId, Number(version));
      invariant(result.changes === 1, 409, 'MEMORY_CHANGED', '记忆已变化、已删除或不属于你，请刷新后重试。');
      if (sourceProjectId) this.db.db.prepare(`INSERT OR IGNORE INTO user_memory_sources
        (memory_id,project_id,chat_id,turn_run_id,created_at) VALUES (?,?,?,?,?)`)
        .run(id, sourceProjectId, sourceChatId, sourceTurnRunId, now());
      this.db.db.exec('COMMIT');
    } catch (error) { this.db.db.exec('ROLLBACK'); throw error; }
    this.#queueIndex(userId);
    return this.get(id);
  }

  delete({ id, userId, version }) {
    invariant(this.config.memoryEnabled, 409, 'MEMORY_DISABLED', 'Portal 记忆已关闭。');
    invariant(this.#accessible(this.get(id), userId), 404, 'MEMORY_NOT_FOUND', '记忆不存在或来源项目已不可访问。');
    const timestamp = now();
    const result = this.db.db.prepare(`UPDATE user_memories SET status='deleted',body='',version=version+1,deleted_at=?,updated_at=?
      WHERE id=? AND user_id=? AND status='active' AND version=?`).run(timestamp, timestamp, id, userId, Number(version));
    invariant(result.changes === 1, 409, 'MEMORY_CHANGED', '记忆已变化、已删除或不属于你，请刷新后重试。');
    this.#queueIndex(userId);
    return { id, deleted: true };
  }

  settings(chat) { return { useMemory: chat.useMemory !== false, saveMemory: chat.saveMemory !== false }; }

  updateSettings(chat, patch) {
    const update = {};
    if ('useMemory' in patch) update.useMemory = Boolean(patch.useMemory);
    if ('saveMemory' in patch) update.saveMemory = Boolean(patch.saveMemory);
    invariant(Object.keys(update).length, 400, 'INVALID_MEMORY_SETTINGS', '没有可更新的记忆设置。');
    return this.db.updateChat(chat.id, update);
  }

  async recall({ userId, chat, projectId, turnRunId, query, authorize = () => {} }) {
    if (!this.config.memoryEnabled || chat.useMemory === false || ['planner', 'reviewer'].includes(chat.purpose)) return [];
    const active = this.list(userId);
    if (!active.length) return [];
    let orderedIds = [];
    try {
      const response = await this.index.search(userId, query, Math.min(50, this.config.memoryRecallLimit * 3));
      for (const result of response?.results || []) {
        const match = `${result.heading || ''}\n${result.content || ''}`.match(/memory:([A-Za-z0-9-]{1,80})/);
        if (match && !orderedIds.includes(match[1])) orderedIds.push(match[1]);
      }
    } catch (error) {
      this.index.state = 'degraded'; this.index.lastError = error;
    }
    authorize();
    const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9_]{2,}|[\u3400-\u9fff]/g) || [])].slice(0, 64);
    const score = (memory) => terms.reduce((sum, term) => sum + (memory.body.toLowerCase().includes(term) ? 1 : 0), 0);
    const byId = new Map(active.map((memory) => [memory.id, memory]));
    const semantic = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    const fallback = active.filter((memory) => !orderedIds.includes(memory.id)).sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt));
    const selected = [...semantic, ...fallback].filter((memory) => !String(query).trim() || orderedIds.includes(memory.id) || score(memory) > 0)
      .slice(0, this.config.memoryRecallLimit);
    let chars = 0;
    const boundedCandidates = selected.filter((memory) => {
      chars += memory.body.length;
      return chars <= 12_000;
    });
    const bounded = boundedCandidates.map((candidate) => ({ candidate, current: this.get(candidate.id) }))
      .filter(({ candidate, current }) => current?.version === candidate.version && this.#accessible(current, userId))
      .map(({ current }) => current);
    const insert = this.db.db.prepare(`INSERT OR IGNORE INTO turn_memory_refs
      (turn_run_id,memory_id,memory_version,source_project_id,referenced_at) VALUES (?,?,?,?,?)`);
    for (const memory of bounded) insert.run(turnRunId, memory.id, memory.version,
      memory.sources[0]?.projectId || null, now());
    return bounded.map((memory) => ({ ...memory, crossProject: memory.sources.some((source) => source.projectId !== projectId) }));
  }

  refsForTurn(turnRunId, userId) {
    return this.db.db.prepare(`SELECT r.turn_run_id,r.memory_id,r.memory_version,r.source_project_id,r.referenced_at
      FROM turn_memory_refs r JOIN user_memories m ON m.id=r.memory_id WHERE r.turn_run_id=? AND m.user_id=? ORDER BY r.referenced_at,r.memory_id`)
      .all(turnRunId, userId).map((row) => {
        const memory = this.get(row.memory_id);
        const available = this.#accessible(memory, userId);
        return { turnRunId: row.turn_run_id, memoryId: row.memory_id,
          memoryVersion: row.memory_version, sourceProjectId: row.source_project_id, referencedAt: row.referenced_at,
          body: available && memory.version === row.memory_version ? memory.body : '', available };
      });
  }

  refsForChat(chat, userId) {
    return this.db.db.prepare(`SELECT DISTINCT r.turn_run_id,r.memory_id,r.memory_version,r.source_project_id,r.referenced_at
      FROM turn_memory_refs r JOIN turn_runs t ON t.id=r.turn_run_id WHERE t.chat_id=? ORDER BY r.referenced_at DESC`)
      .all(chat.id).filter((row) => !chat.memoryContextResetAt || row.referenced_at > chat.memoryContextResetAt).map((row) => {
        const memory = this.get(row.memory_id);
        const available = this.#accessible(memory, userId);
        return { turnRunId: row.turn_run_id, memoryId: row.memory_id, memoryVersion: row.memory_version,
          currentMemoryVersion: memory?.version || null,
          sourceProjectId: row.source_project_id, referencedAt: row.referenced_at,
          body: available && memory.version === row.memory_version ? memory.body : '', available,
          crossProject: Boolean(row.source_project_id && row.source_project_id !== chat.projectId)
            || Boolean(memory?.sources.some((source) => source.projectId !== chat.projectId)) };
      });
  }

  dependentChatIds(memoryId, userId) {
    return this.db.db.prepare(`SELECT DISTINCT t.chat_id FROM turn_memory_refs r
      JOIN turn_runs t ON t.id=r.turn_run_id JOIN chats c ON c.id=t.chat_id JOIN user_memories m ON m.id=r.memory_id
      WHERE r.memory_id=? AND m.user_id=?
      AND (c.memory_context_reset_at IS NULL OR r.referenced_at>c.memory_context_reset_at)`)
      .all(memoryId, userId).map((row) => row.chat_id);
  }

  assertContextFresh(chat, userId) {
    invariant(this.refsForChat(chat, userId).every((ref) => ref.available && ref.memoryVersion === ref.currentMemoryVersion),
      409, 'MEMORY_CONTEXT_INVALIDATED', '引用的记忆已变化或不可访问，必须明确重置上下文，不能重试旧线程。');
  }

  memoryIdsForSourceProject(projectId, userId) {
    return this.db.db.prepare(`SELECT DISTINCT m.id FROM user_memories m JOIN user_memory_sources s ON s.memory_id=m.id
      WHERE m.user_id=? AND m.status='active' AND s.project_id=?`).all(userId, projectId).map((row) => row.id);
  }

  refreshIndex(userId) { this.#queueIndex(userId); }

  invalidateThreads(memoryIds, reason = '引用的 Portal 记忆或来源权限已变化；继续前必须明确重置原生线程。') {
    const ids = [...new Set(memoryIds)];
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const chats = this.db.db.prepare(`SELECT DISTINCT c.id FROM chats c JOIN turn_runs t ON t.chat_id=c.id
      JOIN turn_memory_refs r ON r.turn_run_id=t.id WHERE r.memory_id IN (${placeholders})
      AND (c.memory_context_reset_at IS NULL OR r.referenced_at>c.memory_context_reset_at)`)
      .all(...ids).map((row) => row.id);
    for (const chatId of chats) {
      const chat = this.db.getChat(chatId);
      if (chat?.codexThreadId) this.db.markChatThreadError(chatId, reason);
      this.db.pauseChatInputs(chatId, 'MEMORY_CONTEXT_INVALIDATED');
    }
    return chats;
  }

  #queueIndex(userId) {
    if (!safeUserId(userId) || this.indexTimers.has(userId)) return;
    const timer = setTimeout(() => {
      this.indexTimers.delete(userId);
      try { this.#writeDocument(userId); } catch (error) { this.index.state = 'degraded'; this.index.lastError = error; return; }
      this.index.index(userId).catch((error) => { this.index.state = 'degraded'; this.index.lastError = error; });
    }, 50);
    timer.unref?.(); this.indexTimers.set(userId, timer);
  }

  #writeDocument(userId) {
    const root = path.join(this.config.memoryIndexRoot, 'users', userId, 'documents');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, 'memories.md'); const temporary = path.join(root, `.memories-${process.pid}.tmp`);
    const body = this.list(userId).map((memory) => `## memory:${memory.id}\n\n${memory.body}\n`).join('\n');
    fs.writeFileSync(temporary, body, { mode: 0o600 }); fs.renameSync(temporary, target); fs.chmodSync(target, 0o600);
  }

  #shareSnapshot(projectId, ownerUserId, recipientUserId) {
    const chats = this.db.listChats({ projectId, userId: ownerUserId }).filter((chat) => !['planner', 'reviewer'].includes(chat.purpose));
    const refs = [];
    for (const chat of chats) {
      for (const ref of this.refsForChat(chat, ownerUserId)) {
        if (ref.crossProject && !ref.available) throw new HttpError(409, 'MEMORY_SHARE_CONTEXT_INVALID',
          '待分享对话曾引用现已删除或无权访问的跨项目记忆；请先确认重置该对话，再分享历史。');
        if (ref.available && ref.crossProject) refs.push({ chatId: chat.id, chatUpdatedAt: chat.updatedAt,
          memoryId: ref.memoryId, memoryVersion: ref.memoryVersion, currentMemoryVersion: ref.currentMemoryVersion,
          sourceProjectId: ref.sourceProjectId });
      }
    }
    refs.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { refs, hash: digest(JSON.stringify({ projectId, ownerUserId, recipientUserId, refs })) };
  }

  authorizeHistoryShare({ projectId, ownerUserId, recipientUserId, confirmationToken }) {
    const snapshot = this.#shareSnapshot(projectId, ownerUserId, recipientUserId);
    if (!snapshot.refs.length) return { required: false, memoryCount: 0 };
    if (!confirmationToken) {
      const id = randomUUID(); const createdAt = now(); const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
      this.db.db.prepare(`INSERT INTO memory_share_confirmations
        (id,owner_user_id,project_id,recipient_user_id,snapshot_hash,memory_count,expires_at,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, ownerUserId, projectId, recipientUserId, snapshot.hash, snapshot.refs.length, expiresAt, createdAt);
      throw new HttpError(409, 'MEMORY_SHARE_CONFIRMATION_REQUIRED',
        `待分享对话已有 ${snapshot.refs.length} 条跨项目私有记忆引用；请确认接收者和当前对话快照后重试。`,
        { confirmationToken: id, memoryCount: snapshot.refs.length, expiresAt });
    }
    const confirmation = this.db.db.prepare('SELECT * FROM memory_share_confirmations WHERE id=?').get(confirmationToken);
    invariant(confirmation && confirmation.owner_user_id === ownerUserId && confirmation.project_id === projectId
      && confirmation.recipient_user_id === recipientUserId && !confirmation.used_at
      && confirmation.expires_at > now() && confirmation.snapshot_hash === snapshot.hash,
    409, 'MEMORY_SHARE_CONFIRMATION_STALE', '分享确认已过期，或接收者、对话、记忆及权限状态已变化，请重新确认。');
    return { required: true, memoryCount: snapshot.refs.length, confirmationToken, snapshotHash: snapshot.hash };
  }

  consumeHistoryShare({ projectId, ownerUserId, recipientUserId, confirmationToken, snapshotHash }) {
    const current = this.#shareSnapshot(projectId, ownerUserId, recipientUserId);
    const confirmation = this.db.db.prepare('SELECT * FROM memory_share_confirmations WHERE id=?').get(confirmationToken);
    invariant(confirmation && confirmation.owner_user_id === ownerUserId && confirmation.project_id === projectId
      && confirmation.recipient_user_id === recipientUserId && !confirmation.used_at
      && confirmation.expires_at > now() && confirmation.snapshot_hash === snapshotHash && current.hash === snapshotHash,
    409, 'MEMORY_SHARE_CONFIRMATION_STALE', '分享确认已过期，或接收者、对话、记忆及权限状态已变化，请重新确认。');
    const used = this.db.db.prepare('UPDATE memory_share_confirmations SET used_at=? WHERE id=? AND used_at IS NULL')
      .run(now(), confirmationToken);
    invariant(used.changes === 1, 409, 'MEMORY_SHARE_CONFIRMATION_STALE', '分享确认已使用，请重新确认。');
    return { required: true, memoryCount: current.refs.length };
  }
}
