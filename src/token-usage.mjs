import { randomUUID } from 'node:crypto';
import { invariant } from './errors.mjs';

const fields = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningOutputTokens', 'totalTokens'];
const zero = () => Object.fromEntries(fields.map(key => [key, 0]));
const valid = value => Number.isSafeInteger(value) && value >= 0;
const stamp = () => new Date().toISOString();
export function normalizeUsage(value, engine = 'gpt') {
  if (!value || !valid(value.inputTokens) || !valid(value.outputTokens)) return null;
  const cached = value.cachedInputTokens ?? value.cacheReadTokens ?? 0;
  const written = value.cacheWriteInputTokens ?? value.cacheWriteTokens ?? 0;
  const input = value.inputTokens + (engine === 'qwen' ? cached + written : 0);
  const result = { inputTokens: input, outputTokens: value.outputTokens, cachedInputTokens: cached,
    cacheWriteInputTokens: written, reasoningOutputTokens: value.reasoningOutputTokens ?? 0,
    totalTokens: engine === 'gpt' ? value.totalTokens ?? input + value.outputTokens : input + value.outputTokens };
  return fields.every(key => valid(result[key])) ? result : null;
}
export function beijingDay(date = Date.now()) { return new Date(new Date(date).getTime() + 8 * 3600000).toISOString().slice(0, 10); }

