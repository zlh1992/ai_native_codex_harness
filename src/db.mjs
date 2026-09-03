import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function json(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function now() {
  return new Date().toISOString();
}

export class HarnessDatabase {
  constructor(config) {
    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
    this.config = config;
    this.db = new DatabaseSync(config.databasePath);
    fs.chmodSync(config.databasePath, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
        network_access INTEGER NOT NULL DEFAULT 0,
        max_projects INTEGER NOT NULL,
        max_storage_bytes INTEGER NOT NULL,
        max_concurrent_turns INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(user_id, slug)
      );
      CREATE INDEX IF NOT EXISTS projects_user_id_idx ON projects(user_id);
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        codex_thread_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_user_id_idx ON chats(user_id);
      CREATE INDEX IF NOT EXISTS chats_project_id_idx ON chats(project_id);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','event','error')),
        kind TEXT NOT NULL DEFAULT 'message',
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_chat_id_idx ON messages(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        ip TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log(actor_user_id);
    `);
  }

  close() { this.db.close(); }

  countAdmins() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count);
  }

  createUser({ username, displayName, passwordHash, role = 'user', networkAccess, maxProjects, maxStorageBytes, maxConcurrentTurns }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO users
      (id, username, display_name, password_hash, role, status, network_access, max_projects, max_storage_bytes, max_concurrent_turns, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`).run(
      id, username, displayName, passwordHash, role, networkAccess ? 1 : 0,
      maxProjects, maxStorageBytes, maxConcurrentTurns, timestamp, timestamp,
    );
    return this.getUserById(id);
  }

  publicUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      networkAccess: Boolean(row.network_access),
      maxProjects: row.max_projects,
      maxStorageBytes: row.max_storage_bytes,
      maxConcurrentTurns: row.max_concurrent_turns,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
    };
  }

  getUserAuthByUsername(username) {
    return this.db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username) || null;
  }

  getUserById(id) {
    return this.publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  listUsers() {
    return this.db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id) AS project_count,
      (SELECT COUNT(*) FROM chats c WHERE c.user_id=u.id) AS chat_count
      FROM users u ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE`).all()
      .map((row) => ({ ...this.publicUser(row), projectCount: row.project_count, chatCount: row.chat_count }));
  }

  updateUser(id, patch) {
    const allowed = new Map([
      ['displayName', 'display_name'], ['status', 'status'], ['networkAccess', 'network_access'],
      ['maxProjects', 'max_projects'], ['maxStorageBytes', 'max_storage_bytes'],
      ['maxConcurrentTurns', 'max_concurrent_turns'], ['passwordHash', 'password_hash'],
    ]);
    const fields = [];
    const values = [];
    for (const [key, column] of allowed) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      values.push(key === 'networkAccess' ? (patch[key] ? 1 : 0) : patch[key]);
    }
    if (!fields.length) return this.getUserById(id);
    fields.push('updated_at = ?');
    values.push(now(), id);
    this.db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return this.getUserById(id);
  }

  markLogin(id) {
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  }

  createSession({ tokenHash, userId, csrfToken, expiresAt, ip, userAgent }) {
    this.db.prepare('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at,created_at,ip,user_agent) VALUES (?,?,?,?,?,?,?)')
      .run(tokenHash, userId, csrfToken, expiresAt, now(), ip, userAgent);
  }

  getSession(tokenHash) {
    const row = this.db.prepare(`SELECT s.*, u.username, u.display_name, u.role, u.status, u.network_access,
      u.max_projects, u.max_storage_bytes, u.max_concurrent_turns, u.created_at AS user_created_at,
      u.updated_at AS user_updated_at, u.last_login_at
      FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at > ?`).get(tokenHash, now());
    if (!row || row.status !== 'active') return null;
    return {
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      user: this.publicUser({
        id: row.user_id, username: row.username, display_name: row.display_name,
        role: row.role, status: row.status, network_access: row.network_access,
        max_projects: row.max_projects, max_storage_bytes: row.max_storage_bytes,
        max_concurrent_turns: row.max_concurrent_turns, created_at: row.user_created_at,
        updated_at: row.user_updated_at, last_login_at: row.last_login_at,
      }),
    };
  }

  deleteSession(tokenHash) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }
  deleteUserSessions(userId) { this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }
  cleanSessions() { this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()); }

  createProject({ userId, slug, name, description = '' }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO projects (id,user_id,slug,name,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, userId, slug, name, description, timestamp, timestamp);
    return this.getProject(id);
  }

  mapProject(row) {
    return row ? {
      id: row.id, userId: row.user_id, slug: row.slug, name: row.name,
      description: row.description, createdAt: row.created_at, updatedAt: row.updated_at,
      username: row.username, displayName: row.display_name,
    } : null;
  }

  getProject(id) {
    return this.mapProject(this.db.prepare(`SELECT p.*,u.username,u.display_name FROM projects p
      JOIN users u ON u.id=p.user_id WHERE p.id=?`).get(id));
  }

  listProjects(userId = null) {
    const sql = `SELECT p.*,u.username,u.display_name FROM projects p JOIN users u ON u.id=p.user_id
      ${userId ? 'WHERE p.user_id=?' : ''} ORDER BY p.updated_at DESC`;
    return this.db.prepare(sql).all(...(userId ? [userId] : [])).map((row) => this.mapProject(row));
  }

  updateProject(id, { name, description }) {
    this.db.prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?').run(name, description, now(), id);
    return this.getProject(id);
  }

  touchProject(id) { this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), id); }
  deleteProject(id) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  createChat({ projectId, userId, title }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO chats (id,project_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(id, projectId, userId, title, timestamp, timestamp);
    return this.getChat(id);
  }

  mapChat(row) {
    return row ? {
      id: row.id, projectId: row.project_id, userId: row.user_id, title: row.title,
      codexThreadId: row.codex_thread_id, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at,
      projectName: row.project_name, projectSlug: row.project_slug,
      username: row.username,
    } : null;
  }

  getChat(id) {
    return this.mapChat(this.db.prepare(`SELECT c.*,p.name AS project_name,p.slug AS project_slug,u.username
      FROM chats c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.user_id WHERE c.id=?`).get(id));
  }

  listChats({ projectId, userId } = {}) {
    const clauses = [];
    const params = [];
    if (projectId) { clauses.push('c.project_id=?'); params.push(projectId); }
    if (userId) { clauses.push('c.user_id=?'); params.push(userId); }
    return this.db.prepare(`SELECT c.*,p.name AS project_name,p.slug AS project_slug,u.username
      FROM chats c JOIN projects p ON p.id=c.project_id JOIN users u ON u.id=c.user_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY c.updated_at DESC`).all(...params)
      .map((row) => this.mapChat(row));
  }

  updateChat(id, patch) {
    const fields = [];
    const values = [];
    for (const [key, column] of [['title', 'title'], ['codexThreadId', 'codex_thread_id'], ['status', 'status']]) {
      if (key in patch) { fields.push(`${column}=?`); values.push(patch[key]); }
    }
    fields.push('updated_at=?'); values.push(now(), id);
    this.db.prepare(`UPDATE chats SET ${fields.join(',')} WHERE id=?`).run(...values);
    return this.getChat(id);
  }

  deleteChat(id) { this.db.prepare('DELETE FROM chats WHERE id=?').run(id); }

  addMessage({ chatId, turnId = null, role, kind = 'message', content, metadata = {} }) {
    const id = randomUUID();
    const createdAt = now();
    this.db.prepare('INSERT INTO messages (id,chat_id,turn_id,role,kind,content,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, chatId, turnId, role, kind, content, JSON.stringify(metadata), createdAt);
    this.updateChat(chatId, {});
    return { id, chatId, turnId, role, kind, content, metadata, createdAt };
  }

  listMessages(chatId, limit = 500) {
    return this.db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE chat_id=? ORDER BY created_at DESC LIMIT ?)
      ORDER BY created_at ASC`).all(chatId, limit).map((row) => ({
      id: row.id, chatId: row.chat_id, turnId: row.turn_id, role: row.role,
      kind: row.kind, content: row.content, metadata: json(row.metadata_json), createdAt: row.created_at,
    }));
  }

  audit({ actorUserId = null, action, targetType, targetId = null, ip = null, detail = {} }) {
    this.db.prepare('INSERT INTO audit_log (actor_user_id,action,target_type,target_id,ip,detail_json,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(actorUserId, action, targetType, targetId, ip, JSON.stringify(detail), now());
  }

  listAudit(limit = 200) {
    return this.db.prepare(`SELECT a.*,u.username AS actor_username FROM audit_log a LEFT JOIN users u ON u.id=a.actor_user_id
      ORDER BY a.id DESC LIMIT ?`).all(limit).map((row) => ({
      id: row.id, actorUserId: row.actor_user_id, actorUsername: row.actor_username || 'system',
      action: row.action, targetType: row.target_type, targetId: row.target_id,
      ip: row.ip, detail: json(row.detail_json), createdAt: row.created_at,
    }));
  }

  stats() {
    const count = (table, where = '') => Number(this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get().count);
    return {
      users: count('users'), activeUsers: count('users', "WHERE status='active'"),
      projects: count('projects'), chats: count('chats'), messages: count('messages'),
      runningChats: count('chats', "WHERE status='running'"),
    };
  }
}
