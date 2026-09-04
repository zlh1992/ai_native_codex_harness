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
      CREATE TABLE IF NOT EXISTS project_access (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        access_kind TEXT NOT NULL CHECK(access_kind IN ('owner','shared')),
        tree_path TEXT NOT NULL,
        branch_name TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS project_access_project_idx ON project_access(project_id, status);
      CREATE INDEX IF NOT EXISTS project_access_user_idx ON project_access(user_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS project_access_active_user_idx
        ON project_access(project_id,user_id) WHERE status='active';
      CREATE UNIQUE INDEX IF NOT EXISTS project_access_one_share_idx
        ON project_access(project_id) WHERE access_kind='shared' AND status='active';
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
      CREATE TABLE IF NOT EXISTS roadmaps (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','active','submitted','passed','rework')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS roadmaps_project_idx ON roadmaps(project_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        roadmap_id TEXT REFERENCES roadmaps(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        assignee_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN ('draft','ready','active','submitted','passed','rework')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(roadmap_id, position)
      );
      CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_user_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_project_idx ON tasks(project_id, position);
      CREATE TABLE IF NOT EXISTS turn_runs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        task_version INTEGER,
        mode TEXT NOT NULL CHECK(mode IN ('edit','execute')),
        status TEXT NOT NULL CHECK(status IN ('queued','starting','running','completed','failed','cancelled','interrupted')),
        queue_position INTEGER,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        final_item_id TEXT,
        final_reply_snapshot TEXT,
        diff_snapshot TEXT NOT NULL DEFAULT '',
        plan_json TEXT NOT NULL DEFAULT '[]',
        subagent_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS turn_runs_chat_idx ON turn_runs(chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS turn_runs_task_idx ON turn_runs(task_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS turn_runs_codex_turn_idx ON turn_runs(codex_turn_id) WHERE codex_turn_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS execution_leases (
        turn_run_id TEXT PRIMARY KEY REFERENCES turn_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS execution_leases_expires_idx ON execution_leases(expires_at);
      CREATE TABLE IF NOT EXISTS turn_approvals (
        id TEXT PRIMARY KEY,
        turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('command','file')),
        item_id TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS turn_approvals_chat_idx ON turn_approvals(chat_id, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS task_submissions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        task_version INTEGER NOT NULL,
        submitter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE RESTRICT,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        final_item_id TEXT NOT NULL,
        final_reply_snapshot TEXT NOT NULL,
        diff_snapshot TEXT NOT NULL DEFAULT '',
        employee_note TEXT NOT NULL DEFAULT '',
        verdict TEXT NOT NULL DEFAULT 'pending' CHECK(verdict IN ('pending','passed','rework')),
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE(task_id, task_version)
      );
      CREATE INDEX IF NOT EXISTS task_submissions_task_idx ON task_submissions(task_id, created_at DESC);
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
    this.#ensureColumn('projects', 'repo_kind', "TEXT NOT NULL DEFAULT 'directory'");
    this.#ensureColumn('chats', 'project_access_id', 'TEXT');
    this.#ensureColumn('chats', 'tree_path', 'TEXT');
    this.#ensureColumn('chats', 'task_id', 'TEXT REFERENCES tasks(id)');
    this.#ensureColumn('chats', 'task_version', 'INTEGER');
    this.#backfillOwnerAccess();
  }

  #ensureColumn(table, name, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  #backfillOwnerAccess() {
    const insert = this.db.prepare(`INSERT INTO project_access
      (id,project_id,user_id,access_kind,tree_path,status,created_at)
      VALUES (?,?,?,?,?,'active',?)`);
    const missing = this.db.prepare(`SELECT p.* FROM projects p WHERE NOT EXISTS (
      SELECT 1 FROM project_access a WHERE a.project_id=p.id AND a.user_id=p.user_id AND a.access_kind='owner' AND a.status='active'
    )`).all();
    for (const project of missing) {
      insert.run(randomUUID(), project.id, project.user_id, 'owner', path.join(this.config.workspacesRoot, project.user_id, project.slug), now());
    }
    this.db.exec(`UPDATE chats SET
      project_access_id=COALESCE(project_access_id, (SELECT a.id FROM project_access a
        WHERE a.project_id=chats.project_id AND a.user_id=chats.user_id AND a.status='active' LIMIT 1)),
      tree_path=COALESCE(tree_path, (SELECT a.tree_path FROM project_access a
        WHERE a.project_id=chats.project_id AND a.user_id=chats.user_id AND a.status='active' LIMIT 1))
      WHERE project_access_id IS NULL OR tree_path IS NULL`);
  }

  close() { this.db.close(); }

  countAdmins() {
    return Number(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'").get().count);
  }

  createUser({ username, displayName, passwordHash, role = 'user', networkAccess, maxProjects, maxStorageBytes, maxConcurrentTurns }) {
    if (role === 'admin' && this.countAdmins() > 0) throw new Error('系统只允许一个超级管理员账号。');
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
      (SELECT COUNT(*) FROM project_access a WHERE a.user_id=u.id AND a.access_kind='shared' AND a.status='active') AS shared_project_count,
      (SELECT COUNT(*) FROM chats c WHERE c.user_id=u.id) AS chat_count
      FROM users u ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, username COLLATE NOCASE`).all()
      .map((row) => ({
        ...this.publicUser(row), projectCount: row.project_count,
        sharedProjectCount: row.shared_project_count, chatCount: row.chat_count,
      }));
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
    const project = this.getProject(id);
    try {
      this.createOwnerAccess(project);
    } catch (error) {
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      throw error;
    }
    return this.getProjectForUser(id, userId);
  }

  mapProject(row) {
    return row ? {
      id: row.id, userId: row.user_id, slug: row.slug, name: row.name,
      description: row.description, createdAt: row.created_at, updatedAt: row.updated_at,
      username: row.username, displayName: row.display_name,
      repoKind: row.repo_kind || 'directory', accessId: row.access_id,
      accessUserId: row.access_user_id, accessKind: row.access_kind,
      treePath: row.tree_path, branchName: row.branch_name,
      sharedUserId: row.shared_user_id, sharedUsername: row.shared_username,
      sharedDisplayName: row.shared_display_name, sharedAccessId: row.shared_access_id,
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

  createOwnerAccess(project) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO project_access
      (id,project_id,user_id,access_kind,tree_path,status,created_at) VALUES (?,?,?,?,?,'active',?)`)
      .run(id, project.id, project.userId, 'owner', path.join(this.config.workspacesRoot, project.userId, project.slug), now());
    return this.getProjectAccessById(id);
  }

  getProjectForUser(projectId, userId) {
    return this.mapProject(this.db.prepare(`SELECT p.*,owner.username,owner.display_name,
      a.id AS access_id,a.user_id AS access_user_id,a.access_kind,a.tree_path,a.branch_name
      FROM projects p JOIN users owner ON owner.id=p.user_id
      JOIN project_access a ON a.project_id=p.id AND a.user_id=? AND a.status='active'
      WHERE p.id=?`).get(userId, projectId));
  }

  listProjectsForUser(userId) {
    return this.db.prepare(`SELECT p.*,owner.username,owner.display_name,
      a.id AS access_id,a.user_id AS access_user_id,a.access_kind,a.tree_path,a.branch_name
      FROM project_access a JOIN projects p ON p.id=a.project_id JOIN users owner ON owner.id=p.user_id
      WHERE a.user_id=? AND a.status='active' ORDER BY p.updated_at DESC`).all(userId).map((row) => this.mapProject(row));
  }

  listAdminProjects() {
    return this.db.prepare(`SELECT p.*,owner.username,owner.display_name,
      shared.id AS shared_access_id,shared.user_id AS shared_user_id,
      shared_user.username AS shared_username,shared_user.display_name AS shared_display_name
      FROM projects p JOIN users owner ON owner.id=p.user_id
      LEFT JOIN project_access shared ON shared.project_id=p.id AND shared.access_kind='shared' AND shared.status='active'
      LEFT JOIN users shared_user ON shared_user.id=shared.user_id
      ORDER BY p.updated_at DESC`).all().map((row) => this.mapProject(row));
  }

  getProjectAccessById(id) {
    const row = this.db.prepare(`SELECT a.*,u.username,u.display_name FROM project_access a
      JOIN users u ON u.id=a.user_id WHERE a.id=?`).get(id);
    return row ? {
      id: row.id, projectId: row.project_id, userId: row.user_id,
      accessKind: row.access_kind, treePath: row.tree_path, branchName: row.branch_name,
      status: row.status, username: row.username, displayName: row.display_name,
      createdAt: row.created_at, revokedAt: row.revoked_at,
    } : null;
  }

  listProjectAccess(projectId, { activeOnly = false } = {}) {
    return this.db.prepare(`SELECT a.*,u.username,u.display_name FROM project_access a JOIN users u ON u.id=a.user_id
      WHERE a.project_id=? ${activeOnly ? "AND a.status='active'" : ''}
      ORDER BY CASE a.access_kind WHEN 'owner' THEN 0 ELSE 1 END,a.created_at DESC`).all(projectId)
      .map((row) => ({
        id: row.id, projectId: row.project_id, userId: row.user_id,
        accessKind: row.access_kind, treePath: row.tree_path, branchName: row.branch_name,
        status: row.status, username: row.username, displayName: row.display_name,
        createdAt: row.created_at, revokedAt: row.revoked_at,
      }));
  }

  grantProjectAccess({ id = randomUUID(), projectId, userId, treePath, branchName }) {
    this.db.prepare(`INSERT INTO project_access
      (id,project_id,user_id,access_kind,tree_path,branch_name,status,created_at)
      VALUES (?,?,?,'shared',?,?,'active',?)`).run(id, projectId, userId, treePath, branchName, now());
    return this.getProjectAccessById(id);
  }

  revokeProjectAccess(id) {
    this.db.prepare("UPDATE project_access SET status='revoked',revoked_at=? WHERE id=? AND access_kind='shared' AND status='active'")
      .run(now(), id);
    return this.getProjectAccessById(id);
  }

  setProjectRepoKind(id, repoKind) {
    this.db.prepare('UPDATE projects SET repo_kind=?,updated_at=? WHERE id=?').run(repoKind, now(), id);
    return this.getProject(id);
  }

  updateProject(id, { name, description }) {
    this.db.prepare('UPDATE projects SET name=?,description=?,updated_at=? WHERE id=?').run(name, description, now(), id);
    return this.getProject(id);
  }

  touchProject(id) { this.db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(now(), id); }
  deleteProject(id) { this.db.prepare('DELETE FROM projects WHERE id=?').run(id); }

  createChat({ projectId, userId, projectAccessId, treePath, title, taskId = null, taskVersion = null }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO chats (id,project_id,user_id,project_access_id,tree_path,title,task_id,task_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, userId, projectAccessId, treePath, title, taskId, taskVersion, timestamp, timestamp);
    return this.getChat(id);
  }

  mapChat(row) {
    return row ? {
      id: row.id, projectId: row.project_id, userId: row.user_id, title: row.title,
      codexThreadId: row.codex_thread_id, status: row.status,
      projectAccessId: row.project_access_id, treePath: row.tree_path,
      taskId: row.task_id, taskVersion: row.task_version,
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
    for (const [key, column] of [['title', 'title'], ['codexThreadId', 'codex_thread_id'], ['status', 'status'], ['taskId', 'task_id'], ['taskVersion', 'task_version']]) {
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

  recoverInterruptedRuntime() {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare("UPDATE turn_runs SET status='interrupted',error_message='Portal restarted',completed_at=? WHERE status IN ('queued','starting','running')")
        .run(timestamp);
      this.db.prepare("UPDATE turn_approvals SET status='cancelled',resolved_at=? WHERE status='pending'").run(timestamp);
      this.db.exec('DELETE FROM execution_leases');
      this.db.prepare("UPDATE chats SET status='idle' WHERE status='running'").run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createRoadmap({ projectId, title, steps, status = 'ready' }) {
    const roadmapId = randomUUID();
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO roadmaps (id,project_id,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(roadmapId, projectId, title, status, timestamp, timestamp);
      const insertTask = this.db.prepare(`INSERT INTO tasks
        (id,roadmap_id,project_id,assignee_user_id,position,title,acceptance,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      steps.forEach((step, index) => insertTask.run(
        randomUUID(), roadmapId, projectId, step.assigneeUserId, index,
        step.title, step.acceptance, status === 'active' && index === 0 ? 'active' : status === 'draft' ? 'draft' : 'ready',
        timestamp, timestamp,
      ));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRoadmap(roadmapId);
  }

  mapRoadmap(row) {
    return row ? {
      id: row.id, projectId: row.project_id, title: row.title, status: row.status,
      version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      steps: row.steps || [],
    } : null;
  }

  getRoadmap(id) {
    const row = this.db.prepare('SELECT * FROM roadmaps WHERE id=?').get(id);
    if (!row) return null;
    return this.mapRoadmap({ ...row, steps: this.listTasks({ roadmapId: id }) });
  }

  listRoadmaps(projectId = null) {
    return this.db.prepare(`SELECT * FROM roadmaps ${projectId ? 'WHERE project_id=?' : ''} ORDER BY updated_at DESC`)
      .all(...(projectId ? [projectId] : [])).map((row) => this.mapRoadmap({ ...row, steps: this.listTasks({ roadmapId: row.id }) }));
  }

  mapTask(row) {
    return row ? {
      id: row.id, roadmapId: row.roadmap_id, projectId: row.project_id,
      assigneeUserId: row.assignee_user_id, position: row.position, title: row.title,
      acceptance: row.acceptance, status: row.status, version: row.version,
      createdAt: row.created_at, updatedAt: row.updated_at,
      projectName: row.project_name, projectSlug: row.project_slug,
      assigneeUsername: row.assignee_username, assigneeDisplayName: row.assignee_display_name,
      roadmapTitle: row.roadmap_title,
    } : null;
  }

  listTasks({ userId = null, projectId = null, roadmapId = null } = {}) {
    const clauses = [];
    const params = [];
    if (userId) { clauses.push('t.assignee_user_id=?'); params.push(userId); }
    if (projectId) { clauses.push('t.project_id=?'); params.push(projectId); }
    if (roadmapId) { clauses.push('t.roadmap_id=?'); params.push(roadmapId); }
    const orderBy = roadmapId ? 't.position' : `CASE t.status WHEN 'active' THEN 0 WHEN 'rework' THEN 1
      WHEN 'submitted' THEN 2 WHEN 'ready' THEN 3 WHEN 'draft' THEN 4 ELSE 5 END,t.updated_at DESC,t.position`;
    return this.db.prepare(`SELECT t.*,p.name AS project_name,p.slug AS project_slug,
      u.username AS assignee_username,u.display_name AS assignee_display_name,r.title AS roadmap_title
      FROM tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.assignee_user_id
      LEFT JOIN roadmaps r ON r.id=t.roadmap_id
      ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY ${orderBy}`).all(...params).map((row) => this.mapTask(row));
  }

  getTask(id) {
    return this.listTasks().find((task) => task.id === id) || null;
  }

  getTaskForUser(id, userId) {
    const row = this.db.prepare(`SELECT t.*,p.name AS project_name,p.slug AS project_slug,
      u.username AS assignee_username,u.display_name AS assignee_display_name,r.title AS roadmap_title
      FROM tasks t JOIN projects p ON p.id=t.project_id JOIN users u ON u.id=t.assignee_user_id
      LEFT JOIN roadmaps r ON r.id=t.roadmap_id
      JOIN project_access a ON a.project_id=t.project_id AND a.user_id=? AND a.status='active'
      WHERE t.id=? AND t.assignee_user_id=?`).get(userId, id, userId);
    return this.mapTask(row);
  }

  activateRoadmap(id) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const roadmap = this.db.prepare('SELECT * FROM roadmaps WHERE id=?').get(id);
      if (!roadmap || !['draft', 'ready'].includes(roadmap.status)) throw new Error('路线图状态不允许激活。');
      const inaccessible = this.db.prepare(`SELECT t.id FROM tasks t
        WHERE t.roadmap_id=? AND NOT EXISTS (
          SELECT 1 FROM project_access a WHERE a.project_id=t.project_id
            AND a.user_id=t.assignee_user_id AND a.status='active'
        ) LIMIT 1`).get(id);
      if (inaccessible) throw new Error('任务员工的项目授权已失效，不能激活路线图。');
      this.db.prepare("UPDATE roadmaps SET status='active',updated_at=? WHERE id=?").run(timestamp, id);
      this.db.prepare("UPDATE tasks SET status='ready',updated_at=? WHERE roadmap_id=? AND status='draft'").run(timestamp, id);
      const first = this.db.prepare("SELECT id FROM tasks WHERE roadmap_id=? AND status='ready' ORDER BY position LIMIT 1").get(id);
      if (first) this.db.prepare("UPDATE tasks SET status='active',updated_at=? WHERE id=?").run(timestamp, first.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRoadmap(id);
  }

  createTurnRun({ chat, project, userId, mode }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO turn_runs
      (id,chat_id,project_id,user_id,task_id,task_version,mode,status,created_at)
      VALUES (?,?,?,?,?,?,?,'queued',?)`).run(
      id, chat.id, project.id, userId, chat.taskId || null, chat.taskVersion || null, mode, timestamp,
    );
    return this.getTurnRun(id);
  }

  mapTurnRun(row) {
    return row ? {
      id: row.id, chatId: row.chat_id, projectId: row.project_id, userId: row.user_id,
      taskId: row.task_id, taskVersion: row.task_version, mode: row.mode, status: row.status,
      queuePosition: row.queue_position, codexThreadId: row.codex_thread_id, codexTurnId: row.codex_turn_id,
      finalItemId: row.final_item_id, finalReplySnapshot: row.final_reply_snapshot,
      diffSnapshot: row.diff_snapshot || '', plan: json(row.plan_json, []), subagentCount: row.subagent_count,
      errorMessage: row.error_message, createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at,
    } : null;
  }

  getTurnRun(id) { return this.mapTurnRun(this.db.prepare('SELECT * FROM turn_runs WHERE id=?').get(id)); }

  getTurnRunByCodexTurn(codexTurnId) {
    return this.mapTurnRun(this.db.prepare('SELECT * FROM turn_runs WHERE codex_turn_id=?').get(codexTurnId));
  }

  listTurnRunsForChat(chatId, limit = 100) {
    return this.db.prepare('SELECT * FROM turn_runs WHERE chat_id=? ORDER BY created_at DESC LIMIT ?').all(chatId, limit)
      .map((row) => this.mapTurnRun(row));
  }

  updateTurnRun(id, patch) {
    const allowed = new Map([
      ['status', 'status'], ['queuePosition', 'queue_position'], ['codexThreadId', 'codex_thread_id'],
      ['codexTurnId', 'codex_turn_id'], ['finalItemId', 'final_item_id'], ['finalReplySnapshot', 'final_reply_snapshot'],
      ['diffSnapshot', 'diff_snapshot'], ['plan', 'plan_json'], ['subagentCount', 'subagent_count'],
      ['errorMessage', 'error_message'], ['startedAt', 'started_at'], ['completedAt', 'completed_at'],
    ]);
    const fields = [];
    const values = [];
    for (const [key, column] of allowed) {
      if (!(key in patch)) continue;
      fields.push(`${column}=?`);
      values.push(key === 'plan' ? JSON.stringify(patch[key] || []) : patch[key]);
    }
    if (!fields.length) return this.getTurnRun(id);
    values.push(id);
    this.db.prepare(`UPDATE turn_runs SET ${fields.join(',')} WHERE id=?`).run(...values);
    return this.getTurnRun(id);
  }

  createExecutionLease({ turnRunId, userId, chatId, expiresAt }) {
    const timestamp = now();
    this.db.prepare('INSERT INTO execution_leases (turn_run_id,user_id,chat_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(turnRunId, userId, chatId, expiresAt, timestamp, timestamp);
  }

  renewExecutionLease(turnRunId, expiresAt) {
    this.db.prepare('UPDATE execution_leases SET expires_at=?,updated_at=? WHERE turn_run_id=?').run(expiresAt, now(), turnRunId);
  }

  deleteExecutionLease(turnRunId) { this.db.prepare('DELETE FROM execution_leases WHERE turn_run_id=?').run(turnRunId); }
  countExecutionLeases() { return Number(this.db.prepare('SELECT COUNT(*) AS count FROM execution_leases WHERE expires_at>?').get(now()).count); }

  createApproval({ id, turnRunId, chatId, userId, kind, itemId = null, request = {} }) {
    this.db.prepare(`INSERT INTO turn_approvals
      (id,turn_run_id,chat_id,user_id,kind,item_id,request_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,'pending',?)`).run(id, turnRunId, chatId, userId, kind, itemId, JSON.stringify(request), now());
    return this.getApproval(id);
  }

  mapApproval(row) {
    return row ? {
      id: row.id, turnRunId: row.turn_run_id, chatId: row.chat_id, userId: row.user_id,
      kind: row.kind, itemId: row.item_id, request: json(row.request_json), status: row.status,
      createdAt: row.created_at, resolvedAt: row.resolved_at,
    } : null;
  }

  getApproval(id) { return this.mapApproval(this.db.prepare('SELECT * FROM turn_approvals WHERE id=?').get(id)); }

  listPendingApprovals(chatId, userId) {
    return this.db.prepare("SELECT * FROM turn_approvals WHERE chat_id=? AND user_id=? AND status='pending' ORDER BY created_at")
      .all(chatId, userId).map((row) => this.mapApproval(row));
  }

  resolveApproval(id, status) {
    this.db.prepare("UPDATE turn_approvals SET status=?,resolved_at=? WHERE id=? AND status='pending'").run(status, now(), id);
    return this.getApproval(id);
  }

  submitTask({ taskId, taskVersion, submitterUserId, chatId, turnRunId, itemId, note = '' }) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!task || task.assignee_user_id !== submitterUserId) throw new Error('任务不存在或不属于当前员工。');
      if (!['active', 'rework'].includes(task.status) || task.version !== taskVersion) throw new Error('任务版本已变化，请刷新后重新提交。');
      const run = this.db.prepare(`SELECT * FROM turn_runs WHERE id=? AND chat_id=? AND user_id=? AND task_id=?
        AND task_version=? AND status='completed' AND final_item_id=?`).get(
        turnRunId, chatId, submitterUserId, taskId, taskVersion, itemId,
      );
      if (!run || !run.final_reply_snapshot || !run.codex_thread_id || !run.codex_turn_id) throw new Error('只能提交该任务对话中已完成的最终 Codex 回复。');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO task_submissions
        (id,task_id,task_version,submitter_user_id,chat_id,turn_run_id,codex_thread_id,codex_turn_id,final_item_id,
         final_reply_snapshot,diff_snapshot,employee_note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, taskId, taskVersion, submitterUserId, chatId, turnRunId, run.codex_thread_id, run.codex_turn_id,
        run.final_item_id, run.final_reply_snapshot, run.diff_snapshot || '', note, timestamp,
      );
      const changed = this.db.prepare("UPDATE tasks SET status='submitted',updated_at=? WHERE id=? AND version=? AND status IN ('active','rework')")
        .run(timestamp, taskId, taskVersion);
      if (Number(changed.changes) !== 1) throw new Error('任务状态已变化，请刷新后重新提交。');
      if (task.roadmap_id) this.db.prepare("UPDATE roadmaps SET status='submitted',updated_at=? WHERE id=?").run(timestamp, task.roadmap_id);
      this.db.exec('COMMIT');
      return this.getSubmission(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  mapSubmission(row) {
    return row ? {
      id: row.id, taskId: row.task_id, taskVersion: row.task_version, submitterUserId: row.submitter_user_id,
      chatId: row.chat_id, turnRunId: row.turn_run_id, codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id, finalItemId: row.final_item_id, finalReplySnapshot: row.final_reply_snapshot,
      diffSnapshot: row.diff_snapshot, employeeNote: row.employee_note, verdict: row.verdict,
      createdAt: row.created_at, reviewedAt: row.reviewed_at,
    } : null;
  }

  getSubmission(id) { return this.mapSubmission(this.db.prepare('SELECT * FROM task_submissions WHERE id=?').get(id)); }

  listSubmissionsForTask(taskId) {
    return this.db.prepare('SELECT * FROM task_submissions WHERE task_id=? ORDER BY created_at DESC').all(taskId)
      .map((row) => this.mapSubmission(row));
  }

  listSubmissions({ verdict = null } = {}) {
    return this.db.prepare(`SELECT * FROM task_submissions ${verdict ? 'WHERE verdict=?' : ''} ORDER BY created_at DESC`)
      .all(...(verdict ? [verdict] : [])).map((row) => this.mapSubmission(row));
  }

  reviewSubmission({ submissionId, verdict }) {
    if (!['passed', 'rework'].includes(verdict)) throw new Error('审核结果无效。');
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const submission = this.db.prepare('SELECT * FROM task_submissions WHERE id=?').get(submissionId);
      if (!submission || submission.verdict !== 'pending') throw new Error('待审核提交不存在。');
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(submission.task_id);
      if (!task || task.status !== 'submitted' || task.version !== submission.task_version) throw new Error('任务版本或状态已变化。');
      const next = verdict === 'passed' && task.roadmap_id
        ? this.db.prepare("SELECT * FROM tasks WHERE roadmap_id=? AND position>? AND status='ready' ORDER BY position LIMIT 1")
          .get(task.roadmap_id, task.position)
        : null;
      if (next) {
        const access = this.db.prepare("SELECT id FROM project_access WHERE project_id=? AND user_id=? AND status='active'")
          .get(next.project_id, next.assignee_user_id);
        if (!access) throw new Error('下一任务员工的项目授权已失效，不能自动推进。');
      }
      this.db.prepare('UPDATE task_submissions SET verdict=?,reviewed_at=? WHERE id=?').run(verdict, timestamp, submissionId);
      if (verdict === 'rework') {
        this.db.prepare("UPDATE tasks SET status='rework',version=version+1,updated_at=? WHERE id=?").run(timestamp, task.id);
        if (task.roadmap_id) this.db.prepare("UPDATE roadmaps SET status='rework',version=version+1,updated_at=? WHERE id=?").run(timestamp, task.roadmap_id);
      } else {
        this.db.prepare("UPDATE tasks SET status='passed',updated_at=? WHERE id=?").run(timestamp, task.id);
        if (next) {
          this.db.prepare("UPDATE tasks SET status='active',updated_at=? WHERE id=?").run(timestamp, next.id);
          this.db.prepare("UPDATE roadmaps SET status='active',updated_at=? WHERE id=?").run(timestamp, task.roadmap_id);
        } else if (task.roadmap_id) {
          this.db.prepare("UPDATE roadmaps SET status='passed',updated_at=? WHERE id=?").run(timestamp, task.roadmap_id);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSubmission(submissionId);
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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return {
      users: count('users'), activeUsers: count('users', "WHERE status='active'"),
      todayActiveUsers: Number(this.db.prepare('SELECT COUNT(*) AS count FROM users WHERE last_login_at>=?').get(today.toISOString()).count),
      projects: count('projects'), chats: count('chats'), messages: count('messages'),
      runningChats: count('chats', "WHERE status='running'"),
      activeShares: count('project_access', "WHERE access_kind='shared' AND status='active'"),
      tasks: count('tasks'), activeTasks: count('tasks', "WHERE status IN ('active','rework')"),
      pendingSubmissions: count('task_submissions', "WHERE verdict='pending'"),
    };
  }
}
