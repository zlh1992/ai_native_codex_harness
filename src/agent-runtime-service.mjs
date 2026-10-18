import { EventEmitter } from 'node:events';
import { CodexService } from './codex-service.mjs';
import { LocalQwenService } from './local-qwen-service.mjs';
import { InputQueueService } from './input-queue-service.mjs';
import { isPrivateProject } from './private-projects.mjs';
import { invariant } from './errors.mjs';

// Preserve the existing Portal/graph service surface; route only user chat operations.
export class AgentRuntimeService extends EventEmitter {
  constructor(options) {
    super();
    Object.assign(this, options);
    this.standard = new CodexService(options);
    this.local = new LocalQwenService({ ...options, standard: this.standard });
    this.capacity = this.standard.capacity;
    this.sharingAccesses = this.standard.sharingAccesses;
    this.inputQueue = new InputQueueService(this);
    // Codex failures may pause only Codex inputs, never the independent local queue.
    this.standard.inputQueue = {
      start() {}, stop() {},
      pauseAll: (reason) => this.inputQueue.pauseAll(reason, (id) => this.engine(id) === this.standard),
    };
    this.local.interruptOther = (id) => this.interruptAndWait(id);
    for (const service of [this.standard, this.local]) for (const event of ['log', 'turnEvent', 'turnLiveEvent']) service.on(event, (value) => this.emit(event, value));
    return new Proxy(this, { get: (target, key, receiver) => {
      if (key in target) { const value = Reflect.get(target, key, receiver); return typeof value === 'function' ? value.bind(target) : value; }
      const value = this.standard[key]; return typeof value === 'function' ? value.bind(this.standard) : value;
    }, set: (target, key, value) => {
      if (key === 'workGraphRuntime') this.standard.workGraphRuntime = value;
      target[key] = value; return true;
    } });
  }
  engine(chatId) { const chat = this.db.getChat(chatId); return isPrivateProject(chat && this.db.getProject(chat.projectId)) ? this.local : this.standard; }
  get activeByChat() { return new Map([...this.standard.activeByChat, ...this.local.activeByChat]); }
  get pendingChats() { return new Set([...this.standard.pendingChats, ...this.local.pendingChats]); }
  get recoveringChats() { return new Set([...this.standard.recoveringChats, ...this.local.recoveringChats]); }
  get pendingByUser() {
    const result = new Map(this.standard.pendingByUser);
    for (const [id, count] of this.local.pendingByUser) result.set(id, (result.get(id) || 0) + count);
    return result;
  }
  get globalActive() { return this.standard.globalActive + this.local.globalActive; }
  get globalPending() { return this.standard.globalPending + this.local.globalPending; }
  isReady(id) { return this.engine(id).isReady(); }
  async start() { this.inputQueue.start(); this.local.start(); return this.standard.start(); }
  stop() { this.inputQueue.stop(); this.local.stop(); return this.standard.stop(); }
  status() { return { ...this.standard.status(), runtimes: { codex: this.standard.status().ready ? 'ready' : 'unavailable', qwen: this.local.status() } }; }
  runTurn(context) {
    invariant(this.globalActive + this.globalPending < this.config.codexMaxConcurrentTurns, 429, 'CODEX_BUSY', '本机运行队列已满。');
    const count = [...this.activeByChat.values()].filter((a) => a.user.id === context.user.id).length + (this.pendingByUser.get(context.user.id) || 0);
    invariant(count < context.user.maxConcurrentTurns, 429, 'USER_CONCURRENCY_LIMIT', '已达到用户并发上限。');
    return this.engine(context.chat.id).runTurn(context);
  }
  historyForChat(chat, authorize) { return this.engine(chat.id).historyForChat(chat, authorize); }
  getGoal(chat, authorize) { return this.engine(chat.id).getGoal(chat, authorize); }
  recoverChatThread(context) { return this.engine(context.chat.id).recoverChatThread(context); }
  steerInput(active, input) { return this.engine(active.chat.id).steerInput(active, input); }
  pendingApprovalsForChat(id, userId) { return this.engine(id).pendingApprovalsForChat(id, userId); }
  resolveApproval(input) { return this.engine(input.chatId).resolveApproval(input); }
  chatBusy(id) { return this.engine(id).chatBusy(id); }
  workspaceBusy(id) { return this.standard.workspaceBusy(id) || this.local.workspaceBusy(id); }
  userBusy(id) { return this.standard.userBusy(id) || this.local.userBusy(id); }
  interrupt(id) { return this.engine(id).interrupt(id); }
  interruptAndWait(id, timeout) { return this.engine(id).interruptAndWait(id, timeout); }
  waitForChatIdle(id, timeout) { return this.engine(id).waitForChatIdle(id, timeout); }
  async interruptUser(id) { const counts = await Promise.all([this.standard.interruptUser(id), this.local.interruptUser(id)]); return counts.reduce((a, b) => a + b, 0); }
  async interruptUserAndWait(id, timeout) { await this.interruptUser(id); await this.waitForUserIdle(id, timeout); }
  async waitForUserIdle(id, timeout) { await Promise.all([this.standard.waitForUserIdle(id, timeout), this.local.waitForUserIdle(id, timeout)]); }
  async interruptAccessAndWait(id, timeout) { await Promise.all(this.db.listChats({}).filter((c) => c.projectAccessId === id).map((c) => this.interruptAndWait(c.id, timeout))); }
  async interruptProjectAndWait(id, timeout) { await Promise.all(this.db.listChats({ projectId: id }).map((c) => this.interruptAndWait(c.id, timeout))); }
}
