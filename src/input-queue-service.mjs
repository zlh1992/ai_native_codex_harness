import { invariant } from './errors.mjs';

const MODES = new Set(['edit', 'execute']);
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

// Private message content lives in chat_inputs/messages, never in audit or the event journal.
export class InputQueueService {
  constructor(codex) { this.codex = codex; this.db = codex.db; this.inFlight = new Set(); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), 250);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  pauseAll(reason) {
    for (const row of this.db.db.prepare("SELECT DISTINCT chat_id FROM chat_inputs WHERE status='queued'").all()) {
      this.db.pauseChatInputs(row.chat_id, reason);
    }
  }

  policy(chatId) {
    const chat = this.db.getChat(chatId);
    invariant(!chat?.purpose || chat.purpose === 'normal', 403, 'WORKFLOW_JOB_REQUIRED', '后台规划与验收对话由工作图调度器管理。');
    const user = chat && this.db.getUserById(chat.userId);
    invariant(user?.status === 'active', 403, 'USER_DISABLED', '账号不可用。');
    const project = this.db.getProjectForUser(chat.projectId, user.id);
    invariant(project && project.accessId === chat.projectAccessId, 403, 'PROJECT_ACCESS_REVOKED', '项目授权已撤销。');
    invariant(chat.threadState !== 'resume_failed', 409, 'THREAD_RESUME_FAILED', '请先恢复原线程。');
    invariant(!this.codex.sharingAccesses.has(project.accessId) && !this.codex.recoveringChats.has(chatId), 409, 'WORKSPACE_BUSY', '项目正在共享或恢复，请稍后重试。');
    if (chat.taskId) {
      const task = this.db.getTaskForUser(chat.taskId, user.id);
      invariant(task && task.version === chat.taskVersion && ['active', 'rework'].includes(task.status), 409, 'TASK_STALE', '任务已提交或版本已变化。');
      this.codex.workGraphRuntime?.assertContext({ chat });
    }
    return { chat, user, project };
  }

  text(prompt) {
    invariant(typeof prompt === 'string' && prompt.trim().length > 0 && prompt.trim().length <= 100_000,
      400, 'INVALID_PROMPT', '消息长度必须为 1–100000 个字符。');
    return prompt.trim();
  }

  enqueue(chatId, { id, prompt, mode, effort }) {
    const { chat } = this.policy(chatId);
    invariant(typeof id === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(id), 400, 'INVALID_INPUT_ID', '消息标识无效。');
    const existing = this.db.getChatInput(chatId, id);
    if (existing) return existing; // Retrying an acknowledged or cancelled input cannot send it twice.
    prompt = this.text(prompt);
    mode ||= chat.preferredMode || 'execute';
    effort ||= this.codex.config.codexReasoningEffort;
    invariant(MODES.has(mode) && EFFORTS.has(effort), 400, 'INVALID_INPUT_OPTIONS', '消息模式或推理强度无效。');
    const pending = this.db.listChatInputs(chatId);
    invariant(pending.length < 50 && pending.reduce((sum, input) => sum + input.prompt.length, prompt.length) <= 1_000_000,
      429, 'INPUT_QUEUE_FULL', '待发送消息过多，请先处理队列。');
    return this.db.createChatInput({ id, chatId, prompt, mode, effort });
  }

  editable(chatId, id, revision) {
    const input = this.db.getChatInput(chatId, id);
    invariant(input && input.revision === revision && ['queued', 'paused'].includes(input.status),
      409, 'INPUT_CHANGED', '消息已开始发送、已处理或已在其他页面修改，请刷新队列。');
    return input;
  }

  edit(chatId, id, revision, prompt) {
    const input = this.editable(chatId, id, revision);
    prompt = this.text(prompt);
    invariant(this.db.listChatInputs(chatId).reduce((sum, item) => sum + (item.id === id ? 0 : item.prompt.length), prompt.length) <= 1_000_000,
      429, 'INPUT_QUEUE_FULL', '待发送消息过多，请先处理队列。');
    return this.db.changeChatInput(chatId, id, revision, { status: input.status, prompt, reason: input.reason });
  }

  cancel(chatId, id, revision) {
    this.editable(chatId, id, revision);
    return this.db.changeChatInput(chatId, id, revision, { status: 'cancelled', prompt: '' });
  }

  resume(chatId, id, revision, acknowledgeUncertain = false) {
    this.policy(chatId);
    const input = this.editable(chatId, id, revision);
    invariant(input.reason !== 'DELIVERY_UNCERTAIN' || acknowledgeUncertain === true, 409, 'DELIVERY_UNCERTAIN', '上次发送结果不确定，请先核对对话；核对后可确认重新排队。');
    return this.db.changeChatInput(chatId, id, revision, { status: 'queued' });
  }

  async steer(chatId, id, revision, expectedRunId) {
    const { user, project } = this.policy(chatId);
    const input = this.editable(chatId, id, revision);
    const active = this.codex.activeByChat.get(chatId);
    invariant(active && active.turnId && !active.completed && !active.interruptRequested
      && active.turnRunId === expectedRunId && !this.inFlight.has(chatId),
    409, 'TURN_CHANGED', '当前运行已变化或尚未开始，请刷新后重试；消息仍在队列中。');
    invariant(input.mode === active.mode, 409, 'STEER_MODE_MISMATCH', '调整方向须与当前运行模式一致；此消息可等待下一轮执行。');
    invariant(user.networkAccess === active.user.networkAccess && project.accessId === active.project.accessId,
      409, 'USER_POLICY_CHANGED', '运行策略已变化。');
    const claimed = this.db.changeChatInput(chatId, id, revision, { status: 'steering', turnRunId: active.turnRunId });
    this.inFlight.add(chatId);
    try {
      const response = await this.codex.client.request('turn/steer', {
        threadId: active.threadId, expectedTurnId: active.turnId, clientUserMessageId: id,
        input: [{ type: 'text', text: input.prompt, text_elements: [] }],
      }, 15_000);
      invariant(response?.turnId === active.turnId, 502, 'STEER_RESPONSE_MISMATCH', '上游返回了不同的运行标识。');
      // Persist even if completion/revocation arrived during RPC: upstream accepted this input.
      this.db.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.addMessage({ id: `steer:${id}`, chatId, turnId: active.turnId, role: 'user', content: input.prompt,
          metadata: { turnRunId: active.turnRunId, inputId: id, steered: true, mode: active.mode } });
        this.db.changeChatInput(chatId, id, claimed.revision, { status: 'sent', prompt: '', turnRunId: active.turnRunId });
        this.db.db.exec('COMMIT');
      } catch (error) { this.db.db.exec('ROLLBACK'); throw error; }
      active.emit('input_steered', { inputId: id, turnRunId: active.turnRunId });
      return this.db.getChatInput(chatId, id);
    } catch (error) {
      const current = this.db.getChatInput(chatId, id);
      if (current?.status === 'steering') this.db.changeChatInput(chatId, id, current.revision,
        { status: 'paused', reason: 'DELIVERY_UNCERTAIN' });
      this.db.pauseChatInputs(chatId, 'STEER_PAUSED');
      // RPC errors may contain user content. Return a fixed, safe error.
      invariant(false, 409, 'STEER_NOT_CONFIRMED', '调整方向未获确认，队列已暂停。请核对对话后处理保留消息。');
    } finally { this.inFlight.delete(chatId); }
  }

  pump() {
    if (!this.codex.skillsReady || !this.codex.client.started) return;
    const chats = this.db.db.prepare("SELECT DISTINCT chat_id FROM chat_inputs WHERE status='queued'").all();
    for (const { chat_id: chatId } of chats) {
      if (this.inFlight.has(chatId) || this.codex.activeByChat.has(chatId) || this.codex.pendingChats.has(chatId)) continue;
      const runtime = this.db.runtimeForChat(chatId);
      if (runtime.turnBusy || runtime.approvalBusy || runtime.leaseBusy) continue;
      const input = this.db.listChatInputs(chatId)[0];
      if (!input || input.status !== 'queued') continue; // A paused first message blocks later messages.
      let context;
      try { context = this.policy(chatId); }
      catch (error) { this.db.pauseChatInputs(chatId, error.code || 'INPUT_BLOCKED'); continue; }
      const active = [...this.codex.activeByChat.values()].filter((entry) => entry.user.id === context.user.id).length;
      if (active + (this.codex.pendingByUser.get(context.user.id) || 0) >= context.user.maxConcurrentTurns
        || this.codex.globalActive + this.codex.globalPending >= this.codex.config.codexMaxConcurrentTurns) continue;
      void this.codex.runTurn({ ...context, prompt: input.prompt, mode: input.mode, effort: input.effort,
        inputId: input.id, emit: () => {} }).catch(() => {
        this.db.pauseChatInputs(chatId, 'TURN_FAILED');
      });
    }
  }
}
