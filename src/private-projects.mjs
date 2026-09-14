import { invariant } from './errors.mjs';

export const isPrivateProject = (project) => project?.projectType === 'local_private';
export function assertStandardProject(project) {
  invariant(!isPrivateProject(project), 403, 'PRIVATE_PROJECT_NO_COLLABORATION', '隐私项目不能分享、分配员工任务或启动工作图。');
}
export function localModelUrl(value) {
  const url = new URL(value || 'http://127.0.0.1:8000/v1');
  invariant(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash,
  400, 'LOCAL_MODEL_URL_INVALID', '本地模型必须使用明确的 HTTP 回环地址，不允许凭据、查询参数或远端地址。');
  return url.href.replace(/\/$/, '');
}

export function migratePrivateProjects(sql) {
  const column = (table, name, declaration) => {
    if (!sql.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === name)) sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  };
  column('projects', 'project_type', "TEXT NOT NULL DEFAULT 'standard' CHECK(project_type IN ('standard','local_private'))");
  column('chats', 'control_mode', "TEXT NOT NULL DEFAULT 'manual' CHECK(control_mode IN ('manual','auto'))");
  column('chats', 'local_session_id', 'TEXT');
  column('chat_thread_recoveries', 'engine', "TEXT NOT NULL DEFAULT 'codex'");
  column('user_memories', 'scope_project_id', 'TEXT REFERENCES projects(id) ON DELETE CASCADE');
  sql.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS chats_local_session_idx ON chats(local_session_id) WHERE local_session_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS memory_scope_idx ON user_memories(user_id,scope_project_id,status);
    CREATE TRIGGER IF NOT EXISTS project_type_immutable BEFORE UPDATE OF project_type ON projects
      WHEN NEW.project_type <> OLD.project_type BEGIN SELECT RAISE(ABORT,'PROJECT_TYPE_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS private_project_owner BEFORE INSERT ON projects
      WHEN NEW.project_type='local_private' AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role='admin' AND status='active')
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_OWNER_REQUIRED'); END;
    CREATE TRIGGER IF NOT EXISTS private_no_access_insert BEFORE INSERT ON project_access
      WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND project_type='local_private' AND (NEW.access_kind<>'owner' OR NEW.user_id<>user_id))
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_NO_COLLABORATION'); END;
    CREATE TRIGGER IF NOT EXISTS private_no_access_update BEFORE UPDATE ON project_access
      WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND project_type='local_private' AND (NEW.access_kind<>'owner' OR NEW.user_id<>user_id))
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_NO_COLLABORATION'); END;
    CREATE TRIGGER IF NOT EXISTS private_no_roadmap BEFORE INSERT ON roadmaps
      WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND project_type='local_private')
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_NO_COLLABORATION'); END;
    CREATE TRIGGER IF NOT EXISTS private_no_codex_thread BEFORE UPDATE OF codex_thread_id ON chats
      WHEN NEW.codex_thread_id IS NOT NULL AND EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND project_type='local_private')
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_NO_CODEX'); END;
    CREATE TRIGGER IF NOT EXISTS private_chat_insert BEFORE INSERT ON chats
      WHEN EXISTS(SELECT 1 FROM projects p WHERE p.id=NEW.project_id AND p.project_type='local_private'
        AND (NEW.user_id<>p.user_id OR NEW.codex_thread_id IS NOT NULL OR NEW.task_id IS NOT NULL OR NEW.purpose<>'normal'))
      BEGIN SELECT RAISE(ABORT,'PRIVATE_CHAT_INVALID'); END;
    CREATE TRIGGER IF NOT EXISTS private_owner_immutable BEFORE UPDATE OF user_id ON projects
      WHEN OLD.project_type='local_private' AND NEW.user_id<>OLD.user_id
      BEGIN SELECT RAISE(ABORT,'PRIVATE_OWNER_IMMUTABLE'); END;
    CREATE TRIGGER IF NOT EXISTS private_task_insert BEFORE INSERT ON tasks
      WHEN EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND project_type='local_private')
      BEGIN SELECT RAISE(ABORT,'PRIVATE_PROJECT_NO_COLLABORATION'); END;
    CREATE TRIGGER IF NOT EXISTS memory_scope_immutable BEFORE UPDATE OF scope_project_id ON user_memories
      WHEN NEW.scope_project_id IS NOT OLD.scope_project_id BEGIN SELECT RAISE(ABORT,'MEMORY_SCOPE_IMMUTABLE'); END;
  `);
  const schema = sql.prepare("SELECT sql FROM sqlite_master WHERE name='turn_approvals'").get()?.sql;
  if (schema && !schema.includes("'web_search'")) {
    sql.exec(`BEGIN IMMEDIATE;
      CREATE TABLE private_approvals_migration (
        id TEXT PRIMARY KEY,turn_run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('command','file','web_search')),item_id TEXT,
        request_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
        created_at TEXT NOT NULL,resolved_at TEXT);
      INSERT INTO private_approvals_migration SELECT * FROM turn_approvals;
      DROP TABLE turn_approvals;
      ALTER TABLE private_approvals_migration RENAME TO turn_approvals;
      CREATE INDEX turn_approvals_chat_idx ON turn_approvals(chat_id,status,created_at DESC);
      COMMIT;`);
  }
}
