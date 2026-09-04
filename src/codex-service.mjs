import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CodexAppServerClient } from './codex-client.mjs';
import { CapacityService } from './capacity-service.mjs';
import { HttpError, invariant } from './errors.mjs';
import { runSandboxedCommand } from './sandbox.mjs';

const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
const TURN_MODES = new Set(['edit', 'execute']);

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
    this.capacity = new CapacityService({
      db, maxRootTurns: config.portalMaxActiveRootTurns,
      maxExecuteLeases: config.portalMaxExecuteLeases, leaseTtlMs: config.executionLeaseTtlMs,
    });
    this.loadedThreads = new Set();
    this.contextByThread = new Map();
    this.activeByChat = new Map();
    this.activeByThread = new Map();
    this.parentBySubagent = new Map();
    this.pendingChats = new Set();
    this.pendingByUser = new Map();
    this.pendingApprovals = new Map();
    this.skillsReady = false;
    this.globalPending = 0;
    this.globalActive = 0;
    this.client.on('notification', (message) => this.#onNotification(message));
    this.client.on('serverRequest', (message) => {
      this.#onServerRequest(message).catch((error) => {
        this.emit('log', { level: 'warn', message: `处理 Codex 服务端请求失败: ${error.message}` });
        if (message.method === 'item/tool/call') {
          this.client.respondError(message.id, -32603, 'Portal failed to validate the tenant thread');
        } else {
          this.client.respond(message.id, { decision: 'decline' });
        }
      });
    });
    this.client.on('exit', (error) => this.#onExit(error));
    this.client.on('log', (record) => this.emit('log', record));
  }

  async start() {
    await this.client.start();
    await this.#ensurePortalSkills();
  }
  stop() { this.client.stop(); }

  status() {
    return {
      ready: this.client.started,
      model: this.config.codexModel,
      activeTurns: this.globalActive,
      pendingTurns: this.globalPending,
      maxConcurrentTurns: this.config.codexMaxConcurrentTurns,
      ...this.capacity.status(),
      maxSubagentsPerRoot: this.config.maxSubagentsPerRoot,
      subagentModel: this.config.subagentModel,
      lastError: this.client.lastError?.message || null,
    };
  }

  #instructions(context) {
    const projectRoot = this.workspace.projectRoot(context.project);
    return [
      'You are the coding agent inside Codex Harness Remote.',
      `The only authorized workspace for this conversation is: ${projectRoot}`,
      'Use the host workspace_* tools for reads, whole-file writes, search, deletion, and approved commands; use the native apply_patch tool for focused edits.',
      'The built-in shell, browser, app, plugin, MCP, computer-use, and web tools are unavailable.',
      'workspace_exec is authorized only when the current Portal turn mode is EXECUTE; in EDIT mode it will be rejected.',
      `You may use native subagents when useful, but at most ${this.config.maxSubagentsPerRoot} may be active for this root thread and every spawned subagent must use ${this.config.subagentModel}.`,
      'Never request another subagent model. Explicit model overrides are forbidden by Portal policy.',
      'Never attempt to inspect host credentials, Codex state, environment secrets, parent directories, or another user workspace.',
      'All tool paths must be relative to the authorized project. The host will reject escapes and symlinks.',
      `Outbound network access for this user is ${context.user.networkAccess ? 'enabled' : 'disabled'}.`,
      'Explain meaningful changes and verify work with the available project tools.',
    ].join('\n');
  }

  #assertProjectAgentPolicy(project) {
    const root = this.workspace.projectRoot(project);
    const agentsDir = path.join(root, '.codex', 'agents');
    invariant(!fs.existsSync(agentsDir), 409, 'PROJECT_AGENT_POLICY', '项目内自定义 agent 已禁用；员工子代理必须使用 Portal 的 Luna 配置。');
    const projectConfig = path.join(root, '.codex', 'config.toml');
    if (!fs.existsSync(projectConfig)) return;
    const stat = fs.lstatSync(projectConfig);
    invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 409, 'PROJECT_AGENT_POLICY', '项目 Codex 配置文件不安全。');
    const source = fs.readFileSync(projectConfig, 'utf8');
    invariant(!/^\s*(?:\[\s*agents(?:\s*[.\]])|agents\s*=)/m.test(source), 409, 'PROJECT_AGENT_POLICY', '项目不能覆盖 Portal 的子代理策略。');
  }

  async #ensureThread(context) {
    await this.client.start();
    await this.#ensurePortalSkills();
    const existing = context.chat.codexThreadId;
    if (existing && !this.loadedThreads.has(existing)) {
      try {
        const resumed = await this.client.request('thread/resume', {
          threadId: existing,
          model: this.config.codexModel,
          modelProvider: this.config.codexModelProvider,
          cwd: this.workspace.projectRoot(context.project),
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
          sandbox: 'workspace-write',
          baseInstructions: this.#instructions(context),
          dynamicTools: DYNAMIC_TOOLS,
        });
        invariant(resumed.thread?.modelProvider === this.config.codexModelProvider, 409, 'CODEX_PROVIDER_MISMATCH', '旧会话使用了不同的 Codex provider。');
        this.loadedThreads.add(existing);
        this.contextByThread.set(existing, context);
        await this.#syncTaskGoal(existing, context);
        return existing;
      } catch (error) {
        this.emit('log', { level: 'warn', message: `恢复 Codex thread 失败，将创建新 thread: ${error.message}` });
      }
    }
    if (existing && this.loadedThreads.has(existing)) {
      this.contextByThread.set(existing, context);
      await this.#syncTaskGoal(existing, context);
      return existing;
    }
    const result = await this.client.request('thread/start', {
      ephemeral: false,
      model: this.config.codexModel,
      modelProvider: this.config.codexModelProvider,
      cwd: this.workspace.projectRoot(context.project),
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      serviceName: 'codex-harness-remote',
      baseInstructions: this.#instructions(context),
      dynamicTools: DYNAMIC_TOOLS,
    });
    const threadId = result.thread.id;
    this.loadedThreads.add(threadId);
    this.contextByThread.set(threadId, context);
    this.db.updateChat(context.chat.id, { codexThreadId: threadId });
    this.client.request('thread/name/set', { threadId, name: context.chat.title }, 10_000).catch(() => {});
    await this.#syncTaskGoal(threadId, context);
    return threadId;
  }

  async #syncTaskGoal(threadId, context) {
    if (!context.chat.taskId) return;
    const task = this.db.getTaskForUser(context.chat.taskId, context.user.id);
    invariant(task && task.projectId === context.project.id && task.version === context.chat.taskVersion, 409, 'TASK_STALE', '任务已变化，请从任务列表重新进入。');
    const objective = `${task.title}\n\n验收标准：\n${task.acceptance}`.slice(0, 4000);
    // A paused native goal remains persisted and visible to Codex without starting
    // unleased automatic continuation turns behind the Portal scheduler.
    await this.client.request('thread/goal/set', { threadId, objective, status: 'paused' }, 15_000);
  }

  async #ensurePortalSkills() {
    if (this.skillsReady) return;
    await this.client.request('skills/extraRoots/set', { extraRoots: [this.config.portalSkillsRoot] }, 15_000);
    this.skillsReady = true;
  }

  async #taskSkillInput(context) {
    if (!context.chat.taskId) return [];
    const cwd = this.workspace.projectRoot(context.project);
    const result = await this.client.request('skills/list', { cwds: [cwd], forceReload: false }, 15_000);
    const expected = path.join(this.config.portalSkillsRoot, 'task-execution', 'SKILL.md');
    const discovered = (result.data || []).flatMap((entry) => entry.skills || [])
      .find((skill) => skill.name === 'task-execution' && path.resolve(String(skill.path)) === path.resolve(expected) && skill.enabled);
    invariant(discovered, 500, 'TASK_SKILL_MISSING', 'Portal 任务执行 skill 未被 Codex 发现。');
    return [{ type: 'skill', name: discovered.name, path: discovered.path }];
  }

  async runTurn({ chat, project, user, prompt, effort, mode = 'edit', emit }) {
    const text = messageText(prompt);
    invariant(text.length > 0 && text.length <= 100_000, 400, 'INVALID_PROMPT', '消息长度必须为 1–100000 个字符。');
    invariant(TURN_MODES.has(mode), 400, 'INVALID_TURN_MODE', '任务模式必须是 EDIT 或 EXECUTE。');
    invariant(!this.activeByChat.has(chat.id) && !this.pendingChats.has(chat.id), 409, 'TURN_ALREADY_RUNNING', '该对话已有任务在运行。');
    invariant(this.globalActive + this.globalPending < this.config.codexMaxConcurrentTurns, 429, 'CODEX_BUSY', '本机 Codex 并发已满，请稍后重试。');
    const userActive = [...this.activeByChat.values()].filter((entry) => entry.user.id === user.id).length;
    const userPending = this.pendingByUser.get(user.id) || 0;
    invariant(userActive + userPending < user.maxConcurrentTurns, 429, 'USER_CONCURRENCY_LIMIT', '已达到该用户的并发任务上限。');
    const reasoningEffort = EFFORTS.has(effort) ? effort : this.config.codexReasoningEffort;
    if (chat.taskId) {
      const task = this.db.getTaskForUser(chat.taskId, user.id);
      invariant(task && task.projectId === project.id, 403, 'TASK_FORBIDDEN', '任务不存在或不属于你。');
      invariant(task.version === chat.taskVersion && ['active', 'rework'].includes(task.status), 409, 'TASK_STALE', '任务已提交或版本已变化，请刷新任务列表。');
    }
    this.#assertProjectAgentPolicy(project);
    const turnRun = this.db.createTurnRun({ chat, project, userId: user.id, mode });
    const context = { chat, project, user, mode, turnRunId: turnRun.id };
    this.pendingChats.add(chat.id);
    this.globalPending += 1;
    this.pendingByUser.set(user.id, userPending + 1);
    const clearPending = () => {
      this.pendingChats.delete(chat.id);
      this.globalPending = Math.max(0, this.globalPending - 1);
      const remaining = Math.max(0, (this.pendingByUser.get(user.id) || 1) - 1);
      if (remaining) this.pendingByUser.set(user.id, remaining);
      else this.pendingByUser.delete(user.id);
    };
    let threadId;
    let capacityToken;
    try {
      capacityToken = await this.capacity.acquire({
        turnRunId: turnRun.id, chatId: chat.id, userId: user.id, mode,
        onQueue: (position) => emit('turn_queued', {
          turnRunId: turnRun.id, position, mode: mode.toUpperCase(),
          executeLeases: this.capacity.status().activeExecuteLeases,
          maxExecuteLeases: this.capacity.status().maxExecuteLeases,
        }),
      });
      threadId = await this.#ensureThread(context);
    } catch (error) {
      capacityToken?.release();
      const latest = this.db.getTurnRun(turnRun.id);
      if (!['cancelled', 'interrupted'].includes(latest?.status)) this.db.updateTurnRun(turnRun.id, {
        status: 'failed', errorMessage: error.message, completedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      clearPending();
    }
    let refreshedUser;
    let refreshedProject;
    try {
      refreshedUser = this.db.getUserById(user.id);
      invariant(refreshedUser?.status === 'active', 403, 'USER_DISABLED', '该用户已停用。');
      invariant(refreshedUser.networkAccess === user.networkAccess, 409, 'USER_POLICY_CHANGED', '用户网络策略已变化，请重新提交任务。');
      refreshedProject = this.db.getProjectForUser(project.id, refreshedUser.id);
      invariant(refreshedProject && refreshedProject.accessId === project.accessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已撤销。');
      const refreshedActive = [...this.activeByChat.values()].filter((entry) => entry.user.id === refreshedUser.id).length;
      invariant(refreshedActive < refreshedUser.maxConcurrentTurns, 429, 'USER_CONCURRENCY_LIMIT', '已达到该用户的并发任务上限。');
    } catch (error) {
      capacityToken.release();
      this.db.updateTurnRun(turnRun.id, { status: 'failed', errorMessage: error.message, completedAt: new Date().toISOString() });
      throw error;
    }
    context.user = refreshedUser;
    context.project = refreshedProject;
    this.contextByThread.set(threadId, context);
    const active = {
      chat, project: refreshedProject, user: refreshedUser, threadId, turnId: null, emit,
      turnRunId: turnRun.id, mode, capacityToken,
      assistantText: '', agentItemsWithDelta: new Set(), completed: false,
      finalItemId: null, diff: '', plan: [], subagentThreadIds: new Set(),
      commandControllers: new Set(), turnTimer: null,
      resolve: null, reject: null,
    };
    const completion = new Promise((resolve, reject) => { active.resolve = resolve; active.reject = reject; });
    this.activeByChat.set(chat.id, active);
    this.activeByThread.set(threadId, active);
    this.contextByThread.set(threadId, context);
    this.globalActive += 1;
    this.db.updateChat(chat.id, { status: 'running' });
    this.db.updateTurnRun(turnRun.id, { status: 'starting', codexThreadId: threadId });
    active.emit('turn_status', { status: 'starting', threadId, turnRunId: turnRun.id, mode: mode.toUpperCase() });
    try {
      const skillInput = await this.#taskSkillInput(context);
      const result = await this.client.request('turn/start', {
        threadId,
        input: [
          { type: 'text', text: `<!-- portal-mode:${mode.toUpperCase()} -->\n${chat.taskId ? '$task-execution\n' : ''}${text}`, text_elements: [] },
          ...skillInput,
        ],
        cwd: this.workspace.projectRoot(refreshedProject),
        model: this.config.codexModel,
        effort: reasoningEffort,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandboxPolicy: {
          type: 'workspaceWrite', writableRoots: [this.workspace.projectRoot(refreshedProject)],
          networkAccess: Boolean(refreshedUser.networkAccess), excludeTmpdirEnvVar: true, excludeSlashTmp: true,
        },
      });
      active.turnId = result.turn.id;
      this.db.updateTurnRun(turnRun.id, { status: 'running', codexTurnId: active.turnId });
      active.emit('turn_status', { status: 'running', turnId: active.turnId, threadId, turnRunId: turnRun.id, mode: mode.toUpperCase() });
      if (!active.completed) {
        active.turnTimer = setTimeout(() => {
          const error = new HttpError(408, 'TURN_TIMEOUT', 'Codex 任务超过允许时长，已停止并释放容量。');
          this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000).catch(() => {});
          this.#finish(active, error);
        }, this.config.codexRequestTimeoutMs);
        active.turnTimer.unref?.();
      }
    } catch (error) {
      this.#finish(active, error);
    }
    return completion;
  }

  async interrupt(chatId) {
    if (this.capacity.cancelChat(chatId)) return true;
    const active = this.activeByChat.get(chatId);
    if (!active) return false;
    for (const controller of active.commandControllers) controller.abort();
    this.#cancelApprovalsForActive(active);
    if (active.turnId) await this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000);
    return true;
  }

  async interruptUser(userId) {
    const queued = this.capacity.cancelUser(userId);
    const targets = [...this.activeByChat.values()].filter((active) => active.user.id === userId);
    for (const active of targets) {
      for (const controller of active.commandControllers) controller.abort();
      this.#cancelApprovalsForActive(active);
    }
    await Promise.allSettled(targets.map((active) => active.turnId
      ? this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000)
      : Promise.resolve()));
    return targets.length + queued;
  }

  pendingApprovalsForChat(chatId, userId) {
    return this.db.listPendingApprovals(chatId, userId).map((approval) => ({
      ...approval,
      request: this.#publicApprovalRequest(approval.request),
    }));
  }

  resolveApproval({ chatId, userId, approvalId, decision }) {
    invariant(['accept', 'decline', 'cancel'].includes(decision), 400, 'INVALID_APPROVAL_DECISION', '批准决定无效。');
    const approval = this.db.getApproval(approvalId);
    invariant(approval && approval.chatId === chatId && approval.userId === userId, 403, 'APPROVAL_FORBIDDEN', '批准请求不存在或不属于你。');
    invariant(approval.status === 'pending', 409, 'APPROVAL_RESOLVED', '批准请求已处理。');
    const pending = this.pendingApprovals.get(approvalId);
    invariant(pending, 409, 'APPROVAL_EXPIRED', '批准请求已失效，请刷新对话。');
    const active = this.activeByChat.get(chatId);
    invariant(active && active.turnRunId === approval.turnRunId, 409, 'TURN_NOT_RUNNING', '对应任务已不在运行。');
    if (decision === 'accept' && approval.kind === 'command') {
      invariant(active.mode === 'execute', 403, 'EXECUTE_MODE_REQUIRED', 'EDIT 模式不能批准命令执行。');
    }
    this.pendingApprovals.delete(approvalId);
    const status = decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'cancelled';
    const resolved = this.db.resolveApproval(approvalId, status);
    if (pending.rpcId !== undefined) this.client.respond(pending.rpcId, { decision });
    else pending.resolve(decision);
    this.#emit(active, 'approval_resolved', { approvalId, decision });
    return { ...resolved, request: this.#publicApprovalRequest(resolved.request) };
  }

  async getGoal(chat) {
    if (!chat.codexThreadId) return null;
    await this.client.start();
    const result = await this.client.request('thread/goal/get', { threadId: chat.codexThreadId }, 15_000);
    return result.goal || null;
  }

  async historyForChat(chat) {
    if (!chat.codexThreadId) return this.db.listMessages(chat.id);
    try {
      await this.client.start();
      const result = await this.client.request('thread/read', { threadId: chat.codexThreadId, includeTurns: true }, 30_000);
      const messages = [];
      const runs = this.db.listTurnRunsForChat(chat.id, 500).reverse();
      const usedRuns = new Set();
      for (const turn of result.thread?.turns || []) {
        const finalText = [...(turn.items || [])].reverse().find((item) => item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null))?.text;
        const run = this.db.getTurnRunByCodexTurn(turn.id)
          || runs.find((candidate) => !usedRuns.has(candidate.id) && candidate.codexThreadId === chat.codexThreadId
            && candidate.finalReplySnapshot && candidate.finalReplySnapshot === finalText)
          || runs.find((candidate) => !usedRuns.has(candidate.id) && candidate.codexThreadId === chat.codexThreadId);
        if (run) usedRuns.add(run.id);
        for (const item of turn.items || []) {
          if (item.type === 'userMessage') {
            const content = (item.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
              .replace(/^<!-- portal-mode:(?:EDIT|EXECUTE) -->\n/, '').replace(/^\$task-execution\n/, '');
            messages.push({
              id: item.id, chatId: chat.id, turnId: turn.id, role: 'user', kind: 'message', content,
              metadata: { turnRunId: run?.id || null, mode: run?.mode || null }, createdAt: run?.createdAt || null,
            });
          }
          if (item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null)) {
            messages.push({
              id: item.id, chatId: chat.id, turnId: turn.id, role: 'assistant', kind: 'message', content: item.text || '',
              metadata: {
                turnRunId: run?.id || null, finalItemId: run?.finalItemId || item.id, taskId: run?.taskId || null,
                taskVersion: run?.taskVersion || null, diffSnapshot: run?.diffSnapshot || '', plan: run?.plan || [],
                status: turn.status,
              },
              createdAt: run?.completedAt || run?.createdAt || null,
            });
          }
        }
      }
      return messages;
    } catch (error) {
      this.emit('log', { level: 'warn', message: `读取 Codex thread 历史失败，回退旧缓存: ${error.message}` });
      return this.db.listMessages(chat.id);
    }
  }

  #emit(active, event, data) {
    try { active.emit(event, data); } catch { /* disconnected browser; persistence continues */ }
  }

  #trackSubagentItem(active, item, phase) {
    // App Server may surface the child id first on a later wait/send item rather
    // than on spawnAgent, so count every observed receiver id for this root.
    for (const id of item.receiverThreadIds || []) active.subagentThreadIds.add(id);
    const violatesModel = item.model && item.model !== this.config.subagentModel;
    const violatesCount = active.subagentThreadIds.size > this.config.maxSubagentsPerRoot;
    this.db.updateTurnRun(active.turnRunId, { subagentCount: active.subagentThreadIds.size });
    this.#emit(active, 'subagent_updated', {
      phase, item, count: active.subagentThreadIds.size, limit: this.config.maxSubagentsPerRoot,
      model: item.model || this.config.subagentModel,
    });
    if (violatesModel || violatesCount) {
      const reason = violatesModel
        ? `子代理模型必须是 ${this.config.subagentModel}，已阻断 ${item.model}。`
        : `每个主任务最多 ${this.config.maxSubagentsPerRoot} 个子代理。`;
      this.#emit(active, 'security_warning', { message: reason });
      this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000).catch(() => {});
    }
  }

  #trackSubagentThread(active, thread) {
    if (!thread?.id) return;
    active.subagentThreadIds.add(thread.id);
    this.parentBySubagent.set(thread.id, active);
    const violatesCount = active.subagentThreadIds.size > this.config.maxSubagentsPerRoot;
    this.db.updateTurnRun(active.turnRunId, { subagentCount: active.subagentThreadIds.size });
    this.#emit(active, 'subagent_updated', {
      phase: 'started', item: { type: 'subagentThread', id: thread.id, role: thread.agentRole || null },
      count: active.subagentThreadIds.size, limit: this.config.maxSubagentsPerRoot, model: this.config.subagentModel,
    });
    if (violatesCount) {
      this.#emit(active, 'security_warning', { message: `每个主任务最多 ${this.config.maxSubagentsPerRoot} 个子代理。` });
      this.client.request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, 15_000).catch(() => {});
    }
  }

  async #activeForTenantThread(threadId) {
    if (!threadId) return null;
    const direct = this.activeByThread.get(threadId) || this.parentBySubagent.get(threadId);
    if (direct) return direct;

    // Native subagents call dynamic tools with their child thread id. Resolve
    // the persisted parent chain and accept it only when that chain terminates
    // at a root turn that is currently owned and scheduled by this Portal.
    const lineage = [];
    const visited = new Set();
    let cursor = threadId;
    for (let depth = 0; depth <= this.config.maxSubagentsPerRoot + 1; depth += 1) {
      if (visited.has(cursor)) return null;
      visited.add(cursor);
      const response = await this.client.request('thread/read', { threadId: cursor, includeTurns: false }, 15_000);
      const thread = response.thread;
      if (!thread || thread.id !== cursor || !thread.parentThreadId) return null;
      lineage.push(thread);
      const active = this.activeByThread.get(thread.parentThreadId) || this.parentBySubagent.get(thread.parentThreadId);
      if (active) {
        for (const child of lineage.reverse()) this.#trackSubagentThread(active, child);
        return active;
      }
      cursor = thread.parentThreadId;
    }
    return null;
  }

  #onNotification(message) {
    const params = message.params || {};
    if (message.method === 'thread/started' && params.thread?.parentThreadId) {
      const parent = this.activeByThread.get(params.thread.parentThreadId);
      if (parent) this.#trackSubagentThread(parent, params.thread);
      return;
    }
    if (message.method === 'thread/settings/updated' && this.parentBySubagent.has(params.threadId)) {
      const parent = this.parentBySubagent.get(params.threadId);
      const model = params.threadSettings?.model;
      this.#emit(parent, 'subagent_updated', {
        phase: 'settings', item: { type: 'subagentThread', id: params.threadId },
        count: parent.subagentThreadIds.size, limit: this.config.maxSubagentsPerRoot, model: model || this.config.subagentModel,
      });
      if (model && model !== this.config.subagentModel) {
        this.#emit(parent, 'security_warning', { message: `子代理模型必须是 ${this.config.subagentModel}，已阻断 ${model}。` });
        this.client.request('turn/interrupt', { threadId: parent.threadId, turnId: parent.turnId }, 15_000).catch(() => {});
      }
      return;
    }
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
    if (message.method === 'turn/plan/updated') {
      active.plan = Array.isArray(params.plan) ? params.plan : [];
      this.db.updateTurnRun(active.turnRunId, { plan: active.plan });
      this.#emit(active, 'plan_updated', { explanation: params.explanation || '', plan: active.plan });
      return;
    }
    if (message.method === 'turn/diff/updated') {
      active.diff = String(params.diff || '');
      this.db.updateTurnRun(active.turnRunId, { diffSnapshot: active.diff });
      this.#emit(active, 'diff_updated', { diff: active.diff });
      return;
    }
    if (message.method === 'item/reasoning/summaryTextDelta') {
      this.#emit(active, 'reasoning_delta', { delta: params.delta || '' });
      return;
    }
    if (message.method === 'item/started') {
      const item = params.item || {};
      if (item.type === 'commandExecution' || item.type === 'fileChange' || item.type === 'dynamicToolCall') {
        this.#emit(active, 'native_item', { phase: 'started', item });
      }
      if (item.type === 'collabAgentToolCall') {
        this.#trackSubagentItem(active, item, 'started');
      }
      return;
    }
    if (message.method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (!active.agentItemsWithDelta.has(params.item.id) && params.item.text) {
        active.assistantText += params.item.text;
        this.#emit(active, 'assistant_delta', { delta: params.item.text });
      }
      if (params.item.phase === 'final_answer' || params.item.phase == null) {
        active.finalItemId = params.item.id;
        active.finalReply = String(params.item.text || active.assistantText || '');
        this.db.updateTurnRun(active.turnRunId, {
          finalItemId: active.finalItemId, finalReplySnapshot: active.finalReply,
        });
        this.#emit(active, 'final_item', {
          turnRunId: active.turnRunId, turnId: active.turnId, itemId: active.finalItemId,
          taskId: active.chat.taskId || null, taskVersion: active.chat.taskVersion || null,
        });
      }
      return;
    }
    if (message.method === 'item/completed' && ['commandExecution', 'fileChange', 'dynamicToolCall', 'collabAgentToolCall'].includes(params.item?.type)) {
      if (params.item.type === 'collabAgentToolCall') this.#trackSubagentItem(active, params.item, 'completed');
      else this.#emit(active, 'native_item', { phase: 'completed', item: params.item });
      return;
    }
    if (message.method === 'item/commandExecution/outputDelta') {
      this.#emit(active, 'command_output', { itemId: params.itemId, delta: params.delta || '' });
      return;
    }
    if (message.method === 'thread/goal/updated' || message.method === 'thread/goal/cleared') {
      this.#emit(active, 'goal_updated', { goal: params.goal || null });
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      this.#emit(active, 'approval_resolved', { requestId: params.requestId || null });
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

  async #onServerRequest(message) {
    if (message.method === 'item/tool/call') {
      const active = await this.#activeForTenantThread(message.params?.threadId);
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
      const active = await this.#activeForTenantThread(message.params?.threadId);
      if (!active) {
        this.client.respond(message.id, { decision: 'decline' });
        return;
      }
      const kind = message.method.toLowerCase().includes('file') || message.method === 'applyPatchApproval' ? 'file' : 'command';
      if (!this.#approvalPathAllowed(active, kind, message.params || {}) || (kind === 'command' && active.mode !== 'execute')) {
        this.client.respond(message.id, { decision: 'decline' });
        this.#emit(active, 'security_warning', { message: 'Portal 已拒绝越界路径或错误模式的批准请求。' });
        return;
      }
      const approvalId = `rpc:${message.id}`;
      const request = this.#publicApprovalRequest(message.params || {});
      this.db.createApproval({
        id: approvalId, turnRunId: active.turnRunId, chatId: active.chat.id, userId: active.user.id,
        kind, itemId: message.params?.itemId || null, request,
      });
      this.pendingApprovals.set(approvalId, { rpcId: message.id, active, kind });
      this.#emit(active, 'approval_required', { approvalId, kind, request });
      return;
    }
    this.client.respondError(message.id, -32601, `Codex Harness 不支持服务端请求: ${message.method}`);
  }

  #publicApprovalRequest(request) {
    return {
      itemId: request.itemId || null,
      reason: String(request.reason || '').slice(0, 2000),
      command: request.command ? String(request.command).slice(0, 50_000) : null,
      cwd: request.cwd ? String(request.cwd) : null,
      commandActions: Array.isArray(request.commandActions) ? request.commandActions.slice(0, 50) : null,
      grantRoot: request.grantRoot ? String(request.grantRoot) : null,
      networkApprovalContext: request.networkApprovalContext || null,
    };
  }

  #approvalPathAllowed(active, kind, request) {
    const root = path.resolve(this.workspace.projectRoot(active.project));
    const candidate = kind === 'file' ? request.grantRoot : request.cwd;
    if (!candidate) return true;
    const resolved = path.resolve(String(candidate));
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  }

  #requestPortalApproval(active, kind, request) {
    const approvalId = `portal:${randomUUID()}`;
    const safeRequest = this.#publicApprovalRequest(request);
    this.db.createApproval({
      id: approvalId, turnRunId: active.turnRunId, chatId: active.chat.id, userId: active.user.id,
      kind, itemId: request.itemId || null, request: safeRequest,
    });
    return new Promise((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, active, kind });
      this.#emit(active, 'approval_required', { approvalId, kind, request: safeRequest });
    });
  }

  #cancelApprovalsForActive(active) {
    for (const [approvalId, pending] of this.pendingApprovals) {
      if (pending.active !== active) continue;
      this.pendingApprovals.delete(approvalId);
      this.db.resolveApproval(approvalId, 'cancelled');
      if (pending.rpcId !== undefined) {
        try { Promise.resolve(this.client.respond(pending.rpcId, { decision: 'cancel' })).catch(() => {}); } catch { /* process already exited */ }
      }
      else pending.resolve('cancel');
      this.#emit(active, 'approval_resolved', { approvalId, decision: 'cancel' });
    }
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
      invariant(active.mode === 'execute', 403, 'EXECUTE_MODE_REQUIRED', 'EDIT 模式禁止执行命令；请切换到 EXECUTE 后重试。');
      const command = String(args.command || '');
      invariant(command.length > 0 && command.length <= 50_000, 400, 'INVALID_COMMAND', '命令长度必须为 1–50000。');
      const decision = await this.#requestPortalApproval(active, 'command', {
        command, cwd: String(args.cwd || '.'),
        reason: 'Codex 请求在当前项目的 Seatbelt 沙箱中执行命令。',
      });
      invariant(decision === 'accept', 403, 'COMMAND_DECLINED', decision === 'cancel' ? '命令已取消。' : '命令未获批准。');
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
    if (active.turnTimer) clearTimeout(active.turnTimer);
    for (const controller of active.commandControllers) controller.abort();
    this.#cancelApprovalsForActive(active);
    this.activeByChat.delete(active.chat.id);
    this.activeByThread.delete(active.threadId);
    for (const [threadId, parent] of this.parentBySubagent) {
      if (parent === active) this.parentBySubagent.delete(threadId);
    }
    this.globalActive = Math.max(0, this.globalActive - 1);
    active.capacityToken?.release();
    this.db.updateChat(active.chat.id, { status: 'idle' });
    const rawStatus = turn?.status || (error ? 'failed' : 'completed');
    const status = ['completed', 'failed', 'cancelled', 'interrupted'].includes(rawStatus) ? rawStatus : error ? 'failed' : 'completed';
    this.db.updateTurnRun(active.turnRunId, {
      status, completedAt: new Date().toISOString(), errorMessage: error?.message || null,
      finalItemId: active.finalItemId, finalReplySnapshot: active.finalReply || active.assistantText || null,
      diffSnapshot: active.diff, plan: active.plan, subagentCount: active.subagentThreadIds.size,
    });
    if (error) {
      this.#emit(active, 'turn_error', { message: error.message });
      error.turnEventEmitted = true;
      active.reject(error);
    } else {
      this.#emit(active, 'turn_completed', {
        turnId: active.turnId, turnRunId: active.turnRunId, status,
        finalItemId: active.finalItemId, taskId: active.chat.taskId || null,
        taskVersion: active.chat.taskVersion || null,
      });
      active.resolve({ text: active.assistantText, turn });
    }
  }

  #onExit(error) {
    this.loadedThreads.clear();
    this.contextByThread.clear();
    this.parentBySubagent.clear();
    this.skillsReady = false;
    for (const active of [...this.activeByChat.values()]) this.#finish(active, error);
  }
}

export { DYNAMIC_TOOLS, EFFORTS, TURN_MODES };
