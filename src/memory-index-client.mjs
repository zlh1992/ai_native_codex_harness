import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

export class MemoryIndexClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map();
    this.state = config.memoryEnabled ? 'starting' : 'disabled';
    this.lastError = null;
  }

  start() {
    if (!this.config.memoryEnabled || this.process) return this.state === 'ready';
    if (!fs.existsSync(this.config.memoryPython)) {
      this.state = 'degraded';
      this.lastError = new Error('memsearch Python 环境未安装，使用 SQLite 关键词召回。');
      return false;
    }
    const childEnv = {};
    for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']) if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    childEnv.HF_HOME = this.config.memoryModelCacheRoot;
    childEnv.HF_HUB_CACHE = this.config.memoryModelCacheRoot;
    childEnv.HF_HUB_DISABLE_TELEMETRY = '1';
    childEnv.TOKENIZERS_PARALLELISM = 'false';
    this.process = spawn(this.config.memoryPython, [this.config.memoryIndexWorker, this.config.memoryIndexRoot,
      this.config.memoryEmbeddingModel, this.config.memoryEmbeddingRevision], {
      cwd: this.config.rootDir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => this.emit('log', { level: 'warn', message: String(chunk).trim().slice(0, 1000) }));
    readline.createInterface({ input: this.process.stdout }).on('line', (line) => this.#line(line));
    this.process.on('exit', () => {
      const error = this.lastError || new Error('memsearch 索引进程已退出。');
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear(); this.process = null; this.state = 'degraded'; this.lastError = error;
    });
    this.process.on('error', (cause) => {
      const error = Object.assign(new Error('memsearch 索引进程无法启动。'), {
        code: cause?.code || 'MEMORY_INDEX_SPAWN_FAILED',
      });
      this.lastError = error;
      this.state = 'degraded';
    });
    this.state = 'ready';
    return true;
  }

  #line(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = this.pending.get(message.id);
    if (!item) return;
    this.pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(Object.assign(new Error(message.error.message || 'memsearch 请求失败。'), { code: message.error.code }));
    else item.resolve(message.result);
  }

  request(method, params = {}, timeoutMs = this.config.memoryRecallTimeoutMs) {
    if (!this.start() || !this.process?.stdin?.writable) return Promise.reject(this.lastError || new Error('memsearch unavailable'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`memsearch 请求超时: ${method}`), { code: 'MEMORY_INDEX_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  index(userId) { return this.request('index', { userId }, this.config.memoryIndexTimeoutMs); }
  search(userId, query, topK) { return this.request('search', { userId, query, topK }); }
  stop() { try { this.process?.kill('SIGTERM'); } catch { /* already stopped */ } }
  status() {
    return { state: this.state, available: this.state === 'ready',
      lastErrorCode: this.lastError ? String(this.lastError.code || 'MEMORY_INDEX_UNAVAILABLE').slice(0, 80) : null };
  }
}
