import { CodexSearchService } from './codex-search-service.mjs';

// Business snapshots, deliberately separate from the metadata-only event journal.
export function migrateToolDetails(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS tool_details (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES turn_runs(id) ON DELETE CASCADE,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    call_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
    UNIQUE(run_id, call_id));
    CREATE INDEX IF NOT EXISTS tool_details_revision ON tool_details(chat_id,run_id,revision);`);
}

export function redactToolText(text) {
  return String(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]')
    .replace(/\bBearer\s+[^\s"'\\]+/gi, 'Bearer [REDACTED]')
    .replace(/(--(?:token|password|api-key|secret)\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]{30,}(?:\.[\w-]+){0,2})/g, '[REDACTED TOKEN]')
    .replace(/((?:["']?(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie)["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1"[REDACTED]"');
}
function textOf(value) {
  if (value === undefined) return '';
  const text = redactToolText(typeof value === 'string' ? value : JSON.stringify(value, (key, v) =>
    /^(password|passwd|secret|api[_-]?key|.*token|authorization|cookie|private[_-]?key)$/i.test(key) ? '[REDACTED]' : v, 2));
  const max = 4 * 1024 * 1024;
  return text.length > max ? `${text.slice(0, max)}\n[明细超过 4 Mi 字符，已截断]` : text;
}
export class ToolDetailsService {
  constructor({ db, config, summarize }) {
    this.db = db; this.config = config; this.queue = []; this.busy = false; this.stopped = false;
    this.cloud = new CodexSearchService(config);
    this.summarize = summarize || ((text, signal, metering) => this.cloud.summarize(text, signal, metering));
    this.revision = Number(db.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM tool_details').get().n);
    // Restart never replays cloud requests or pretends a interrupted tool succeeded.
    for (const row of db.db.prepare("SELECT * FROM tool_details WHERE json_extract(payload,'$.status')='running' OR json_extract(payload,'$.summaryStatus')='pending'").all()) {
      const item = JSON.parse(row.payload);
      if (item.status === 'running' || item.summaryStatus === 'pending') {
        if (item.status === 'running') item.status = 'interrupted';
        if (item.summaryStatus === 'pending') item.summaryStatus = 'unavailable';
        this.save(row.run_id, row.chat_id, row.call_id, item);
      }
    }
  }
  authorized(run, expectedAccessId) {
    if (!run) return false;
    const chat = this.db.getChat(run.chatId), user = this.db.getUserById(run.userId);
    const project = chat && user?.status === 'active' && this.db.getProjectForUser(chat.projectId, user.id);
    return chat?.userId === run.userId && project?.accessId === chat.projectAccessId
      && (!expectedAccessId || expectedAccessId === chat.projectAccessId);
  }
  save(runId, chatId, callId, item) {
    this.db.db.prepare(`INSERT INTO tool_details(run_id,chat_id,call_id,revision,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(run_id,call_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`)
      .run(runId, chatId, callId, ++this.revision, JSON.stringify(item));
  }
  capture(runId, chatId, event, data) {
    if (this.stopped) return;
    if (String(data.name || data.item?.tool || '').startsWith('browser_')) return;
    const run = this.db.getTurnRun(runId);
    if (!this.authorized(run)) return;
    if (event === 'turn_error' || event === 'turn_completed') {
      for (const row of this.db.db.prepare('SELECT * FROM tool_details WHERE run_id=?').all(runId)) {
        const item = JSON.parse(row.payload);
        if (item.status === 'running') { item.status = 'interrupted'; item.endedAt = Date.now(); this.save(runId, chatId, row.call_id, item); }
      }
      return;
    }
    let callId = data.callId, name = data.name, input = data.arguments, result = data.result;
    let done = event === 'tool_completed', success = data.success !== false;
    if (event === 'native_item' || event === 'subagent_updated') {
      const native = data.item || {};
      if (!['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'collabAgentToolCall'].includes(native.type)) return;
      callId = native.id; name = native.tool || native.type; done = data.phase === 'completed';
      input = native.command ? { command: native.command, cwd: native.cwd } : native.arguments ?? native.action ?? native.changes;
      result = done ? { output: native.aggregatedOutput, exitCode: native.exitCode, result: native.result ?? native.changes ?? native.agentsStates, error: native.error, status: native.status } : undefined;
      success = !['failed', 'declined'].includes(native.status) && !native.error;
    } else if (!['tool_started', 'tool_completed'].includes(event)) return;
    if (!callId) return;
    const old = this.db.db.prepare('SELECT payload FROM tool_details WHERE run_id=? AND call_id=?').get(runId, callId);
    const item = old ? JSON.parse(old.payload) : { callId, name: name || '工具调用', startedAt: Date.now(), status: 'running', input: '', output: '', summary: '', summaryStatus: 'none' };
    if (item.status !== 'running') return; // native duplicate completion cannot overwrite tool result
    const memory = String(name || item.name).startsWith('memory_');
    if (name) item.name = name;
    if (input !== undefined) item.input = memory ? '[记忆正文不复制到工具明细，请在我的记忆查看]' : textOf(input);
    if (done) {
      const failed = !success || result?.error || result?.success === false || (result?.exitCode != null && result.exitCode !== 0) || result?.timedOut || result?.signal;
      item.status = failed ? 'failed' : 'completed'; item.endedAt = Date.now();
      item.exitCode = result?.exitCode ?? null;
      item.output = memory ? '[记忆结果不复制到工具明细]' : textOf(result);
      const privateProject = this.db.getProject(run.projectId)?.projectType === 'local_private';
      item.summaryStatus = privateProject || memory ? 'disabled' : this.queue.length >= 64 ? 'unavailable' : 'pending';
      if (item.summaryStatus === 'pending') this.queue.push({ runId, chatId, callId, accessId: this.db.getChat(chatId).projectAccessId });
    }
    this.save(runId, chatId, callId, item);
    if (done) this.schedule();
  }
  list(chatId, runId, after = 0) {
    const rows = this.db.db.prepare('SELECT * FROM tool_details WHERE chat_id=? AND run_id=? AND revision>? ORDER BY revision LIMIT 5').all(chatId, runId, after);
    return { items: rows.map(r => ({ ...JSON.parse(r.payload), id: r.id })), cursor: rows.at(-1)?.revision || after, hasMore: rows.length === 5 };
  }
  schedule() {
    if (this.timer || this.busy || this.stopped || !this.queue.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 250);
    this.timer.unref?.();
  }
  async flush() {
    if (this.stopped || this.busy || !this.queue.length) return;
    this.busy = true;
    const batch = [], first = this.queue[0];
    while (this.queue.length && batch.length < 6 && this.queue[0].runId === first?.runId) batch.push(this.queue.shift());
    this.controller = new AbortController();
    const timer = setTimeout(() => this.controller?.abort(), 25000);
    try {
      const run = first && this.db.getTurnRun(first.runId);
      if (!this.authorized(run, first.accessId) || this.db.getProject(run.projectId)?.projectType !== 'standard') return;
      const items = batch.map(job => JSON.parse(this.db.db.prepare('SELECT payload FROM tool_details WHERE run_id=? AND call_id=?').get(job.runId, job.callId).payload));
      // One short bounded batch, no transcript, project name, paths to extra files or memory.
      const input = JSON.stringify(items.map((item, index) => ({ index, name: item.name, status: item.status, exitCode: item.exitCode,
        input: item.input.slice(0, 1200), output: item.output.slice(0, 1800) })));
      const answer = await this.summarize(input, this.controller.signal, { ledger: this.db.tokenUsage, user: this.db.getUserById(run.userId),
        projectId: run.projectId, chatId: run.chatId, runId: run.id });
      if (this.stopped || this.controller.signal.aborted || !this.authorized(run, first.accessId)) return;
      const parsed = JSON.parse(answer.text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      for (let index = 0; index < batch.length; index++) {
        const summary = parsed.find?.(x => x.index === index)?.summary;
        if (typeof summary !== 'string' || !summary.trim()) continue;
        const item = items[index]; item.summary = redactToolText(summary).slice(0, 240); item.summaryStatus = 'ready';
        this.save(batch[index].runId, batch[index].chatId, batch[index].callId, item);
      }
    } catch { /* Optional summary failure never enters execution or logs. */ }
    finally {
      clearTimeout(timer);
      if (!this.stopped) for (const job of batch) {
        const row = this.db.db.prepare('SELECT payload FROM tool_details WHERE run_id=? AND call_id=?').get(job.runId, job.callId);
        if (!row) continue;
        const item = JSON.parse(row.payload);
        if (item.summaryStatus === 'pending') { item.summaryStatus = 'unavailable'; this.save(job.runId, job.chatId, job.callId, item); }
      }
      this.busy = false; this.schedule();
    }
  }
  stop() { this.stopped = true; clearTimeout(this.timer); this.queue = []; this.controller?.abort(); this.cloud.stop(); }
}
