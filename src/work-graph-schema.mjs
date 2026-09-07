// Schema helpers only run during database construction, never inside a request transaction.
export function ensureSubmissionSchema(sql) {
  const columns = sql.prepare('PRAGMA table_info(task_submissions)').all();
  const keys = sql.prepare('PRAGMA foreign_key_list(task_submissions)').all();
  if (columns.some((c) => c.name === 'kind')
    && columns.find((c) => c.name === 'codex_thread_id')?.notnull === 0
    && ['chat_id', 'turn_run_id'].every((name) => columns.find((c) => c.name === name)?.notnull === 0
      && keys.find((key) => key.from === name)?.on_delete === 'SET NULL')) return;
  // Do not rename the old table: SQLite would retarget existing child foreign keys.
  sql.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    sql.exec(`CREATE TABLE task_submissions_next (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      task_version INTEGER NOT NULL,
      submitter_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_access_id TEXT REFERENCES project_access(id) ON DELETE SET NULL,
      chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
      turn_run_id TEXT REFERENCES turn_runs(id) ON DELETE SET NULL,
      codex_thread_id TEXT, codex_turn_id TEXT, final_item_id TEXT,
      final_reply_snapshot TEXT NOT NULL,
      diff_snapshot TEXT NOT NULL DEFAULT '', employee_note TEXT NOT NULL DEFAULT '',
      snapshot_commit_sha TEXT, snapshot_tree_sha TEXT, delivery_commit_sha TEXT, delivered_at TEXT,
      verdict TEXT NOT NULL DEFAULT 'pending' CHECK(verdict IN ('pending','passed','rework')),
      created_at TEXT NOT NULL, reviewed_at TEXT,
      kind TEXT NOT NULL DEFAULT 'codex' CHECK(kind IN ('codex','manual')),
      result_summary TEXT NOT NULL DEFAULT '',
      checklist_snapshot_json TEXT NOT NULL DEFAULT '[]',
      outputs_manifest_json TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT,
      CHECK((kind='codex' AND codex_thread_id IS NOT NULL AND codex_turn_id IS NOT NULL AND final_item_id IS NOT NULL)
        OR (kind='manual' AND codex_thread_id IS NULL AND codex_turn_id IS NULL AND final_item_id IS NULL)),
      UNIQUE(task_id,task_version)
    );`);
    const names = columns.map((c) => c.name);
    const targets = sql.prepare('PRAGMA table_info(task_submissions_next)').all().map((c) => c.name)
      .filter((name) => names.includes(name));
    sql.exec(`INSERT INTO task_submissions_next (${targets.join(',')}) SELECT ${targets.join(',')} FROM task_submissions;
      DROP TABLE task_submissions;
      ALTER TABLE task_submissions_next RENAME TO task_submissions;
      CREATE INDEX task_submissions_task_idx ON task_submissions(task_id,created_at DESC);`);
    if (sql.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Submission migration violated foreign keys.');
    sql.exec('COMMIT');
  } catch (error) { sql.exec('ROLLBACK'); throw error; }
  finally { sql.exec('PRAGMA foreign_keys=ON'); }
}

