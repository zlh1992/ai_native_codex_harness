#!/usr/bin/env node

import readline from 'node:readline';
import path from 'node:path';

const threads = new Map();
const usageByThread = new Map();
const usage = n => ({ inputTokens: 100*n, outputTokens: 20*n, totalTokens: 120*n, cachedInputTokens: 10*n, cacheWriteInputTokens: 0, reasoningOutputTokens: 5*n });
const heldTurns = new Map();
const threadTools = new Map();
const toolResponses = new Map();
let nextTool = 1;
let nextThread = 1;
let nextTurn = 1;
let lastMcpConfig;

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
      const currentFiles = context.files.filter(file => !file.evidenceRef);
      const upstream = context.files.find(file => file.evidenceRef);
      const verdict = context.submission.summary.includes('needs-rework') ? 'rework'
        : context.submission.outputs.length && !currentFiles.length ? 'needs_human' : 'passed';
      toolData(await callTool(threadId, turnId, 'work_graph_submit_review', { verdict,
        feedback: verdict === 'rework' ? 'Add the missing supporting evidence.' : 'The stated result is supported.',
        items: context.task.checklist.map((item) => ({ id: item.id, status: verdict === 'passed' ? 'passed' : 'failed',
          comment: 'Checked the supplied result.', evidence: [currentFiles[0]?.path || 'result_summary',
            ...(upstream ? [upstream.evidenceRef] : [])] })) }));
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

async function dispatchTurn(threadId, turnId, prompt) {
  try {
    const input = JSON.parse(prompt.split('[[dispatch-upgrade]]')[1]);
    if (!threadTools.get(threadId)?.includes('dispatch_history')) throw new Error('missing new tools');
    const history = toolData(await callTool(threadId, turnId, 'dispatch_history', {}));
    if (!history.messages.some(m => m.content.includes('上一轮资料'))) throw new Error('prior history missing');
    const file = toolData(await callTool(threadId, turnId, 'dispatch_project', {
      action: 'capture', projectId: input.projectId, path: 'brief.txt', idempotencyKey: input.captureKey }));
    const result = toolData(await callTool(threadId, turnId, 'dispatch_prepare', {
      title: '带资料任务', acceptance: '完成客户方案', assigneeUserId: input.employeeId, attachmentIds: [file.id], idempotencyKey: input.dispatchKey }));
    if (result.status !== 'accepted') throw new Error('receipt must be accepted before run finishes');
    completeTurn(threadId, turnId, '请求已受理，等待后台准备并发布。');
  } catch { notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Dispatch fixture failed' }, items: [] } }); }
}

async function browserTurn(threadId, turnId, prompt) {
  try {
    const args = JSON.parse(prompt.split('[[browser]]')[1]);
    toolData(await callTool(threadId, turnId, 'browser_open', { url: args.url }));
    const page = toolData(await callTool(threadId, turnId, 'browser_handoff', { reason: '请在网页完成受控验证' }));
    completeTurn(threadId, turnId, page.text || page.errorCode || 'browser ended');
  } catch {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Browser fixture failed' }, items: [] } });
  }
}

async function workspaceTurn(threadId, turnId, prompt) {
  try {
    const args = JSON.parse(prompt.split('[[workspace-exec]]')[1]);
    const result = toolData(await callTool(threadId, turnId, 'workspace_exec', args));
    completeTurn(threadId, turnId, JSON.stringify(result));
  } catch {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'Workspace fixture failed' }, items: [] } });
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
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)) lastMcpConfig = params.config?.mcp_servers;
  if (!method && toolResponses.has(id)) { const resolve = toolResponses.get(id); toolResponses.delete(id); resolve(message); return; }
  if (id === undefined) return;
  if (method === 'initialize') return respond(id, { userAgent: 'codex-cli/0.164.0-alpha.11.1 fake-e2e' });
  if (method === 'test/proxy-environment') return respond(id, Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
      'PORTAL_TEST_SECRET', 'HOME', 'CODEX_HOME'].map(key => [key, process.env[key] ?? null])));
  if (method === 'test/mcp-config') return respond(id, { mcp: lastMcpConfig });
  if (method === 'config/read') return respond(id, { config: {
    mcp_servers: process.argv.some(value => value.startsWith('web_search=')) ? {} : { host_personal_tool: { enabled: true } },
    web_search: process.argv.includes('web_search="live"') ? 'live' : 'disabled',
    features: { memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled') },
    memories: {
      generate_memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled'),
      use_memories: String(process.env.CODEX_HOME || '').includes('fake-native-memory-enabled'),
    },
  }, origins: {}, layers: null });
  if (method === 'skills/extraRoots/set' || method === 'thread/name/set' || method === 'thread/goal/set') return respond(id, {});
  if (method === 'skills/list') return respond(id, { data: (params.cwds || []).map((cwd) => ({
    cwd, skills: ['task-execution', 'work-graph-planning', 'work-graph-review', 'task-dispatch'].map((name) => ({ name,
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
    usageByThread.set(threadId, usageByThread.get(params.threadId) || 0);
    threads.set(threadId, fork);
    return respond(id, { thread: fork });
  }
  if (method === 'thread/resume') {
    notify('thread/tokenUsage/updated', { threadId: params.threadId, turnId: 'previous', tokenUsage: { total: usage(usageByThread.get(params.threadId) || 0), last: usage(0) } });
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
    notify('turn/started', { threadId: params.threadId, turn: { id: turnId, status: 'running' } });
    const count = (usageByThread.get(params.threadId) || 0) + 1; usageByThread.set(params.threadId, count);
    notify('thread/tokenUsage/updated', { threadId: params.threadId, turnId, tokenUsage: { total: usage(count), last: usage(1) } });
    if (threadTools.get(params.threadId)?.includes('work_graph_context')) { void workflowTurn(params.threadId, turnId, prompt); return; }
    if (prompt.includes('[[memory-tools]]')) { void memoryTurn(params.threadId, turnId, prompt); return; }
    if (prompt.includes('[[dispatch-upgrade]]')) { void dispatchTurn(params.threadId, turnId, prompt); return; }
    if (prompt.includes('[[browser]]')) { void browserTurn(params.threadId, turnId, prompt); return; }
    if (prompt.includes('[[workspace-exec]]')) { void workspaceTurn(params.threadId, turnId, prompt); return; }
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
