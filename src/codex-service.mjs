import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { CodexAppServerClient } from './codex-client.mjs';
import { HttpError, invariant } from './errors.mjs';
import { runSandboxedCommand } from './sandbox.mjs';

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

const DYNAMIC_TOOLS = Object.freeze([
  {
    type: 'function', name: 'workspace_list',
    description: 'List files and directories inside this user project. Paths are project-relative.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, max_depth: { type: 'integer', minimum: 1, maximum: 12 } }, additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_read_file',
    description: 'Read a UTF-8 text file inside this user project.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_write_file',
    description: 'Create or completely overwrite a UTF-8 text file inside this user project.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_replace_in_file',
    description: 'Replace one exact text occurrence in a project file. Fails unless the old text occurs exactly once.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_make_directory',
    description: 'Create a directory and any missing parents inside this user project.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_delete',
    description: 'Move a file or directory to this user workspace trash. The operation is recoverable by the super admin.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_search',
    description: 'Search for literal text in UTF-8 files inside this user project.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    type: 'function', name: 'workspace_exec',
    description: 'Run a shell command in this user project. The host enforces a macOS sandbox, time/output limits, a secret-free environment, and the user network policy.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'], additionalProperties: false },
  },
]);

function toolResult(value) {
  return [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function messageText(input) {
  return String(input || '').trim();
}

function countOccurrences(text, search) {
  if (!search) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(search, offset)) !== -1) { count += 1; offset += search.length; }
  return count;
}

