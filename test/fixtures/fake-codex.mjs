#!/usr/bin/env node

import readline from 'node:readline';
import path from 'node:path';

const threads = new Map();
const heldTurns = new Map();
let nextThread = 1;
let nextTurn = 1;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) { write({ id, result }); }
function fail(id, code, message) { write({ id, error: { code, message } }); }
function notify(method, params) { write({ method, params }); }

function inputText(params) {
  return (params.input || []).filter((item) => item.type === 'text').map((item) => item.text || '').join('\n');
}

function completeTurn(threadId, turnId, prompt, steers = []) {
  const finalItemId = `item-${turnId}`;
  const reply = `FAKE_CODEX_DONE: ${prompt.replace(/^<!-- portal-mode:(?:EDIT|EXECUTE) -->\n/, '').slice(0, 200)}`;
  notify('turn/diff/updated', { threadId, turnId, diff: 'diff --git a/gate.txt b/gate.txt\n+fake secret diff body' });
  notify('item/agentMessage/delta', { threadId, turnId, itemId: finalItemId, delta: reply });
  notify('item/completed', { threadId, turnId, item: { id: finalItemId, type: 'agentMessage', phase: 'final_answer', text: reply } });
  const thread = threads.get(threadId);
  thread.turns.push({
    id: turnId, status: 'completed', items: [
      { id: `user-${turnId}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] },
      ...steers.map((item) => ({ id: item.id, type: 'userMessage', content: [{ type: 'text', text: item.text }] })),
      { id: finalItemId, type: 'agentMessage', phase: 'final_answer', text: reply },
    ],
  });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: thread.turns.at(-1).items } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  if (id === undefined) return;
  if (method === 'initialize') return respond(id, { userAgent: 'codex-cli/0.150.0-alpha.8 fake-e2e' });
  if (method === 'skills/extraRoots/set' || method === 'thread/name/set' || method === 'thread/goal/set') return respond(id, {});
  if (method === 'skills/list') return respond(id, { data: (params.cwds || []).map((cwd) => ({
    cwd, skills: [{ name: 'task-execution', path: path.resolve(process.cwd(), 'portal-skills/task-execution/SKILL.md'), enabled: true }],
  })) });
  if (method === 'thread/start') {
    const threadId = `fake-thread-${process.pid}-${nextThread++}`;
    threads.set(threadId, { id: threadId, modelProvider: 'openai_http', turns: [], goal: null });
    return respond(id, { thread: threads.get(threadId) });
  }
  if (method === 'thread/fork') {
    const source = threads.get(params.threadId);
    if (!source) return fail(id, -32001, 'thread not found');
    if (JSON.stringify(source.turns).includes('[[fork-fail]]')) return fail(id, -32002, 'fixture fork failure');
    const threadId = `fake-thread-${process.pid}-${nextThread++}`;
    const fork = structuredClone(source);
    fork.id = threadId;
    threads.set(threadId, fork);
    return respond(id, { thread: fork });
  }
  if (method === 'thread/resume') {
    if (process.env.FAKE_FAIL_RESUME === '1') return fail(id, -32000, '/private/fake/secret resume failure');
    if (!threads.has(params.threadId)) threads.set(params.threadId, { id: params.threadId, modelProvider: 'openai_http', turns: [], goal: null });
    return respond(id, { thread: threads.get(params.threadId) });
  }
  if (method === 'thread/read') {
    const thread = threads.get(params.threadId);
    if (!thread) return fail(id, -32001, 'thread not found');
    return respond(id, { thread });
  }
  if (method === 'thread/goal/get') return respond(id, { goal: threads.get(params.threadId)?.goal || null });
  if (method === 'turn/start') {
    const turnId = `fake-turn-${nextTurn++}`;
    const prompt = inputText(params);
    respond(id, { turn: { id: turnId, status: 'running' } });
    if (prompt.includes('[[hold]]')) heldTurns.set(turnId, { threadId: params.threadId, prompt, steers: [] });
    else setTimeout(() => completeTurn(params.threadId, turnId, prompt), 15).unref();
    return;
  }
  if (method === 'turn/steer') {
    const held = heldTurns.get(params.expectedTurnId);
    if (!held || held.threadId !== params.threadId) return fail(id, -32001, 'active turn mismatch');
    const text = inputText(params);
    held.steers.push({ id: params.clientUserMessageId, text });
    respond(id, { turnId: params.expectedTurnId });
    if (text.includes('[[release]]')) {
      heldTurns.delete(params.expectedTurnId);
      setTimeout(() => completeTurn(held.threadId, params.expectedTurnId, held.prompt, held.steers), 50).unref();
    }
    return;
  }
  if (method === 'turn/interrupt') {
    heldTurns.delete(params.turnId);
    respond(id, {});
    setTimeout(() => notify('turn/completed', {
      threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted', items: [] },
    }), 5).unref();
    return;
  }
  return respond(id, {});
});