export function migrateWorkGraph(sql) {
  const column = (table, name, definition) => {
    if (!sql.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === name)) {
      sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  sql.exec('BEGIN IMMEDIATE');
  try {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS employee_profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        profile_json TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL REFERENCES users(id), updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_plan_versions (
        id TEXT PRIMARY KEY, roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, graph_json TEXT NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
        created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
        UNIQUE(roadmap_id,version)
      );
      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY, roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES graph_plan_versions(id),
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id), owner_access_id TEXT NOT NULL REFERENCES project_access(id),
        status TEXT NOT NULL CHECK(status IN ('preparing','running','paused','passed','cancelled','superseded')),
        revision INTEGER NOT NULL DEFAULT 1, generation INTEGER NOT NULL DEFAULT 1,
        review_policy_json TEXT NOT NULL, authorization_json TEXT NOT NULL,
        paused_reason TEXT, last_checked_at TEXT, next_check_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(roadmap_id,id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workflow_active_project_idx ON workflow_runs(project_id)
        WHERE status IN ('preparing','running','paused');
      CREATE TABLE IF NOT EXISTS workflow_jobs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        owner_user_id TEXT NOT NULL REFERENCES users(id),
        workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE,
        generation INTEGER NOT NULL DEFAULT 1, task_id TEXT REFERENCES tasks(id), task_version INTEGER,
        submission_id TEXT REFERENCES task_submissions(id),
        payload_json TEXT NOT NULL DEFAULT '{}', result_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','retry_wait','succeeded','needs_attention','cancelled')),
        due_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
        error_code TEXT, turn_run_id TEXT REFERENCES turn_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_jobs_due_idx ON workflow_jobs(status,due_at);
      CREATE INDEX IF NOT EXISTS workflow_jobs_run_idx ON workflow_jobs(workflow_run_id,status);
      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES task_submissions(id),
        task_version INTEGER NOT NULL, actor_user_id TEXT NOT NULL REFERENCES users(id),
        source TEXT NOT NULL CHECK(source IN ('human','ai')),
        verdict TEXT NOT NULL CHECK(verdict IN ('passed','rework','needs_human')),
        detail_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'suggested'
          CHECK(status IN ('suggested','applied','superseded')),
        dedupe_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, applied_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS task_reviews_applied_idx ON task_reviews(submission_id) WHERE status='applied';
      CREATE TABLE IF NOT EXISTS task_handoffs (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), task_version INTEGER NOT NULL,
        submission_id TEXT NOT NULL UNIQUE REFERENCES task_submissions(id),
        delivery_commit_sha TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workflow_run_id TEXT REFERENCES workflow_runs(id), task_id TEXT REFERENCES tasks(id),
        recipient_user_id TEXT REFERENCES users(id), event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS project_events_project_idx ON project_events(project_id,id);
    `);
    column('roadmaps', 'kind', "TEXT NOT NULL DEFAULT 'linear' CHECK(kind IN ('linear','dag'))");
    column('users', 'workflow_policy_epoch', 'INTEGER NOT NULL DEFAULT 1');
    column('roadmaps', 'current_workflow_id', 'TEXT REFERENCES workflow_runs(id)');
    column('tasks', 'workflow_run_id', 'TEXT REFERENCES workflow_runs(id)');
    column('tasks', 'node_key', 'TEXT');
    column('tasks', 'checklist_json', "TEXT NOT NULL DEFAULT '[]'");
    column('tasks', 'checklist_revision', 'INTEGER NOT NULL DEFAULT 1');
    column('tasks', 'due_at', 'TEXT');
    column('tasks', 'blocked_reason', 'TEXT');
    column('tasks', 'input_manifest_json', "TEXT NOT NULL DEFAULT '[]'");
    column('tasks', 'input_base_sha', 'TEXT');
    column('tasks', 'assigned_access_id', 'TEXT REFERENCES project_access(id)');
    column('tasks', 'foreign_work_seen', 'INTEGER NOT NULL DEFAULT 0');
    column('chats', 'purpose', "TEXT NOT NULL DEFAULT 'normal' CHECK(purpose IN ('normal','planner','reviewer'))");
    column('chats', 'workflow_job_id', 'TEXT REFERENCES workflow_jobs(id)');
    sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_workflow_node_idx ON tasks(workflow_run_id,node_key);
      CREATE UNIQUE INDEX IF NOT EXISTS submission_idempotency_idx ON task_submissions(task_id,idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      INSERT OR IGNORE INTO schema_migrations(name,applied_at) VALUES ('human_work_graph_v1',strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    sql.exec('COMMIT');
  } catch (error) { sql.exec('ROLLBACK'); throw error; }
}
