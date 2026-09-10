#!/usr/bin/env node

import readline from 'node:readline';
import path from 'node:path';

const threads = new Map();
const heldTurns = new Map();
const threadTools = new Map();
const toolResponses = new Map();
let nextTool = 1;
let nextThread = 1;
let nextTurn = 1;

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, result) { write({ id, result }); }
function fail(id, code, message) { write({ id, error: { code, message } }); }
function notify(method, params) { write({ method, params }); }

function callTool(threadId, turnId, name, args = {}) {
  return new Promise((resolve) => {
    const id = `fixture-tool-${nextTool++}`;
    toolResponses.set(id, resolve);
    write({ id, method: 'item/tool/call', params: { threadId, turnId, callId: id, tool: name, arguments: args } });
  });
}
function toolData(response) {
  if (!response.result?.success) throw new Error('Workflow tool was rejected');
  return JSON.parse(response.result.contentItems[0].text);
}
async function workflowTurn(threadId, turnId, prompt) {
  try {
    const context = toolData(await callTool(threadId, turnId, 'work_graph_context'));
    // Real protocol calls exercise Portal tool routing; fixture decisions are deterministic, not model-quality evidence.
    const prohibited = await callTool(threadId, turnId, 'workspace_write_file', { path: 'forbidden-workflow-write.txt', content: 'must not be written' });
    if (prohibited.result?.success) throw new Error('Workflow escaped its tool scope');
    if (threadTools.get(threadId).includes('work_graph_submit_plan')) {
      const ids = context.candidateIds;
      const node = (key, assigneeUserId, dependsOn = [], completionGate = false) => ({ key, assigneeUserId,
        title: key, acceptance: 'Provide an adequate result with evidence.', checklist: ['Produce the agreed result'],
        outputs: [], dependsOn, completionGate });
      const nodes = ids.length >= 3 ? [node('requirements', ids[0]), node('design', ids[1], ['requirements']),
        node('implementation', ids[2], ['requirements']), node('delivery', ids[0], ['design', 'implementation'], true)]
        : [node('delivery', ids[0], [], true)];
      toolData(await callTool(threadId, turnId, 'work_graph_submit_plan', { graph: { schemaVersion: 1, title: 'Generated team graph', nodes } }));
    } else {
      const verdict = context.submission.summary.includes('needs-rework') ? 'rework'
        : context.submission.outputs.length && !context.files.length ? 'needs_human' : 'passed';
      toolData(await callTool(threadId, turnId, 'work_graph_submit_review', { verdict,
        feedback: verdict === 'rework' ? 'Add the missing supporting evidence.' : 'The stated result is supported.',
        items: context.task.checklist.map((item) => ({ id: item.id, status: verdict === 'passed' ? 'passed' : 'failed',
          comment: 'Checked the supplied result.', evidence: [context.files[0]?.path || 'result_summary'] })) }));
    }
    completeTurn(threadId, turnId, prompt);
  } catch {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Workflow fixture failed' }, items: [] } });
  }
}

function inputText(params) {
  return (params.input || []).filter((item) => item.type === 'text').map((item) => item.text || '').join('\n');
}

async function memoryTurn(threadId, turnId, prompt) {
  try {
    const calls = JSON.parse(prompt.split('[[memory-tools]]')[1]);
    for (const { name, args } of calls) {
      if (!threadTools.get(threadId)?.includes(name)) throw new Error('memory tool not registered');
      toolData(await callTool(threadId, turnId, name, args));
    }
    completeTurn(threadId, turnId, prompt);
  } catch {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Memory fixture failed' }, items: [] } });
  }
}

function completeTurn(threadId, turnId, prompt, steers = []) {
  const finalItemId = `item-${turnId}`;
  const publicPrompt = prompt.replace(/^<!-- portal-mode:(?:EDIT|EXECUTE) -->\n/, '').replace(/^\$task-execution\n/, '')
    .replace(/^<!-- portal-memory-context:v1 -->[\s\S]*?<!-- \/portal-memory-context -->\n/, '');
  const reply = `FAKE_CODEX_DONE: ${publicPrompt.slice(0, 200)}`;
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
  if (!method && toolResponses.has(id)) { const resolve = toolResponses.get(id); toolResponses.delete(id); resolve(message); return; }
  if (id === undefined) return;
  if (method === 'initialize') return respond(id, { userAgent: 'codex-cli/0.150.0-alpha.8 fake-e2e' });
  if (method === 'config/read') return respond(id, { config: {
    features: { memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled') },
    memories: {
      generate_memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled'),
      use_memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled'),
    },
  }, origins: {}, layers: null });
  if (method === 'skills/extraRoots/set' || method === 'thread/name/set' || method === 'thread/goal/set') return respond(id, {});
  if (method === 'skills/list') return respond(id, { data: (params.cwds || []).map((cwd) => ({
    cwd, skills: ['task-execution', 'work-graph-planning', 'work-graph-review'].map((name) => ({ name,
      path: path.resolve(process.cwd(), `portal-skills/${name}/SKILL.md`), enabled: true })),
  })) });
  if (method === 'thread/start') {
    const threadId = `fake-thread-${process.pid}-${nextThread++}`;
    threads.set(threadId, { id: threadId, modelProvider: 'openai_http', turns: [], goal: null });
    threadTools.set(threadId, (params.dynamicTools || []).map((tool) => tool.name));
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
    threadTools.set(params.threadId, (params.dynamicTools || []).map((tool) => tool.name));
    return respond(id, { thread: threads.get(params.threadId) });
  }
  if (method === 'thread/read') {
    const thread = threads.get(params.threadId);
    if (!thread) return fail(id, -32001, 'thread not found');
    return respond(id, { thread });
  }
  if (method === 'thread/goal/get') return respond(id, { goal: threads.get(params.threadId)?.goal || null });
  if (method === 'turn/start') {
    const turnId = `fake-turn-${process.pid}-${nextTurn++}`;
    const prompt = inputText(params);
    respond(id, { turn: { id: turnId, status: 'running' } });
    if (threadTools.get(params.threadId)?.includes('work_graph_context')) { void workflowTurn(params.threadId, turnId, prompt); return; }
    if (prompt.includes('[[memory-tools]]')) { void memoryTurn(params.threadId, turnId, prompt); return; }
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
