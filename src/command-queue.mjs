// Limits launched commands, not all processes owned by the host OS account.
export class CommandQueue {
  constructor(limit = 11) { this.limit = Math.max(1, Math.min(11, limit)); this.active = new Set(); this.waiting = []; }
  run(key, signal, work) {
    return new Promise((resolve, reject) => {
      const entry = { key, signal, work, resolve, reject };
      entry.abort = () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1); signal?.removeEventListener('abort', entry.abort);
        resolve({ ok: false, exitCode: null, output: '命令已取消，未启动。', aborted: true, timedOut: false, truncated: false,
          errorCode: 'COMMAND_ABORTED', retryable: false });
      };
      this.waiting.push(entry); signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
      this.drain();
    });
  }
  drain() {
    while (this.active.size < this.limit) {
      const index = this.waiting.findIndex(entry => !this.active.has(entry.key));
      if (index < 0) return;
      const entry = this.waiting.splice(index, 1)[0];
      entry.signal?.removeEventListener('abort', entry.abort); this.active.add(entry.key);
      Promise.resolve().then(entry.work).then(entry.resolve, entry.reject).finally(() => { this.active.delete(entry.key); this.drain(); });
    }
  }
}