// No foreign keys to content tables: deleting a chat must not delete measured consumption.
export class TokenUsageLedger {
  constructor(sql) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS token_usage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS token_usage_calls(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT NOT NULL,project_id TEXT,chat_id TEXT,run_id TEXT,
        engine TEXT NOT NULL,model TEXT NOT NULL,effort TEXT,kind TEXT NOT NULL,
        stream_id TEXT,native_turn_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        counts_json TEXT NOT NULL,reported INTEGER NOT NULL DEFAULT 0,uncertain INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS token_usage_native_idx ON token_usage_calls(stream_id,native_turn_id)
        WHERE native_turn_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS token_usage_date_idx ON token_usage_calls(created_at,user_id,engine,model);
      CREATE INDEX IF NOT EXISTS token_usage_run_idx ON token_usage_calls(run_id);
      CREATE TABLE IF NOT EXISTS token_usage_streams(id TEXT PRIMARY KEY,counts_json TEXT);
      CREATE TABLE IF NOT EXISTS token_usage_samples(stream_id TEXT NOT NULL,turn_id TEXT NOT NULL,counts_json TEXT NOT NULL,
        PRIMARY KEY(stream_id,turn_id,counts_json));`);
    // Rename rows written by pre-Qwen builds without losing historical usage.
    sql.prepare("UPDATE token_usage_calls SET engine='qwen' WHERE engine='deepseek'").run();
    sql.prepare('INSERT OR IGNORE INTO token_usage_meta VALUES(?,?)').run('started_at', stamp());
  }
  recover() { this.sql.prepare('UPDATE token_usage_calls SET uncertain=1,finished=1 WHERE finished=0').run(); }
  start({ id = randomUUID(), user, projectId = null, chatId = null, runId = null, engine = 'gpt', model, effort = null, kind = 'root', streamId = null, turnId = null }) {
    this.sql.prepare(`INSERT OR IGNORE INTO token_usage_calls
      (id,user_id,role,project_id,chat_id,run_id,engine,model,effort,kind,stream_id,native_turn_id,created_at,updated_at,counts_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, user.role, projectId, chatId, runId, engine, model, effort, kind, streamId, turnId, stamp(), stamp(), JSON.stringify(zero()));
    return id;
  }
  stream(id, fresh = false) {
    this.sql.prepare('INSERT OR IGNORE INTO token_usage_streams VALUES(?,?)').run(id, fresh ? JSON.stringify(zero()) : null);
  }
  bind(id, streamId, turnId) {
    if (!turnId) return;
    this.sql.prepare('UPDATE token_usage_calls SET stream_id=?,native_turn_id=? WHERE id=? AND (native_turn_id IS NULL OR native_turn_id=?)').run(streamId, turnId, id, turnId);
  }
  find(streamId, turnId) { return this.sql.prepare('SELECT * FROM token_usage_calls WHERE stream_id=? AND native_turn_id=?').get(streamId, turnId); }
  finish(id, uncertain = false) {
    this.sql.prepare('UPDATE token_usage_calls SET finished=1,uncertain=MAX(uncertain,?),updated_at=? WHERE id=?').run(Number(uncertain), stamp(), id);
  }
  // The adapter returns a replacement cumulative sample for one model request.
  sample(id, usage, engine = 'qwen') {
    const counts = normalizeUsage(usage, engine);
    if (!counts) return;
    this.sql.prepare('UPDATE token_usage_calls SET counts_json=?,reported=1,updated_at=? WHERE id=?').run(JSON.stringify(counts), stamp(), id);
  }
  codex(params, callId = null) {
    const { threadId, turnId, tokenUsage } = params;
    const stream = this.sql.prepare('SELECT * FROM token_usage_streams WHERE id=?').get(threadId);
    if (!stream) return; // Never capture unrelated desktop/CLI threads.
    const total = normalizeUsage(tokenUsage?.total), last = normalizeUsage(tokenUsage?.last);
    if (!total) return;
    const row = (turnId && this.find(threadId, turnId)) || (callId && this.sql.prepare('SELECT * FROM token_usage_calls WHERE id=?').get(callId));
    // An idle resume notification is a baseline only, not a new charge.
    if (!row) {
      if (!stream.counts_json) this.sql.prepare('UPDATE token_usage_streams SET counts_json=? WHERE id=?').run(JSON.stringify(total), threadId);
      return;
    }
    if (callId && turnId && !row.native_turn_id) this.bind(callId, threadId, turnId);
    const serialized = JSON.stringify(total);
    if (this.sql.prepare('SELECT 1 FROM token_usage_samples WHERE stream_id=? AND turn_id=? AND counts_json=?').get(threadId, turnId || '', serialized)) return;
    const previous = stream.counts_json ? JSON.parse(stream.counts_json) : null;
    const reset = previous && total.totalTokens < previous.totalTokens;
    if (reset) {
      this.sql.prepare('UPDATE token_usage_calls SET uncertain=1 WHERE id=?').run(row.id);
      return; // Out-of-order/reset samples cannot reduce the high-water mark or be charged twice.
    }
    const delta = previous && !reset ? Object.fromEntries(fields.map(key => [key, Math.max(0, total[key] - previous[key])])) : last || zero();
    const counts = JSON.parse(row.counts_json);
    for (const key of fields) counts[key] += delta[key];
    this.sql.exec('SAVEPOINT token_sample');
    try {
      this.sql.prepare('INSERT OR IGNORE INTO token_usage_samples VALUES(?,?,?)').run(threadId, turnId || '', serialized);
      this.sql.prepare('UPDATE token_usage_calls SET counts_json=?,reported=1,uncertain=MAX(uncertain,?),updated_at=? WHERE id=?')
        .run(JSON.stringify(counts), Number(!previous || Boolean(reset)), stamp(), row.id);
      // Keep the cumulative high-water mark in the same transaction as the charge.
      this.sql.prepare('UPDATE token_usage_streams SET counts_json=? WHERE id=?').run(JSON.stringify(total), threadId);
      this.sql.exec('RELEASE token_sample');
    } catch (error) { this.sql.exec('ROLLBACK TO token_sample; RELEASE token_sample'); throw error; }
  }
  dashboard(query = {}, now = Date.now()) {
    const end = query.to || beijingDay(now), start = query.from || beijingDay(new Date(end + 'T00:00:00+08:00').getTime() - 6 * 86400000);
    for (const value of [start, end]) invariant(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value), 400, 'INVALID_USAGE_RANGE', '日期必须为有效的 YYYY-MM-DD。');
    const from = new Date(start + 'T00:00:00+08:00').toISOString(), until = new Date(Date.parse(end + 'T00:00:00+08:00') + 86400000).toISOString();
    invariant(from < until && Date.parse(until) - Date.parse(from) <= 366 * 86400000, 400, 'INVALID_USAGE_RANGE', '查询范围须为 1–366 天。');
    invariant(!query.engine || ['gpt', 'qwen'].includes(query.engine), 400, 'INVALID_USAGE_ENGINE', '引擎筛选无效。');
    const clauses = ['created_at>=?', 'created_at<?'], args = [from, until];
    for (const [key, column] of [['userId','user_id'], ['engine','engine'], ['model','model']]) if (query[key]) {
      invariant(typeof query[key] === 'string' && query[key].length <= 150, 400, 'INVALID_USAGE_FILTER', '筛选值无效。');
      clauses.push(`${column}=?`); args.push(query[key]);
    }
    const rows = this.sql.prepare(`SELECT * FROM token_usage_calls WHERE ${clauses.join(' AND ')}`).all(...args);
    const bucket = () => ({ ...zero(), calls: 0, missingCalls: 0, incompleteCalls: 0, pendingCalls: 0 });
    const add = (target, row) => {
      const counts = JSON.parse(row.counts_json); for (const key of fields) target[key] += counts[key];
      target.calls++; target.missingCalls += Number(!row.reported); target.incompleteCalls += Number(!row.reported || row.uncertain || !row.finished); target.pendingCalls += Number(!row.finished);
    };
    const totals = { gpt: bucket(), bossGpt: bucket(), employeeGpt: bucket(), qwen: bucket() };
    const days = new Map(), users = new Map(), models = new Map(), kinds = new Map();
    for (let time = Date.parse(from); time < Date.parse(until); time += 86400000) days.set(beijingDay(time), { date: beijingDay(time), gpt: bucket(), qwen: bucket() });
    for (const row of rows) {
      add(totals[row.engine], row); if (row.engine === 'gpt') add(totals[row.role === 'admin' ? 'bossGpt' : 'employeeGpt'], row);
      add(days.get(beijingDay(row.created_at))[row.engine], row);
      if (row.role === 'user' && row.engine === 'gpt') { if (!users.has(row.user_id)) users.set(row.user_id, { userId: row.user_id, ...bucket() }); add(users.get(row.user_id), row); }
      const modelKey = `${row.engine}:${row.model}:${row.effort || ''}`;
      if (!models.has(modelKey)) models.set(modelKey, { engine: row.engine, model: row.model, effort: row.effort, ...bucket() }); add(models.get(modelKey), row);
      const kindKey = `${row.engine}:${row.kind}`;
      if (!kinds.has(kindKey)) kinds.set(kindKey, { engine: row.engine, kind: row.kind, ...bucket() }); add(kinds.get(kindKey), row);
    }
    const employees = this.sql.prepare("SELECT id,display_name,username FROM users WHERE role='user'").all();
    for (const user of employees) {
      if (query.userId && query.userId !== user.id) continue;
      if (!users.has(user.id)) users.set(user.id, { userId: user.id, ...bucket() });
      Object.assign(users.get(user.id), { displayName: user.display_name, username: user.username });
    }
    return { from: start, to: end, timezone: 'Asia/Shanghai', startedAt: this.sql.prepare("SELECT value FROM token_usage_meta WHERE key='started_at'").get().value,
      updatedAt: stamp(), totals, days: [...days.values()], employees: [...users.values()].sort((a,b) => b.totalTokens-a.totalTokens),
      models: [...models.values()].sort((a,b) => b.totalTokens-a.totalTokens), kinds: [...kinds.values()],
      availableModels: this.sql.prepare('SELECT DISTINCT model FROM token_usage_calls ORDER BY model').all().map(row => row.model) };
  }
}
