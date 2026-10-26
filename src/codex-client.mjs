import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { buildSeatbeltProfile } from './sandbox.mjs';
import { resolveOutboundProxy, proxyEnvironment } from './outbound-proxy.mjs';

export const PORTAL_MEMORY_CONFIG = Object.freeze({
  features: Object.freeze({ memories: false }),
  memories: Object.freeze({ generate_memories: false, use_memories: false }),
});

function rpcError(value) {
  const error = new Error(value?.message || 'Codex app-server 请求失败。');
  error.code = value?.code;
  error.data = value?.data;
  return error;
}

export class CodexAppServerClient extends EventEmitter {
  constructor(config, { readProxy } = {}) {
    super();
    this.config = config;
    this.readProxy = readProxy;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.startPromise = null;
    this.started = false;
    this.stopping = false;
    this.lastError = null;
    this.hostMcpNames = [];
  }

  async start() {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start()
      .catch((error) => {
        this.lastError = error;
        throw error;
      })
      .finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async #start() {
    this.stopping = false;
    this.lastError = null;
    // Native HTTP clients do not automatically inherit macOS's system proxy.
    // Resolve once per process launch, including isolated search clients.
    const proxy = await resolveOutboundProxy(this.config, { read: this.readProxy });
    if (this.stopping) throw Object.assign(new Error('Codex 启动已取消。'), { code: 'CODEX_START_CANCELLED' });
    const disabledFeatures = [
      'apps', 'plugins', 'shell_tool', 'unified_exec', 'view_image', 'browser_use',
      'in_app_browser', 'computer_use', 'image_generation',
      'workspace_dependencies', 'skill_search', 'web_search', 'memories',
    ];
    const args = [
      'app-server', '--stdio',
      '-c', `model_provider="${this.config.codexModelProvider}"`,
      '-c', `model_providers.${this.config.codexModelProvider}={name="OpenAI HTTPS",base_url="${this.config.chatgptCodexBaseUrl}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,
      '-c', 'agents.enabled=true',
      '-c', `agents.max_concurrent_threads_per_session=${this.config.maxSubagentsPerRoot}`,
      '-c', `agents.default_subagent_model="${this.config.subagentModel}"`,
      '-c', 'agents.default_subagent_reasoning_effort="medium"',
      '-c', 'memories.generate_memories=false',
      '-c', 'memories.use_memories=false',
    ];
    for (const role of this.config.searchOnly ? [] : ['default', 'worker', 'explorer']) {
      args.push('-c', `agents.${role}.description="Portal-managed Luna subagent"`);
      args.push('-c', `agents.${role}.config_file="${this.config.portalAgentConfig}"`);
    }
    for (const feature of disabledFeatures) {
      if (this.config.searchOnly && !this.config.summaryOnly && feature === 'web_search') continue;
      args.push('--disable', feature);
    }
    if (this.config.searchOnly) args.push('-c', `web_search="${this.config.summaryOnly ? 'disabled' : 'live'}"`, '-c', 'agents.enabled=false',
      '--disable', 'remote_plugin', '--disable', 'tool_suggest');
    // App Server authenticates from local Codex state and does not need Portal,
    // Cloudflare, Git, CI, or arbitrary developer secrets from the web process.
    const childEnv = {};
    for (const key of [
      'HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'TERM',
      'CODEX_HOME', 'XDG_CONFIG_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    ]) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    childEnv.HOME ||= os.homedir();
    childEnv.CODEX_HOME ||= path.join(childEnv.HOME, '.codex');
    let binary = this.config.codexBin;
    let spawnArgs = args;
    if (this.config.searchOnly) {
      // Dedicated search process sees only its disposable auth/state directory,
      // never the Portal database, workspaces, DSH sessions or user Codex home.
      for (const key of Object.keys(childEnv)) delete childEnv[key];
      Object.assign(childEnv, { HOME: this.config.rootDir, CODEX_HOME: this.config.rootDir,
        TMPDIR: this.config.rootDir, PATH: '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin', LANG: 'en_US.UTF-8' });
      const metadata = [];
      for (let dir = path.dirname(this.config.codexBin); ; dir = path.dirname(dir)) { metadata.push(dir); if (dir === path.dirname(dir)) break; }
      for (let dir = this.config.rootDir; ; dir = path.dirname(dir)) { metadata.push(dir); if (dir === path.dirname(dir)) break; }
      const nodeRuntimeDir = path.dirname(process.execPath);
      const scriptFixture = /\.(?:c|m)?js$/u.test(this.config.codexBin);
      if (scriptFixture) {
        for (let dir = nodeRuntimeDir; ; dir = path.dirname(dir)) { metadata.push(dir); if (dir === path.dirname(dir)) break; }
      }
      const profile = buildSeatbeltProfile({ writableRoots: [this.config.rootDir],
        readableRoots: [path.dirname(this.config.codexBin), ...(scriptFixture ? [nodeRuntimeDir] : [])],
        readableMetadataPaths: metadata, networkAccess: true });
      binary = '/usr/bin/sandbox-exec';
      spawnArgs = ['-p', profile, ...(scriptFixture ? [process.execPath, this.config.codexBin] : [this.config.codexBin]), ...args];
    }
    // Apply after the search-only environment reset. Never inherit stale host
    // proxy overrides (especially ALL_PROXY/NO_PROXY) over OUTBOUND_PROXY.
    Object.assign(childEnv, proxyEnvironment(proxy));
    this.process = spawn(binary, spawnArgs, {
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
      const error = this.lastError || new Error(`Codex app-server 已退出 (code=${code}, signal=${signal})`);
      this.lastError = error;
      this.started = false;
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.emit('exit', error);
    });
    readline.createInterface({ input: this.process.stdout }).on('line', (line) => this.#handleLine(line));
    const initialized = await this.request('initialize', {
      clientInfo: { name: 'codex_harness_remote', title: 'Codex Harness Remote', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 30_000);
    const versionMarker = `/${this.config.codexCliVersion} `;
    if (!String(initialized.userAgent || '').includes(versionMarker)) {
      const actual = String(initialized.userAgent || 'unknown');
      const error = new Error(`Codex 协议版本不匹配：需要 ${this.config.codexCliVersion}，实际 ${actual}`);
      error.code = 'CODEX_PROTOCOL_VERSION_MISMATCH';
      this.lastError = error;
      try { this.process?.kill('SIGTERM'); } catch { /* already stopped */ }
      throw error;
    }
    this.notify('initialized', {});
    const effective = await this.request('config/read', { includeLayers: false }, 15_000);
    this.hostMcpNames = Object.keys(effective?.config?.mcp_servers || {});
    const memories = effective?.config?.memories;
    const features = effective?.config?.features;
    if (features?.memories !== false || memories?.generate_memories !== false || memories?.use_memories !== false) {
      const error = new Error('Codex 原生长期记忆未被完全关闭；Portal 拒绝进入 ready。');
      error.code = 'CODEX_NATIVE_MEMORY_ENABLED';
      this.lastError = error;
      try { this.process?.kill('SIGTERM'); } catch { /* already stopped */ }
      throw error;
    }
    if (this.config.searchOnly && (effective?.config?.web_search !== (this.config.summaryOnly ? 'disabled' : 'live') || Object.values(effective?.config?.mcp_servers || {}).some((server) => server.enabled !== false))) {
      const error = new Error('专用搜索配置不符合隔离要求。');
      error.code = 'CODEX_SEARCH_CONFIG_UNSAFE';
      this.lastError = error;
      this.stop();
      throw error;
    }
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
    if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      // User-level MCP entries are independent of the apps/plugins feature
      // switches. Never give a Portal thread the host's personal MCP tools.
      const names = new Set([...this.hostMcpNames, ...Object.keys(params.config?.mcp_servers || {})]);
      params = { ...params, config: { ...params.config,
        mcp_servers: Object.fromEntries([...names].map(name => [name, { enabled: false }])) } };
    }
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