export class CodexService extends EventEmitter {
  constructor({ config, db, workspace }) {
    super();
    this.config = config;
    this.db = db;
    this.workspace = workspace;
    this.client = new CodexAppServerClient(config);
    this.loadedThreads = new Set();
    this.contextByThread = new Map();
    this.activeByChat = new Map();
    this.activeByThread = new Map();
    this.pendingChats = new Set();
    this.pendingByUser = new Map();
    this.globalPending = 0;
    this.globalActive = 0;
    this.client.on('notification', (message) => this.#onNotification(message));
    this.client.on('serverRequest', (message) => this.#onServerRequest(message));
    this.client.on('exit', (error) => this.#onExit(error));
    this.client.on('log', (record) => this.emit('log', record));
  }

  async start() { await this.client.start(); }
  stop() { this.client.stop(); }

  status() {
    return {
      ready: this.client.started,
      model: this.config.codexModel,
      activeTurns: this.globalActive,
      pendingTurns: this.globalPending,
      maxConcurrentTurns: this.config.codexMaxConcurrentTurns,
      lastError: this.client.lastError?.message || null,
    };
  }

  #instructions(context) {
    const projectRoot = this.workspace.projectRoot(context.project);
    return [
      'You are the coding agent inside Codex Harness Remote.',
      `The only authorized workspace for this conversation is: ${projectRoot}`,
      'Use only the workspace_* dynamic tools supplied by the host for files, search, deletion, and commands.',
      'Do not use or request any Codex built-in shell, patch, filesystem, browser, app, plugin, MCP, computer-use, or multi-agent tool.',
      'Never attempt to inspect host credentials, Codex state, environment secrets, parent directories, or another user workspace.',
      'All tool paths must be relative to the authorized project. The host will reject escapes and symlinks.',
      `Outbound network access for this user is ${context.user.networkAccess ? 'enabled' : 'disabled'}.`,
      'Explain meaningful changes and verify work with the available project tools.',
    ].join('\n');
  }

  async #ensureThread(context) {
    await this.client.start();
    const existing = context.chat.codexThreadId;
    if (existing && !this.loadedThreads.has(existing)) {
      try {
        const resumed = await this.client.request('thread/resume', {
          threadId: existing,
          model: this.config.codexModel,
          modelProvider: this.config.codexModelProvider,
          cwd: this.workspace.projectRoot(context.project),
          approvalPolicy: 'never',
          sandbox: 'read-only',
          baseInstructions: this.#instructions(context),
          dynamicTools: DYNAMIC_TOOLS,
        });
        invariant(resumed.thread?.modelProvider === this.config.codexModelProvider, 409, 'CODEX_PROVIDER_MISMATCH', '旧会话使用了不同的 Codex provider。');
        this.loadedThreads.add(existing);
        this.contextByThread.set(existing, context);
        return existing;
      } catch (error) {
        this.emit('log', { level: 'warn', message: `恢复 Codex thread 失败，将创建新 thread: ${error.message}` });
      }
    }
    if (existing && this.loadedThreads.has(existing)) {
      this.contextByThread.set(existing, context);
      return existing;
    }
    const result = await this.client.request('thread/start', {
      ephemeral: false,
      model: this.config.codexModel,
      modelProvider: this.config.codexModelProvider,
      cwd: this.workspace.projectRoot(context.project),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      serviceName: 'codex-harness-remote',
      baseInstructions: this.#instructions(context),
      dynamicTools: DYNAMIC_TOOLS,
    });
    const threadId = result.thread.id;
    this.loadedThreads.add(threadId);
    this.contextByThread.set(threadId, context);
    this.db.updateChat(context.chat.id, { codexThreadId: threadId });
    this.client.request('thread/name/set', { threadId, name: context.chat.title }, 10_000).catch(() => {});
    return threadId;
  }

  async runTurn({ chat, project, user, prompt, effort, emit }) {
    const text = messageText(prompt);
    invariant(text.length > 0 && text.length <= 100_000, 400, 'INVALID_PROMPT', '消息长度必须为 1–100000 个字符。');
    invariant(!this.activeByChat.has(chat.id) && !this.pendingChats.has(chat.id), 409, 'TURN_ALREADY_RUNNING', '该对话已有任务在运行。');
    invariant(this.globalActive + this.globalPending < this.config.codexMaxConcurrentTurns, 429, 'CODEX_BUSY', '本机 Codex 并发已满，请稍后重试。');
    const userActive = [...this.activeByChat.values()].filter((entry) => entry.user.id === user.id).length;
    const userPending = this.pendingByUser.get(user.id) || 0;
    invariant(userActive + userPending < user.maxConcurrentTurns, 429, 'USER_CONCURRENCY_LIMIT', '已达到该用户的并发任务上限。');
    const reasoningEffort = EFFORTS.has(effort) ? effort : this.config.codexReasoningEffort;
    const context = { chat, project, user };
    this.pendingChats.add(chat.id);
    this.globalPending += 1;
    this.pendingByUser.set(user.id, userPending + 1);
    let threadId;
    try {
      threadId = await this.#ensureThread(context);
    } finally {
      this.pendingChats.delete(chat.id);
      this.globalPending = Math.max(0, this.globalPending - 1);
      const remaining = Math.max(0, (this.pendingByUser.get(user.id) || 1) - 1);
      if (remaining) this.pendingByUser.set(user.id, remaining);
      else this.pendingByUser.delete(user.id);
    }
    const refreshedUser = this.db.getUserById(user.id);
    invariant(refreshedUser?.status === 'active', 403, 'USER_DISABLED', '该用户已停用。');
    invariant(refreshedUser.networkAccess === user.networkAccess, 409, 'USER_POLICY_CHANGED', '用户网络策略已变化，请重新提交任务。');
    const refreshedProject = this.db.getProjectForUser(project.id, refreshedUser.id);
    invariant(refreshedProject && refreshedProject.accessId === project.accessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已撤销。');
    const refreshedActive = [...this.activeByChat.values()].filter((entry) => entry.user.id === refreshedUser.id).length;
    invariant(refreshedActive < refreshedUser.maxConcurrentTurns, 429, 'USER_CONCURRENCY_LIMIT', '已达到该用户的并发任务上限。');
    context.user = refreshedUser;
    context.project = refreshedProject;
    this.contextByThread.set(threadId, context);
    const active = {
      chat, project: refreshedProject, user: refreshedUser, threadId, turnId: null, emit,
      assistantText: '', agentItemsWithDelta: new Set(), completed: false,
      commandControllers: new Set(),
      resolve: null, reject: null,
    };
    const completion = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    this.activeByChat.set(chat.id, active);
    this.activeByThread.set(threadId, active);
    this.contextByThread.set(threadId, context);
    this.globalActive += 1;
    this.db.updateChat(chat.id, { status: 'running' });
    this.db.addMessage({ chatId: chat.id, role: 'user', content: text });
    active.emit('turn_status', { status: 'starting', threadId });
    try {
      const result = await this.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text }],
        cwd: this.workspace.projectRoot(refreshedProject),
        model: this.config.codexModel,
        effort: reasoningEffort,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      active.turnId = result.turn.id;
      active.emit('turn_status', { status: 'running', turnId: active.turnId, threadId });
    } catch (error) {
      this.#finish(active, error);
    }
    return completion;
  }

