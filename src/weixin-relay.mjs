import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.mjs';

export class WeixinRelay {
  constructor({ home, proxyMode }) {
    const compiled = fileURLToPath(new URL('../.tools/weixin-transport.mjs', import.meta.url));
    const pin = JSON.parse(fs.readFileSync(new URL('../tools/weixin/upstream.json', import.meta.url)));
    let manifest; try { manifest = JSON.parse(fs.readFileSync(`${compiled}.json`)); } catch { throw new HttpError(503, 'WEIXIN_TRANSPORT_MISSING', '请先构建固定版本的微信 transport。'); }
    if (manifest.commit !== pin.commit || createHash('sha256').update(fs.readFileSync(compiled)).digest('hex') !== manifest.sha256) throw new HttpError(503, 'WEIXIN_TRANSPORT_INVALID', '微信 transport 完整性校验失败。');
    this.proxyMode = proxyMode; this.pending = new Map();
    this.child = fork(new URL('./weixin-relay-worker.mjs', import.meta.url), [], { cwd: home, execArgv: [],
      env: { HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'zh_CN.UTF-8' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    this.child.on('message', ({ id, result, error }) => {
      const entry = this.pending.get(id); if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(id);
      if (error) entry.reject(new HttpError(502, error, '微信连接失败，请检查网络或重新扫码。')); else entry.resolve(result);
    });
    this.child.on('exit', () => this.rejectAll());
    this.child.on('error', () => this.rejectAll());
  }
  request(op, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HttpError(504, 'WEIXIN_TIMEOUT', '微信响应超时。')); this.stop(); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.child.connected) { this.rejectAll(); return; }
      this.child.send({ id, op, params: { ...params, proxyMode: this.proxyMode } }, error => { if (error) this.rejectAll(); });
    });
  }
  rejectAll() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HttpError(503, 'WEIXIN_DISCONNECTED', '微信连接已断开。')); } this.pending.clear(); }
  stop() { this.child.kill('SIGKILL'); this.rejectAll(); }
}
