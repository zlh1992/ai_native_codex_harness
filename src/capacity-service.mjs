import { EventEmitter } from 'node:events';
import { HttpError } from './errors.mjs';

function expiry(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

export class CapacityService extends EventEmitter {
  constructor({ db, maxRootTurns = 11, maxExecuteLeases = 2, leaseTtlMs = 30_000 }) {
    super();
    this.db = db;
    this.maxRootTurns = maxRootTurns;
    this.maxExecuteLeases = maxExecuteLeases;
    this.leaseTtlMs = leaseTtlMs;
    this.active = new Map();
    this.queue = [];
  }

  status() {
    const executeActive = [...this.active.values()].filter((entry) => entry.mode === 'execute').length;
    return {
      activeRootTurns: this.active.size,
      maxRootTurns: this.maxRootTurns,
      activeExecuteLeases: executeActive,
      maxExecuteLeases: this.maxExecuteLeases,
      queuedTurns: this.queue.length,
    };
  }

  acquire({ turnRunId, chatId, userId, mode, onQueue = () => {} }) {
    if (this.#canStart(mode) && this.queue.length === 0) return Promise.resolve(this.#grant({ turnRunId, chatId, userId, mode }));
    return new Promise((resolve, reject) => {
      this.queue.push({ turnRunId, chatId, userId, mode, onQueue, resolve, reject });
      this.#updatePositions();
      this.#drain();
    });
  }

  cancelChat(chatId) {
    const index = this.queue.findIndex((entry) => entry.chatId === chatId);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.db.updateTurnRun(entry.turnRunId, {
      status: 'cancelled', queuePosition: null, completedAt: new Date().toISOString(), errorMessage: '用户取消排队',
    });
    entry.reject(new HttpError(409, 'TURN_CANCELLED', '任务已取消排队。'));
    this.#updatePositions();
    this.emit('cancelled', { turnRunId: entry.turnRunId, chatId });
    return true;
  }

  cancelUser(userId) {
    const chatIds = this.queue.filter((entry) => entry.userId === userId).map((entry) => entry.chatId);
    for (const chatId of chatIds) this.cancelChat(chatId);
    return chatIds.length;
  }

  #canStart(mode) {
    if (this.active.size >= this.maxRootTurns) return false;
    if (mode !== 'execute') return true;
    return [...this.active.values()].filter((entry) => entry.mode === 'execute').length < this.maxExecuteLeases;
  }

  #grant(entry) {
    const granted = { ...entry, heartbeat: null, released: false };
    if (entry.mode === 'execute') {
      this.db.createExecutionLease({
        turnRunId: entry.turnRunId, userId: entry.userId, chatId: entry.chatId, expiresAt: expiry(this.leaseTtlMs),
      });
      granted.heartbeat = setInterval(() => {
        this.db.renewExecutionLease(entry.turnRunId, expiry(this.leaseTtlMs));
      }, Math.max(1_000, Math.floor(this.leaseTtlMs / 3)));
      granted.heartbeat.unref?.();
    }
    this.active.set(entry.turnRunId, granted);
    this.db.updateTurnRun(entry.turnRunId, { status: 'starting', queuePosition: null, startedAt: new Date().toISOString() });
    this.emit('granted', { turnRunId: entry.turnRunId, chatId: entry.chatId, mode: entry.mode });
    return {
      turnRunId: entry.turnRunId,
      release: () => this.release(entry.turnRunId),
    };
  }

  release(turnRunId) {
    const entry = this.active.get(turnRunId);
    if (!entry || entry.released) return false;
    entry.released = true;
    if (entry.heartbeat) clearInterval(entry.heartbeat);
    if (entry.mode === 'execute') this.db.deleteExecutionLease(turnRunId);
    this.active.delete(turnRunId);
    this.emit('released', { turnRunId, chatId: entry.chatId, mode: entry.mode });
    this.#drain();
    return true;
  }

  #drain() {
    while (this.active.size < this.maxRootTurns) {
      const index = this.queue.findIndex((entry) => this.#canStart(entry.mode));
      if (index < 0) break;
      const [entry] = this.queue.splice(index, 1);
      try { entry.resolve(this.#grant(entry)); } catch (error) { entry.reject(error); }
    }
    this.#updatePositions();
  }

  #updatePositions() {
    this.queue.forEach((entry, index) => {
      const position = index + 1;
      if (entry.lastPosition === position) return;
      entry.lastPosition = position;
      this.db.updateTurnRun(entry.turnRunId, { status: 'queued', queuePosition: position });
      try { entry.onQueue(position); } catch { /* disconnected browser */ }
    });
  }
}
