export function migrateDispatch(sql) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS task_materials (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT NOT NULL, access_id TEXT NOT NULL, chat_id TEXT,
      name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
      source_path TEXT, created_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, UNIQUE(owner_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS task_dispatches (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
      source_project_id TEXT NOT NULL, source_access_id TEXT NOT NULL, source_chat_id TEXT,
      owner_epoch INTEGER NOT NULL, request_json TEXT NOT NULL, project_id TEXT,
      roadmap_id TEXT, run_id TEXT, job_id TEXT, status TEXT NOT NULL DEFAULT 'accepted',
      idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS task_input_revisions (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, task_version INTEGER NOT NULL, manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      PRIMARY KEY(task_id,revision), UNIQUE(task_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS task_input_usage (
      turn_run_id TEXT PRIMARY KEY REFERENCES turn_runs(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL, revision INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_submission_inputs (
      submission_id TEXT PRIMARY KEY REFERENCES task_submissions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, manifest_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_notifications (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_version INTEGER NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, read_at TEXT,
      UNIQUE(user_id,task_id,task_version,kind,revision)
    );
    CREATE TABLE IF NOT EXISTS weixin_connections (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT NOT NULL, access_id TEXT NOT NULL, chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending', generation INTEGER NOT NULL DEFAULT 1,
      account_id TEXT, sender_id TEXT, credential_epoch INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS weixin_user_active ON weixin_connections(user_id) WHERE status!='revoked';
    CREATE UNIQUE INDEX IF NOT EXISTS weixin_account_active ON weixin_connections(account_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS weixin_inbox (
      id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES weixin_connections(id),
      generation INTEGER NOT NULL, external_id TEXT NOT NULL, chat_id TEXT, project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', payload_json TEXT NOT NULL, response_text TEXT,
      error_code TEXT, turn_run_id TEXT, created_at TEXT NOT NULL,
      UNIQUE(connection_id,external_id)
    );
    CREATE TABLE IF NOT EXISTS weixin_outbox (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES weixin_connections(id),
      dedupe_key TEXT NOT NULL UNIQUE, task_id TEXT, notification_id TEXT,
      inbox_id INTEGER, dispatch_id TEXT, status TEXT NOT NULL DEFAULT 'queued',
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  for (const column of ['last_poll_at', 'last_error_code']) if (!sql.prepare('PRAGMA table_info(weixin_connections)').all().some(c => c.name === column)) sql.exec(`ALTER TABLE weixin_connections ADD COLUMN ${column} TEXT`);
  if (!sql.prepare('PRAGMA table_info(chats)').all().some(c => c.name === 'dispatch_tools_version')) {
    sql.exec('ALTER TABLE chats ADD COLUMN dispatch_tools_version INTEGER NOT NULL DEFAULT 0');
  }
}
