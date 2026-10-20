import { TokenUsageLedger } from './token-usage.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ensureSubmissionSchema, migrateWorkGraph } from './work-graph-schema.mjs';
import { migratePrivateProjects, assertStandardProject } from './private-projects.mjs';
import { migrateToolDetails } from './tool-details.mjs';

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
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        codex_thread_id TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'idle',
        preferred_mode TEXT NOT NULL DEFAULT 'execute' CHECK(preferred_mode IN ('edit','execute')),
        memory_context_reset_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chats_user_id_idx ON chats(user_id);
      CREATE INDEX IF NOT EXISTS chats_project_id_idx ON chats(project_id);
      CREATE TABLE IF NOT EXISTS chat_inputs (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('edit','execute')),
        effort TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','paused','steering','sent','cancelled')),
        revision INTEGER NOT NULL DEFAULT 1,
        reason TEXT,
        turn_run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_inputs_chat_idx ON chat_inputs(chat_id,status);
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
        project_access_id TEXT REFERENCES project_access(id) ON DELETE SET NULL,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        turn_run_id TEXT REFERENCES turn_runs(id) ON DELETE SET NULL,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        final_item_id TEXT NOT NULL,
        final_reply_snapshot TEXT NOT NULL,
        diff_snapshot TEXT NOT NULL DEFAULT '',
        employee_note TEXT NOT NULL DEFAULT '',
        snapshot_commit_sha TEXT,
        snapshot_tree_sha TEXT,
        delivery_commit_sha TEXT,
        delivered_at TEXT,
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
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_scope_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, external_scope_id)
      );
      CREATE INDEX IF NOT EXISTS channel_bindings_chat_idx ON channel_bindings(chat_id, status);
      CREATE TABLE IF NOT EXISTS channel_events (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        external_event_id TEXT NOT NULL,
        external_scope_id TEXT NOT NULL,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing','completed','failed')),
        response_text TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(channel, external_event_id)
      );
      CREATE INDEX IF NOT EXISTS channel_events_scope_idx ON channel_events(channel, external_scope_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_thread_recoveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        old_thread_id TEXT,
        new_thread_id TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_thread_recoveries_chat_idx
        ON chat_thread_recoveries(chat_id, id DESC);
      CREATE TABLE IF NOT EXISTS turn_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_events_run_idx ON turn_events(turn_run_id, id);
      CREATE INDEX IF NOT EXISTS turn_events_chat_idx ON turn_events(chat_id, id);
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleted')),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','turn')),
        source_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        source_turn_run_id TEXT REFERENCES turn_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS user_memories_owner_idx ON user_memories(user_id,status,updated_at DESC);
      CREATE TABLE IF NOT EXISTS user_memory_sources (
        memory_id TEXT NOT NULL REFERENCES user_memories(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        chat_id TEXT,
        turn_run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(memory_id,project_id,chat_id,turn_run_id)
      );
      CREATE INDEX IF NOT EXISTS user_memory_sources_project_idx ON user_memory_sources(project_id,memory_id);
      CREATE TABLE IF NOT EXISTS turn_memory_refs (
        turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES user_memories(id) ON DELETE CASCADE,
        memory_version INTEGER NOT NULL,
        source_project_id TEXT,
        referenced_at TEXT NOT NULL,
        PRIMARY KEY(turn_run_id,memory_id)
      );
      CREATE INDEX IF NOT EXISTS turn_memory_refs_memory_idx ON turn_memory_refs(memory_id,turn_run_id);
      CREATE TABLE IF NOT EXISTS memory_extraction_jobs (
        id TEXT PRIMARY KEY,
        turn_run_id TEXT NOT NULL UNIQUE REFERENCES turn_runs(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_extraction_jobs_status_idx ON memory_extraction_jobs(status,created_at);
      CREATE TABLE IF NOT EXISTS memory_share_confirmations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        snapshot_hash TEXT NOT NULL,
        memory_count INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_share_confirmations_lookup_idx
        ON memory_share_confirmations(owner_user_id,project_id,recipient_user_id,expires_at);
      DROP INDEX IF EXISTS project_access_one_share_idx;
    `);
    this.#ensureColumn('projects', 'repo_kind', "TEXT NOT NULL DEFAULT 'directory'");
    this.#ensureColumn('chats', 'project_access_id', 'TEXT');
    this.#ensureColumn('chats', 'tree_path', 'TEXT');
    this.#ensureColumn('chats', 'task_id', 'TEXT REFERENCES tasks(id)');
    this.#ensureColumn('chats', 'task_version', 'INTEGER');
    this.#ensureColumn('chats', 'source_chat_id', 'TEXT');
    this.#ensureColumn('chats', 'shared_at', 'TEXT');
    this.#ensureColumn('chats', 'archived_at', 'TEXT');
    this.#ensureColumn('chats', 'thread_state', "TEXT NOT NULL DEFAULT 'ready'");
    this.#ensureColumn('chats', 'thread_error', 'TEXT');
    this.#ensureColumn('chats', 'preferred_model', 'TEXT');
    this.#ensureColumn('chats', 'preferred_effort', 'TEXT');
    this.#ensureColumn('chats', 'use_memory', 'INTEGER NOT NULL DEFAULT 1');
    this.#ensureColumn('chats', 'save_memory', 'INTEGER NOT NULL DEFAULT 1');
    this.#ensureColumn('chats', 'memory_context_reset_at', 'TEXT');
    this.#ensureColumn('chats', 'preferred_mode', "TEXT NOT NULL DEFAULT 'execute' CHECK(preferred_mode IN ('edit','execute'))");
    this.#ensureColumn('chats', 'channel_tools_version', 'INTEGER NOT NULL DEFAULT 0');
    this.#ensureColumn('project_access', 'base_sha', 'TEXT');
    this.#ensureColumn('task_submissions', 'project_access_id', 'TEXT REFERENCES project_access(id) ON DELETE SET NULL');
    this.#ensureColumn('task_submissions', 'snapshot_commit_sha', 'TEXT');
    this.#ensureColumn('task_submissions', 'snapshot_tree_sha', 'TEXT');
    this.#ensureColumn('task_submissions', 'delivery_commit_sha', 'TEXT');
    this.#ensureColumn('task_submissions', 'delivered_at', 'TEXT');
    this.#ensureSubmissionRetentionSchema();
    this.#backfillOwnerAccess();
    this.#repairOrphanedSubmissionsOnce();
    migrateWorkGraph(this.db);
    migratePrivateProjects(this.db);
    migrateToolDetails(this.db);
    this.tokenUsage = new TokenUsageLedger(this.db);
  }

  #ensureColumn(table, name, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }

  #ensureSubmissionRetentionSchema() {
    ensureSubmissionSchema(this.db);
  }

  #repairOrphanedSubmissionsOnce() {
    const migration = 'repair_orphaned_submissions_v1';
    if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE name=?').get(migration)) return;
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const orphans = this.db.prepare(`SELECT t.* FROM tasks t
        WHERE t.status='submitted' AND NOT EXISTS (
          SELECT 1 FROM task_submissions s WHERE s.task_id=t.id AND s.task_version=t.version
        )`).all();
      const roadmapIds = new Set();
      for (const task of orphans) {
        const changed = this.db.prepare("UPDATE tasks SET status='rework',version=version+1,updated_at=? WHERE id=? AND status='submitted' AND version=?")
          .run(timestamp, task.id, task.version);
        if (!Number(changed.changes)) continue;
        if (task.roadmap_id) roadmapIds.add(task.roadmap_id);
        this.db.prepare(`INSERT INTO audit_log
          (actor_user_id,action,target_type,target_id,detail_json,created_at)
          VALUES (NULL,'task.submission_orphan_repaired','task',?,?,?)`)
          .run(task.id, JSON.stringify({ previousVersion: task.version, nextVersion: task.version + 1 }), timestamp);
      }
      for (const roadmapId of roadmapIds) {
        this.db.prepare("UPDATE roadmaps SET status='rework',version=version+1,updated_at=? WHERE id=?")
          .run(timestamp, roadmapId);
      }
      this.db.prepare('INSERT INTO schema_migrations (name,applied_at) VALUES (?,?)').run(migration, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
    const current = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if ('passwordHash' in patch || ('status' in patch && patch.status !== current?.status)
      || ('networkAccess' in patch && Boolean(patch.networkAccess) !== Boolean(current?.network_access))) {
      fields.push('workflow_policy_epoch = workflow_policy_epoch + 1');
    }
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

  createProject({ userId, slug, name, description = '', projectType = 'standard' }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO projects (id,user_id,slug,name,description,created_at,updated_at,project_type) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, userId, slug, name, description, timestamp, timestamp, projectType);
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
      projectType: row.project_type || 'standard',
      description: row.description, createdAt: row.created_at, updatedAt: row.updated_at,
      username: row.username, displayName: row.display_name,
      repoKind: row.repo_kind || 'directory', accessId: row.access_id,
      accessUserId: row.access_user_id, accessKind: row.access_kind,
      treePath: row.tree_path, branchName: row.branch_name, baseSha: row.base_sha,
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
      a.id AS access_id,a.user_id AS access_user_id,a.access_kind,a.tree_path,a.branch_name,a.base_sha
      FROM projects p JOIN users owner ON owner.id=p.user_id
      JOIN project_access a ON a.project_id=p.id AND a.user_id=? AND a.status='active'
      WHERE p.id=? AND (p.project_type='standard' OR (p.user_id=a.user_id AND a.access_kind='owner'))`).get(userId, projectId));
  }

  listProjectsForUser(userId) {
    return this.db.prepare(`SELECT p.*,owner.username,owner.display_name,
      a.id AS access_id,a.user_id AS access_user_id,a.access_kind,a.tree_path,a.branch_name,a.base_sha
      FROM project_access a JOIN projects p ON p.id=a.project_id JOIN users owner ON owner.id=p.user_id
      WHERE a.user_id=? AND a.status='active' AND (p.project_type='standard' OR (p.user_id=a.user_id AND a.access_kind='owner')) ORDER BY p.updated_at DESC`).all(userId).map((row) => this.mapProject(row));
  }

  listAdminProjects() {
    const projects = this.db.prepare(`SELECT p.*,owner.username,owner.display_name
      FROM projects p JOIN users owner ON owner.id=p.user_id
      ORDER BY p.updated_at DESC`).all().map((row) => this.mapProject(row));
    const activeShares = this.db.prepare(`SELECT a.*,u.username,u.display_name
      FROM project_access a JOIN users u ON u.id=a.user_id
      WHERE a.access_kind='shared' AND a.status='active' ORDER BY a.created_at`).all();
    const byProject = new Map();
    for (const row of activeShares) {
      if (!byProject.has(row.project_id)) byProject.set(row.project_id, []);
      byProject.get(row.project_id).push({
        id: row.id, projectId: row.project_id, userId: row.user_id,
        accessKind: row.access_kind, branchName: row.branch_name, baseSha: row.base_sha,
        status: row.status, username: row.username, displayName: row.display_name,
        createdAt: row.created_at, revokedAt: row.revoked_at,
      });
    }
    return projects.map((project) => {
      const sharedAccesses = byProject.get(project.id) || [];
      const singular = sharedAccesses.length === 1 ? sharedAccesses[0] : null;
      return {
        ...project, sharedAccesses,
        sharedUserId: singular?.userId || null,
        sharedUsername: singular?.username || null,
        sharedDisplayName: singular?.displayName || null,
        sharedAccessId: singular?.id || null,
      };
    });
  }

  getProjectAccessById(id) {
    const row = this.db.prepare(`SELECT a.*,u.username,u.display_name FROM project_access a
      JOIN users u ON u.id=a.user_id WHERE a.id=?`).get(id);
    return row ? {
      id: row.id, projectId: row.project_id, userId: row.user_id,
      accessKind: row.access_kind, treePath: row.tree_path, branchName: row.branch_name,
      baseSha: row.base_sha, status: row.status, username: row.username, displayName: row.display_name,
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
        baseSha: row.base_sha, status: row.status, username: row.username, displayName: row.display_name,
        createdAt: row.created_at, revokedAt: row.revoked_at,
      }));
  }

  grantProjectAccess({ id = randomUUID(), projectId, userId, treePath, branchName, baseSha = null }) {
    assertStandardProject(this.getProject(projectId));
    this.db.prepare(`INSERT INTO project_access
      (id,project_id,user_id,access_kind,tree_path,branch_name,base_sha,status,created_at)
      VALUES (?,?,?,'shared',?,?,?,'active',?)`).run(id, projectId, userId, treePath, branchName, baseSha, now());
    return this.getProjectAccessById(id);
  }

  latestRevokedProjectAccess(projectId, userId) {
    const row = this.db.prepare(`SELECT id FROM project_access
      WHERE project_id=? AND user_id=? AND access_kind='shared' AND status='revoked'
      ORDER BY revoked_at DESC,created_at DESC LIMIT 1`).get(projectId, userId);
    return row ? this.getProjectAccessById(row.id) : null;
  }

  restoreProjectAccess(id) {
    this.db.prepare("UPDATE project_access SET status='active',revoked_at=NULL WHERE id=? AND access_kind='shared' AND status='revoked'")
      .run(id);
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

  createChat({ projectId, userId, projectAccessId, treePath, title, taskId = null, taskVersion = null, preferredMode = 'execute' }) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO chats (id,project_id,user_id,project_access_id,tree_path,title,task_id,task_version,preferred_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, projectId, userId, projectAccessId, treePath, title, taskId, taskVersion, preferredMode, timestamp, timestamp);
    return this.getChat(id);
  }

  getChannelBinding(channel, externalScopeId) {
    const row = this.db.prepare(`SELECT b.*, c.title AS chat_title
      FROM channel_bindings b JOIN chats c ON c.id=b.chat_id
      WHERE b.channel=? AND b.external_scope_id=?`).get(channel, externalScopeId);
    return row ? {
      id: row.id, channel: row.channel, externalScopeId: row.external_scope_id,
      userId: row.user_id, projectId: row.project_id, chatId: row.chat_id,
      status: row.status, title: row.chat_title, createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  getChannelBindingByChat(channel, chatId) {
    const row = this.db.prepare(`SELECT b.*, c.title AS chat_title
      FROM channel_bindings b JOIN chats c ON c.id=b.chat_id
      WHERE b.channel=? AND b.chat_id=? ORDER BY b.updated_at DESC LIMIT 1`).get(channel, chatId);
    return row ? {
      id: row.id, channel: row.channel, externalScopeId: row.external_scope_id,
      userId: row.user_id, projectId: row.project_id, chatId: row.chat_id,
      status: row.status, title: row.chat_title, createdAt: row.created_at, updatedAt: row.updated_at,
    } : null;
  }

  createChannelBinding({ id = randomUUID(), channel, externalScopeId, userId, projectId, chatId }) {
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO channel_bindings
      (id,channel,external_scope_id,user_id,project_id,chat_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'active',?,?)`).run(id, channel, externalScopeId, userId, projectId, chatId, timestamp, timestamp);
    return this.getChannelBinding(channel, externalScopeId);
  }

  rebindChannelBindingChat({ channel, externalScopeId, expectedChatId, chatId }) {
    const result = this.db.prepare(`UPDATE channel_bindings
      SET chat_id=?,updated_at=?
      WHERE channel=? AND external_scope_id=? AND status='active' AND chat_id=?`)
      .run(chatId, now(), channel, externalScopeId, expectedChatId);
    if (Number(result.changes) !== 1) {
      const error = new Error('微信会话绑定已变化。');
      error.code = 'CHANNEL_BINDING_CHANGED';
      throw error;
    }
    return this.getChannelBinding(channel, externalScopeId);
  }

  getChannelEvent(channel, externalEventId) {
    const row = this.db.prepare('SELECT * FROM channel_events WHERE channel=? AND external_event_id=?')
      .get(channel, externalEventId);
    return row ? {
      id: row.id, channel: row.channel, externalEventId: row.external_event_id,
      externalScopeId: row.external_scope_id, chatId: row.chat_id, status: row.status,
      responseText: row.response_text, errorCode: row.error_code,
      createdAt: row.created_at, completedAt: row.completed_at,
    } : null;
  }

  createChannelEvent({ id = randomUUID(), channel, externalEventId, externalScopeId, chatId = null }) {
    const timestamp = now();
    const result = this.db.prepare(`INSERT OR IGNORE INTO channel_events
      (id,channel,external_event_id,external_scope_id,chat_id,status,created_at)
      VALUES (?,?,?,?,?,'processing',?)`).run(id, channel, externalEventId, externalScopeId, chatId, timestamp);
    return { ...this.getChannelEvent(channel, externalEventId), created: result.changes === 1 };
  }

  completeChannelEvent(channel, externalEventId, { status = 'completed', responseText = null, errorCode = null } = {}) {
    this.db.prepare(`UPDATE channel_events SET status=?,response_text=?,error_code=?,completed_at=?
      WHERE channel=? AND external_event_id=?`).run(status, responseText, errorCode, now(), channel, externalEventId);
    return this.getChannelEvent(channel, externalEventId);
  }

  grantProjectAccessWithChats(options, snapshots) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const access = this.grantProjectAccess(options);
      const sharedAt = now();
      for (const snapshot of snapshots) {
        const chat = this.createChat({ projectId: options.projectId, userId: options.userId,
          projectAccessId: access.id, treePath: access.treePath,
          title: snapshot.source.title, preferredMode: snapshot.source.preferredMode });
        this.db.prepare('UPDATE chats SET codex_thread_id=?,source_chat_id=?,shared_at=? WHERE id=?')
          .run(snapshot.threadId, snapshot.source.id, sharedAt, chat.id);
        for (const message of snapshot.messages) this.addMessage({
          ...message, id: `native:${chat.id}:${message.id}`, chatId: chat.id,
          metadata: { sharedSnapshot: true },
        });
      }
      this.db.exec('COMMIT');
      return access;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  mapChat(row) {
    return row ? {
      id: row.id, projectId: row.project_id, userId: row.user_id, title: row.title,
      codexThreadId: row.codex_thread_id, status: row.status, archivedAt: row.archived_at || null,
      purpose: row.purpose || 'normal', workflowJobId: row.workflow_job_id || null,
      preferredMode: row.preferred_mode || 'execute',
      preferredModel: row.preferred_model || null,
      preferredEffort: row.preferred_effort || null,
      controlMode: row.control_mode || 'manual', localSessionId: row.local_session_id || null,
      useMemory: row.use_memory === undefined ? true : Boolean(row.use_memory),
      saveMemory: row.save_memory === undefined ? true : Boolean(row.save_memory),
      memoryContextResetAt: row.memory_context_reset_at || null,
      channelToolsVersion: Number(row.channel_tools_version || 0),
      sourceChatId: row.source_chat_id || null, sharedAt: row.shared_at || null,
      threadState: row.thread_state || 'ready', threadError: row.thread_error || null,
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
    for (const [key, column] of [
      ['archivedAt', 'archived_at'], ['title', 'title'], ['codexThreadId', 'codex_thread_id'], ['status', 'status'],
      ['taskId', 'task_id'], ['taskVersion', 'task_version'], ['threadState', 'thread_state'],
      ['threadError', 'thread_error'], ['preferredMode', 'preferred_mode'], ['preferredModel', 'preferred_model'], ['preferredEffort', 'preferred_effort'],
      ['controlMode', 'control_mode'], ['localSessionId', 'local_session_id'],
      ['useMemory', 'use_memory'], ['saveMemory', 'save_memory'],
      ['channelToolsVersion', 'channel_tools_version'],
    ]) {
      if (key in patch) {
        fields.push(`${column}=?`);
        values.push(['useMemory', 'saveMemory'].includes(key) ? (patch[key] ? 1 : 0) : patch[key]);
      }
    }
    fields.push('updated_at=?'); values.push(now(), id);
    this.db.prepare(`UPDATE chats SET ${fields.join(',')} WHERE id=?`).run(...values);
    return this.getChat(id);
  }

  chatHasSubmission(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM task_submissions WHERE chat_id=? LIMIT 1').get(id));
  }

  runtimeForChat(id) {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM turn_runs WHERE chat_id=? AND status IN ('queued','starting','running')) AS turn_busy,
      EXISTS(SELECT 1 FROM turn_approvals WHERE chat_id=? AND status='pending') AS approval_busy,
      EXISTS(SELECT 1 FROM execution_leases WHERE chat_id=? AND expires_at>?) AS lease_busy`).get(id, id, id, now());
    const queueBusy = Boolean(this.db.prepare(`SELECT 1 FROM chat_inputs q JOIN chats c ON c.id=q.chat_id
      WHERE c.id=? AND q.status IN ('queued','steering') LIMIT 1`).get(id));
    return {
      busy: queueBusy || Boolean(row?.turn_busy || row?.approval_busy || row?.lease_busy),
      queueBusy, turnBusy: Boolean(row?.turn_busy), approvalBusy: Boolean(row?.approval_busy), leaseBusy: Boolean(row?.lease_busy),
    };
  }

  runtimeForAccess(id) {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM chats c JOIN turn_runs r ON r.chat_id=c.id
        WHERE c.project_access_id=? AND r.status IN ('queued','starting','running')) AS turn_busy,
      EXISTS(SELECT 1 FROM chats c JOIN turn_approvals a ON a.chat_id=c.id
        WHERE c.project_access_id=? AND a.status='pending') AS approval_busy,
      EXISTS(SELECT 1 FROM chats c JOIN execution_leases l ON l.chat_id=c.id
        WHERE c.project_access_id=? AND l.expires_at>?) AS lease_busy`).get(id, id, id, now());
    const queueBusy = Boolean(this.db.prepare(`SELECT 1 FROM chat_inputs q JOIN chats c ON c.id=q.chat_id
      WHERE c.project_access_id=? AND q.status IN ('queued','steering') LIMIT 1`).get(id));
    return {
      busy: queueBusy || Boolean(row?.turn_busy || row?.approval_busy || row?.lease_busy),
      queueBusy, turnBusy: Boolean(row?.turn_busy), approvalBusy: Boolean(row?.approval_busy), leaseBusy: Boolean(row?.lease_busy),
    };
  }

  runtimeForProject(id) {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM turn_runs WHERE project_id=? AND status IN ('queued','starting','running')) AS turn_busy,
      EXISTS(SELECT 1 FROM turn_approvals a JOIN chats c ON c.id=a.chat_id
        WHERE c.project_id=? AND a.status='pending') AS approval_busy,
      EXISTS(SELECT 1 FROM execution_leases l JOIN chats c ON c.id=l.chat_id
        WHERE c.project_id=? AND l.expires_at>?) AS lease_busy`).get(id, id, id, now());
    const queueBusy = Boolean(this.db.prepare(`SELECT 1 FROM chat_inputs q JOIN chats c ON c.id=q.chat_id
      WHERE c.project_id=? AND q.status IN ('queued','steering') LIMIT 1`).get(id));
    return {
      busy: queueBusy || Boolean(row?.turn_busy || row?.approval_busy || row?.lease_busy),
      queueBusy, turnBusy: Boolean(row?.turn_busy), approvalBusy: Boolean(row?.approval_busy), leaseBusy: Boolean(row?.lease_busy),
    };
  }

  deleteChat(id) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.runtimeForChat(id).busy) throw new Error('对话仍有排队或运行中的任务，不能删除。');
      if (this.chatHasSubmission(id)) throw new Error('对话包含任务提交证据，不能删除。');
      this.db.prepare('DELETE FROM chats WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  markChatThreadError(id, error) {
    return this.updateChat(id, { threadState: 'resume_failed', threadError: String(error || '').slice(0, 4000) });
  }

  recoverChatThread({ chatId, expectedThreadId = null, newThreadId, reason = '' }) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const chat = this.db.prepare('SELECT * FROM chats WHERE id=?').get(chatId);
      if (!chat) throw new Error('对话不存在。');
      if ((chat.codex_thread_id || null) !== (expectedThreadId || null)) throw new Error('对话线程已变化，请刷新后重试。');
      this.db.prepare(`UPDATE chats SET codex_thread_id=?,thread_state='ready',thread_error=NULL,
        memory_context_reset_at=?,updated_at=? WHERE id=?`).run(newThreadId, timestamp, timestamp, chatId);
      this.db.prepare(`INSERT INTO chat_thread_recoveries (chat_id,old_thread_id,new_thread_id,reason,created_at)
        VALUES (?,?,?,?,?)`).run(chatId, chat.codex_thread_id, newThreadId, String(reason).slice(0, 4000), timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getChat(chatId);
  }

  listChatThreadRecoveries(chatId) {
    return this.db.prepare('SELECT * FROM chat_thread_recoveries WHERE chat_id=? ORDER BY id DESC').all(chatId)
      .map((row) => ({
        id: row.id, chatId: row.chat_id, oldThreadId: row.old_thread_id, newThreadId: row.new_thread_id,
        reason: row.reason, createdAt: row.created_at, engine: row.engine || 'codex',
      }));
  }

  recoverLocalChat({ chatId, expectedSessionId, newSessionId }) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.db.prepare(`UPDATE chats SET local_session_id=?,thread_state='ready',thread_error=NULL,
        memory_context_reset_at=?,updated_at=? WHERE id=? AND local_session_id IS ?
        AND project_id IN (SELECT id FROM projects WHERE project_type='local_private')`)
        .run(newSessionId, timestamp, timestamp, chatId, expectedSessionId || null);
      if (updated.changes !== 1) throw new Error('LOCAL_SESSION_MAPPING_CHANGED');
      this.db.prepare(`INSERT INTO chat_thread_recoveries (chat_id,old_thread_id,new_thread_id,reason,created_at,engine)
        VALUES (?,?,?,'explicit_local_reset',?,'qwen')`).run(chatId, expectedSessionId || null, newSessionId, timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getChat(chatId);
  }

  getChatInput(chatId, id) {
    return this.db.prepare('SELECT * FROM chat_inputs WHERE chat_id=? AND id=?').get(chatId, id) || null;
  }

  listChatInputs(chatId) {
    return this.db.prepare("SELECT * FROM chat_inputs WHERE chat_id=? AND status NOT IN ('sent','cancelled') ORDER BY rowid").all(chatId);
  }

  createChatInput({ id, chatId, prompt, mode, effort }) {
    this.db.prepare('INSERT INTO chat_inputs (id,chat_id,prompt,mode,effort,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, chatId, prompt, mode, effort, now());
    return this.getChatInput(chatId, id);
  }

  changeChatInput(chatId, id, revision, { status, prompt, reason = null, turnRunId = null }) {
    const result = this.db.prepare(`UPDATE chat_inputs SET status=?,prompt=COALESCE(?,prompt),reason=?,
      turn_run_id=COALESCE(?,turn_run_id),revision=revision+1 WHERE chat_id=? AND id=? AND revision=?`)
      .run(status, prompt ?? null, reason, turnRunId, chatId, id, revision);
    return Number(result.changes) ? this.getChatInput(chatId, id) : null;
  }

  pauseChatInputs(chatId, reason = 'TURN_STOPPED') {
    return Number(this.db.prepare("UPDATE chat_inputs SET status='paused',reason=?,revision=revision+1 WHERE chat_id=? AND status='queued'")
      .run(reason, chatId).changes);
  }

  addMessage({ id = randomUUID(), chatId, turnId = null, role, kind = 'message', content, metadata = {}, createdAt = now() }) {
    createdAt ||= now();
    const inserted = this.db.prepare('INSERT OR IGNORE INTO messages (id,chat_id,turn_id,role,kind,content,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, chatId, turnId, role, kind, content, JSON.stringify(metadata), createdAt);
    if (Number(inserted.changes)) this.updateChat(chatId, {});
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row ? {
      id: row.id, chatId: row.chat_id, turnId: row.turn_id, role: row.role,
      kind: row.kind, content: row.content, metadata: json(row.metadata_json), createdAt: row.created_at,
    } : null;
  }

  listMessages(chatId, limit = 500) {
    const bounded = limit === null ? null : Math.max(1, Math.min(5000, Number(limit) || 500));
    const query = bounded === null
      ? 'SELECT rowid AS message_rowid,* FROM messages WHERE chat_id=? ORDER BY created_at ASC,rowid ASC'
      : `SELECT * FROM (SELECT rowid AS message_rowid,* FROM messages WHERE chat_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?)
        ORDER BY created_at ASC,message_rowid ASC`;
    return this.db.prepare(query).all(...(bounded === null ? [chatId] : [chatId, bounded])).map((row) => ({
      id: row.id, chatId: row.chat_id, turnId: row.turn_id, role: row.role,
      kind: row.kind, content: row.content, metadata: json(row.metadata_json), createdAt: row.created_at,
    }));
  }

  appendTurnEvent({ turnRunId, chatId, eventType, payload = {} }) {
    const createdAt = now();
    const result = this.db.prepare(`INSERT INTO turn_events
      (turn_run_id,chat_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)`)
      .run(turnRunId, chatId, eventType, JSON.stringify(payload), createdAt);
    return { id: Number(result.lastInsertRowid), turnRunId, chatId, eventType, payload, createdAt };
  }

  listTurnEvents(chatId, { afterId = 0, limit = 1000, turnRunId = null, throughId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 1000));
    const clauses = ['chat_id=?', 'id>?'];
    const params = [chatId, Math.max(0, Number(afterId) || 0)];
    if (turnRunId) { clauses.push('turn_run_id=?'); params.push(turnRunId); }
    if (throughId !== null) { clauses.push('id<=?'); params.push(Math.max(0, Number(throughId) || 0)); }
    params.push(safeLimit);
    return this.db.prepare(`SELECT * FROM turn_events WHERE ${clauses.join(' AND ')} ORDER BY id LIMIT ?`)
      .all(...params).map((row) => ({
        id: row.id, turnRunId: row.turn_run_id, chatId: row.chat_id,
        eventType: row.event_type, payload: json(row.payload_json), createdAt: row.created_at,
      }));
  }

  getLatestTurnEventId(chatId) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM turn_events WHERE chat_id=?').get(chatId)?.id || 0);
  }

  getLatestTurnEventIdForRun(turnRunId) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM turn_events WHERE turn_run_id=?').get(turnRunId)?.id || 0);
  }

  recoverInterruptedRuntime() {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec("UPDATE chat_inputs SET status='paused',reason=CASE WHEN status='steering' THEN 'DELIVERY_UNCERTAIN' ELSE 'PORTAL_RESTARTED' END,revision=revision+1 WHERE status IN ('queued','steering')");
      const interrupted = this.db.prepare("SELECT id,chat_id FROM turn_runs WHERE status IN ('queued','starting','running')").all();
      this.db.prepare("UPDATE turn_runs SET status='interrupted',error_message='Portal restarted',completed_at=? WHERE status IN ('queued','starting','running')")
        .run(timestamp);
      const insertEvent = this.db.prepare(`INSERT INTO turn_events
        (turn_run_id,chat_id,event_type,payload_json,created_at) VALUES (?,?,'turn_error',?,?)`);
      const insertMessage = this.db.prepare(`INSERT OR IGNORE INTO messages
        (id,chat_id,turn_id,role,kind,content,metadata_json,created_at)
        VALUES (?,?,?,'error','turn_error',?,?,?)`);
      for (const run of interrupted) {
        insertEvent.run(run.id, run.chat_id, JSON.stringify({
          code: 'PORTAL_RESTARTED', message: 'Portal restarted', status: 'interrupted',
        }), timestamp);
        insertMessage.run(`error:${run.id}`, run.chat_id, run.id, 'Portal 重启，未完成的任务已中断。', JSON.stringify({
          turnRunId: run.id, status: 'interrupted', code: 'PORTAL_RESTARTED',
        }), timestamp);
      }
      this.db.prepare("UPDATE turn_approvals SET status='cancelled',resolved_at=? WHERE status='pending'").run(timestamp);
      this.db.exec('DELETE FROM execution_leases');
      this.db.prepare("UPDATE chats SET status='idle' WHERE status<>'idle'").run();
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
      version: row.version, kind: row.kind || 'linear', currentWorkflowId: row.current_workflow_id || null,
      createdAt: row.created_at, updatedAt: row.updated_at,
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
      workflowRunId: row.workflow_run_id || null, nodeKey: row.node_key || null,
      checklist: json(row.checklist_json, []), checklistRevision: row.checklist_revision || 1,
      dueAt: row.due_at || null, blockedReason: row.blocked_reason || null,
      inputManifest: json(row.input_manifest_json, []), inputBaseSha: row.input_base_sha || null,
      assignedAccessId: row.assigned_access_id || null, foreignWorkSeen: Boolean(row.foreign_work_seen),
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
      if (roadmap?.kind === 'dag') throw new Error('DAG 必须通过工作图启动接口激活。');
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

  getLatestTurnRunForChat(chatId) {
    return this.mapTurnRun(this.db.prepare('SELECT * FROM turn_runs WHERE chat_id=? ORDER BY created_at DESC LIMIT 1').get(chatId));
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

  submitTask({ taskId, taskVersion, submitterUserId, projectAccessId, chatId = null, turnRunId = null, itemId = null,
    note = '', snapshotCommitSha, snapshotTreeSha, kind = 'codex', resultSummary = '', checklistSnapshot = [],
    outputsManifest = [], idempotencyKey = null, afterSubmit = null }) {
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
      if (!task || task.assignee_user_id !== submitterUserId) throw new Error('任务不存在或不属于当前员工。');
      if (idempotencyKey) {
        const prior = this.db.prepare('SELECT id FROM task_submissions WHERE task_id=? AND idempotency_key=?').get(taskId, idempotencyKey);
        if (prior) { this.db.exec('COMMIT'); return this.getSubmission(prior.id); }
      }
      if (!['active', 'rework'].includes(task.status) || task.version !== taskVersion) throw new Error('任务版本已变化，请刷新后重新提交。');
      if (task.workflow_run_id && this.db.prepare('SELECT status FROM workflow_runs WHERE id=?').get(task.workflow_run_id)?.status !== 'running') {
        throw new Error('工作图已暂停或结束，不能提交任务。');
      }
      if (!['codex', 'manual'].includes(kind)) throw new Error('提交来源无效。');
      const run = kind === 'codex' ? this.db.prepare(`SELECT r.*,c.project_access_id AS chat_project_access_id FROM turn_runs r
        JOIN chats c ON c.id=r.chat_id WHERE r.id=? AND r.chat_id=? AND r.user_id=? AND r.task_id=?
        AND r.task_version=? AND r.status='completed' AND r.final_item_id=?`).get(
        turnRunId, chatId, submitterUserId, taskId, taskVersion, itemId,
      ) : null;
      if (kind === 'codex' && (!run || !run.final_reply_snapshot || !run.codex_thread_id || !run.codex_turn_id)) throw new Error('只能提交该任务对话中已完成的最终 Codex 回复。');
      if (kind === 'manual' && (!String(resultSummary).trim() || chatId || turnRunId || itemId)) throw new Error('人工交付须有成果说明且不得伪造 Codex 身份。');
      if (!/^[0-9a-f]{40,64}$/i.test(String(snapshotCommitSha || ''))
        || !/^[0-9a-f]{40,64}$/i.test(String(snapshotTreeSha || ''))) throw new Error('任务提交必须绑定有效的 Git commit 和 tree 快照。');
      if (run && run.chat_project_access_id !== projectAccessId) throw new Error('任务对话的项目授权已变化。');
      if (task.assigned_access_id && task.assigned_access_id !== projectAccessId) throw new Error('任务绑定的项目授权已变化。');
      const access = this.db.prepare("SELECT id FROM project_access WHERE id=? AND project_id=? AND user_id=? AND status='active'")
        .get(projectAccessId, task.project_id, submitterUserId);
      if (!access) throw new Error('任务提交对应的项目授权已失效。');
      const id = randomUUID();
      this.db.prepare(`INSERT INTO task_submissions
        (id,task_id,task_version,submitter_user_id,project_access_id,chat_id,turn_run_id,codex_thread_id,codex_turn_id,final_item_id,
         final_reply_snapshot,diff_snapshot,employee_note,snapshot_commit_sha,snapshot_tree_sha,created_at,
         kind,result_summary,checklist_snapshot_json,outputs_manifest_json,idempotency_key)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, taskId, taskVersion, submitterUserId, projectAccessId, chatId, turnRunId, run?.codex_thread_id || null, run?.codex_turn_id || null,
        run?.final_item_id || null, run?.final_reply_snapshot || resultSummary, run?.diff_snapshot || '', note, snapshotCommitSha, snapshotTreeSha, timestamp,
        kind, resultSummary, JSON.stringify(checklistSnapshot), JSON.stringify(outputsManifest), idempotencyKey,
      );
      const changed = this.db.prepare("UPDATE tasks SET status='submitted',updated_at=? WHERE id=? AND version=? AND status IN ('active','rework')")
        .run(timestamp, taskId, taskVersion);
      if (Number(changed.changes) !== 1) throw new Error('任务状态已变化，请刷新后重新提交。');
      if (task.roadmap_id && !task.workflow_run_id) this.db.prepare("UPDATE roadmaps SET status='submitted',updated_at=? WHERE id=?").run(timestamp, task.roadmap_id);
      if (afterSubmit) afterSubmit(this.getSubmission(id));
      this.db.exec('COMMIT');
      return this.getSubmission(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  mapSubmission(row) {
    return row ? {
      kind: row.kind || 'codex', resultSummary: row.result_summary || '',
      checklistSnapshot: json(row.checklist_snapshot_json, []), outputsManifest: json(row.outputs_manifest_json, []),
      idempotencyKey: row.idempotency_key || null,
      id: row.id, taskId: row.task_id, taskVersion: row.task_version, submitterUserId: row.submitter_user_id,
      projectAccessId: row.project_access_id, chatId: row.chat_id, turnRunId: row.turn_run_id, codexThreadId: row.codex_thread_id,
      codexTurnId: row.codex_turn_id, finalItemId: row.final_item_id, finalReplySnapshot: row.final_reply_snapshot,
      diffSnapshot: row.diff_snapshot, employeeNote: row.employee_note,
      snapshotCommitSha: row.snapshot_commit_sha, snapshotTreeSha: row.snapshot_tree_sha,
      deliveryCommitSha: row.delivery_commit_sha, deliveredAt: row.delivered_at, verdict: row.verdict,
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

  reviewSubmission({ submissionId, verdict, deliveryCommitSha = null }) {
    if (!['passed', 'rework'].includes(verdict)) throw new Error('审核结果无效。');
    if (verdict === 'passed' && !/^[0-9a-f]{40,64}$/i.test(String(deliveryCommitSha || ''))) {
      throw new Error('审核通过前必须完成并记录 owner Git 交付 commit。');
    }
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const submission = this.db.prepare('SELECT * FROM task_submissions WHERE id=?').get(submissionId);
      if (!submission || submission.verdict !== 'pending') throw new Error('待审核提交不存在。');
      const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(submission.task_id);
      if (task?.workflow_run_id) throw new Error('DAG 必须通过工作图审核服务推进。');
      if (!task || task.status !== 'submitted' || task.version !== submission.task_version) throw new Error('任务版本或状态已变化。');
      if (verdict === 'passed' && (!submission.project_access_id || !submission.snapshot_commit_sha || !submission.snapshot_tree_sha)) {
        throw new Error('历史提交缺少 Git 快照，不能直接审核通过；请要求返工并重新提交。');
      }
      const currentAccess = verdict === 'passed'
        ? this.db.prepare("SELECT id FROM project_access WHERE id=? AND project_id=? AND user_id=? AND status='active'")
          .get(submission.project_access_id, task.project_id, task.assignee_user_id)
        : this.db.prepare("SELECT id FROM project_access WHERE project_id=? AND user_id=? AND status='active'")
          .get(task.project_id, task.assignee_user_id);
      if (!currentAccess) throw new Error('当前任务员工的项目授权已失效，不能审核或自动推进。');
      const next = verdict === 'passed' && task.roadmap_id
        ? this.db.prepare("SELECT * FROM tasks WHERE roadmap_id=? AND position>? AND status='ready' ORDER BY position LIMIT 1")
          .get(task.roadmap_id, task.position)
        : null;
      if (next) {
        const access = this.db.prepare("SELECT id FROM project_access WHERE project_id=? AND user_id=? AND status='active'")
          .get(next.project_id, next.assignee_user_id);
        if (!access) throw new Error('下一任务员工的项目授权已失效，不能自动推进。');
      }
      this.db.prepare(`UPDATE task_submissions SET verdict=?,reviewed_at=?,delivery_commit_sha=?,delivered_at=? WHERE id=?`)
        .run(verdict, timestamp, verdict === 'passed' ? deliveryCommitSha : null, verdict === 'passed' ? timestamp : null, submissionId);
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