  async interrupt(chatId) {
    const active = this.activeByChat.get(chatId);
    if (!active) return false;
    for (const controller of active.commandControllers) controller.abort();
    if (active.turnId) await this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000);
    return true;
  }

  async interruptUser(userId) {
    const targets = [...this.activeByChat.values()].filter((active) => active.user.id === userId);
    for (const active of targets) for (const controller of active.commandControllers) controller.abort();
    await Promise.allSettled(targets.map((active) => active.turnId
      ? this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000)
      : Promise.resolve()));
    return targets.length;
  }

  #emit(active, event, data) {
    try { active.emit(event, data); } catch { /* disconnected browser; persistence continues */ }
  }

  #onNotification(message) {
    const params = message.params || {};
    const active = params.threadId ? this.activeByThread.get(params.threadId) : null;
    if (!active) return;
    if (message.method === 'item/agentMessage/delta') {
      active.agentItemsWithDelta.add(params.itemId);
      active.assistantText += params.delta || '';
      this.#emit(active, 'assistant_delta', { delta: params.delta || '' });
      return;
    }
    if (message.method === 'item/plan/delta') {
      this.#emit(active, 'plan_delta', { delta: params.delta || '' });
      return;
    }
    if (message.method === 'item/reasoning/summaryTextDelta') {
      this.#emit(active, 'reasoning_delta', { delta: params.delta || '' });
      return;
    }
    if (message.method === 'item/started') {
      const item = params.item || {};
      if (item.type === 'commandExecution' || item.type === 'fileChange') {
        this.#emit(active, 'security_warning', { message: `拦截到不应出现的内置工具: ${item.type}` });
      }
      return;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (!active.agentItemsWithDelta.has(params.item.id) && params.item.text) {
        active.assistantText += params.item.text;
        this.#emit(active, 'assistant_delta', { delta: params.item.text });
      }
      return;
    }
    if (message.method === 'thread/tokenUsage/updated') {
      this.#emit(active, 'usage', { tokenUsage: params.tokenUsage || null });
      return;
    }
    if (message.method === 'error') {
      this.#emit(active, 'codex_error', { message: params.error?.message || params.message || 'Codex 发生错误。' });
      return;
    }
    if (message.method === 'turn/completed') {
      const status = params.turn?.status;
      if (status === 'completed') this.#finish(active, null, params.turn);
      else this.#finish(active, new Error(params.turn?.error?.message || `Codex turn 状态: ${status}`), params.turn);
    }
  }

  #onServerRequest(message) {
    if (message.method === 'item/tool/call') {
      const active = this.activeByThread.get(message.params?.threadId);
      if (!active) {
        this.client.respondError(message.id, -32602, 'Unknown or inactive tenant thread');
        return;
      }
      this.#executeTool(active, message).catch((error) => {
        this.client.respond(message.id, { contentItems: toolResult({ error: error.message }), success: false });
      });
      return;
    }
    if (message.method.includes('requestApproval') || message.method === 'applyPatchApproval' || message.method === 'execCommandApproval') {
      this.client.respond(message.id, { decision: 'decline' });
      return;
    }
    this.client.respondError(message.id, -32601, `Codex Harness 不支持服务端请求: ${message.method}`);
  }

  async #executeTool(active, message) {
    const params = message.params || {};
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const name = params.tool;
    this.#emit(active, 'tool_started', { callId: params.callId, name, arguments: args });
    let result;
    try {
      result = await this.#callTool(active, name, args);
      this.client.respond(message.id, { contentItems: toolResult(result), success: true });
      this.#emit(active, 'tool_completed', { callId: params.callId, name, result });
      this.db.addMessage({
        chatId: active.chat.id, turnId: active.turnId, role: 'event', kind: 'tool',
        content: name, metadata: { arguments: args, result },
      });
    } catch (error) {
      const value = { error: error instanceof Error ? error.message : String(error) };
      this.client.respond(message.id, { contentItems: toolResult(value), success: false });
      this.#emit(active, 'tool_completed', { callId: params.callId, name, result: value, success: false });
    }
  }

  #assertQuota(active, nextBytes, previousBytes = 0) {
    const usage = this.workspace.usageForUser(active.user.id, this.db.listProjectsForUser(active.user.id));
    invariant(usage.bytes - previousBytes + nextBytes <= active.user.maxStorageBytes, 413, 'STORAGE_QUOTA', '写入将超过用户存储配额。');
  }

  async #callTool(active, name, args) {
    const { user } = active;
    const project = this.db.getProjectForUser(active.project.id, user.id);
    invariant(project && project.accessId === active.project.accessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已撤销。');
    if (name === 'workspace_list') {
      return this.workspace.tree(project, args.path || '', Math.min(12, Math.max(1, Number(args.max_depth) || 5)));
    }
    if (name === 'workspace_read_file') return this.workspace.readFile(project, args.path);
    if (name === 'workspace_write_file') {
      let previous = 0;
      try { previous = fs.statSync(this.workspace.resolve(project, args.path, { mustExist: true }).target).size; } catch { /* new file */ }
      this.#assertQuota(active, Buffer.byteLength(String(args.content)), previous);
      return this.workspace.writeFile(project, args.path, args.content);
    }
    if (name === 'workspace_replace_in_file') {
      const file = this.workspace.readFile(project, args.path);
      const occurrences = countOccurrences(file.content, String(args.old_text));
      invariant(occurrences === 1, 409, 'REPLACE_AMBIGUOUS', `old_text 出现 ${occurrences} 次，必须恰好出现一次。`);
      const content = file.content.replace(String(args.old_text), String(args.new_text));
      this.#assertQuota(active, Buffer.byteLength(content), file.size);
      return this.workspace.writeFile(project, args.path, content);
    }
    if (name === 'workspace_make_directory') return this.workspace.makeDirectory(project, args.path);
    if (name === 'workspace_delete') return this.workspace.moveToTrash(project, args.path);
    if (name === 'workspace_search') {
      const query = String(args.query || '');
      invariant(query && query.length <= 1000, 400, 'INVALID_SEARCH', '搜索文本长度必须为 1–1000。');
      const tree = this.workspace.tree(project, args.path || '', 20, 3000);
      const matches = [];
      for (const entry of tree.entries) {
        if (entry.type !== 'file' || entry.size > 1024 * 1024) continue;
        let file;
        try { file = this.workspace.readFile(project, entry.path); } catch { continue; }
        file.content.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < 200 && line.includes(query)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
        });
        if (matches.length >= 200) break;
      }
      return { query, matches, truncated: matches.length >= 200 };
    }
    if (name === 'workspace_exec') {
      const command = String(args.command || '');
      invariant(command.length > 0 && command.length <= 50_000, 400, 'INVALID_COMMAND', '命令长度必须为 1–50000。');
      const controller = new AbortController();
      active.commandControllers.add(controller);
      let result;
      try {
        result = await runSandboxedCommand({
          config: this.config, workspace: this.workspace, project, user, command, cwd: args.cwd || '', signal: controller.signal,
        });
      } finally {
        active.commandControllers.delete(controller);
      }
      const usage = this.workspace.usageForUser(user.id, this.db.listProjectsForUser(user.id));
      return { ...result, storageBytes: usage.bytes, storageQuotaBytes: user.maxStorageBytes };
    }
    throw new HttpError(400, 'UNKNOWN_TOOL', `未知工作区工具: ${name}`);
  }

  #finish(active, error = null, turn = null) {
    if (active.completed) return;
    active.completed = true;
    for (const controller of active.commandControllers) controller.abort();
    this.activeByChat.delete(active.chat.id);
    this.activeByThread.delete(active.threadId);
    this.globalActive = Math.max(0, this.globalActive - 1);
    this.db.updateChat(active.chat.id, { status: 'idle' });
    if (active.assistantText) {
      this.db.addMessage({
        chatId: active.chat.id, turnId: active.turnId, role: 'assistant',
        content: active.assistantText, metadata: { model: this.config.codexModel, status: turn?.status || (error ? 'failed' : 'completed') },
      });
    }
    if (error) {
      this.db.addMessage({ chatId: active.chat.id, turnId: active.turnId, role: 'error', content: error.message });
      this.#emit(active, 'turn_error', { message: error.message });
      error.turnEventEmitted = true;
      active.reject(error);
    } else {
      this.#emit(active, 'turn_completed', { turnId: active.turnId, status: turn?.status || 'completed' });
      active.resolve({ text: active.assistantText, turn });
    }
  }

  #onExit(error) {
    this.loadedThreads.clear();
    this.contextByThread.clear();
    for (const active of [...this.activeByChat.values()]) this.#finish(active, error);
  }
}

export { DYNAMIC_TOOLS, EFFORTS };
