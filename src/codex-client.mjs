import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

function rpcError(value) {
  const error = new Error(value?.message || 'Codex app-server 请求失败。');
  error.code = value?.code;
  error.data = value?.data;
  return error;
}

export class CodexAppServerClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.started = false;
    this.stopping = false;
    this.lastError = null;
  }

  async start() {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start() {
    const disabledFeatures = [
      'apps', 'plugins', 'shell_tool', 'unified_exec', 'view_image', 'browser_use',
      'in_app_browser', 'computer_use', 'image_generation', 'multi_agent',
      'workspace_dependencies', 'skill_search', 'web_search',
    ];
    const args = [
      'app-server', '--stdio',
      '-c', `model_provider="${this.config.codexModelProvider}"`,
      '-c', `model_providers.${this.config.codexModelProvider}={name="OpenAI HTTPS",base_url="${this.config.chatgptCodexBaseUrl}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
    ];
    for (const feature of disabledFeatures) args.push('--disable', feature);
    this.stopping = false;
    this.lastError = null;
    const childEnv = { ...process.env };
    for (const key of Object.keys(childEnv)) {
      if (/^(ADMIN_PASSWORD|CODEX_HARNESS_ADMIN_PASSWORD|PUBLIC_TUNNEL_TOKEN|CLOUDFLARE_API_TOKEN)$/i.test(key)) delete childEnv[key];
    }
    this.process = spawn(this.config.codexBin, args, {
      cwd: this.config.rootDir,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk) => {
      const value = String(chunk).trim();
      if (value) this.emit('log', { level: 'warn', message: value.slice(0, 4000) });
    });
    this.process.on('exit', (code, signal) => {
      const error = new Error(`Codex app-server 已退出 (code=${code}, signal=${signal})`);
      this.lastError = error;
      this.started = false;
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.emit('exit', error);
    });
    readline.createInterface({ input: this.process.stdout }).on('line', (line) => this.#handleLine(line));
    await this.request('initialize', {
      clientInfo: { name: 'codex_harness_remote', title: 'Codex Harness Remote', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    this.notify('initialized', {});
    this.started = true;
    this.emit('ready');
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch {
      this.emit('log', { level: 'warn', message: `忽略 app-server 非 JSON 输出: ${String(line).slice(0, 500)}` });
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) this.emit('serverRequest', message);
    else if (message.method) this.emit('notification', message);
  }

  write(message) {
    if (!this.process?.stdin?.writable) throw this.lastError || new Error('Codex app-server 尚未就绪。');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, timeoutMs = this.config.codexRequestTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ method, id, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  respondError(id, code, message) { this.write({ id, error: { code, message } }); }

  stop() {
    this.stopping = true;
    try { this.process?.kill('SIGTERM'); } catch { /* already stopped */ }
  }
}
