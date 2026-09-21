import { createLocalUsageMeter } from './local-usage.mjs';
// Trusted, sandboxed DSH composition. No web bundle, user profile, plugin loader or telemetry.
import readline from 'node:readline';
import { Context } from '@deepseek-ai/cordis';
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm';
import Sessions from '@deepseek-ai/dsh-session';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Agents from '@deepseek-ai/dsh-agent';
import Loop from '@deepseek-ai/dsh-agent-loop';
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Checkpoint from '@deepseek-ai/dsh-session-checkpoint-policy';
import * as Pi from '@deepseek-ai/dsh-llm-pi-ai';
import Compaction from '@deepseek-ai/dsh-compaction-basic';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { localModelUrl } from './private-projects.mjs';

process.umask(0o077);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const pending = new Map();
const usageMeter = createLocalUsageMeter(send);
let ctx, handle, initialized = false, running = false, stopped = false, toolSequence = 0;
const message = (text, id) => Object.freeze({ ...createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), ...(id ? { id } : {}) });
function parameters(schema) {
  return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key,
    { type: value.type, ...(value.description ? { description: value.description } : {}),
      ...((schema.required || []).includes(key) ? { required: true } : {}) }]));
}
async function init(input) {
  if (initialized || ctx) throw new Error('ALREADY_INITIALIZED');
  const baseUrl = localModelUrl(input.baseUrl);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (target, options = {}) => {
    const url = new URL(typeof target === 'string' || target instanceof URL ? target : target.url);
    if (![`${baseUrl}/chat/completions`, `${baseUrl}/models`].includes(url.href)) throw new Error('LOCAL_EGRESS_DENIED');
    return url.pathname.endsWith('/chat/completions')
      ? usageMeter.fetchMetered(nativeFetch, target, { ...options, redirect: 'error' })
      : nativeFetch(target, { ...options, redirect: 'error' });
  };
  ctx = new Context();
  // Never forward a framework error's raw message to Portal logs.
  await ctx.plugin(Llm);
  ctx.on('llm/stream', usageMeter.stream);
  await ctx.plugin(Sessions);
  await ctx.plugin(Prompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: input.instructions });
  await ctx.plugin(Tools, { mode: 'native' });
  await ctx.plugin(Agents);
  await ctx.plugin(Loop, { agents: [], maxParallelToolCalls: 1 });
  await ctx.plugin(Persistence, { root: input.sessionRoot, compression: 'none' });
  await ctx.plugin(Checkpoint);
  await ctx.plugin(Pi, { providers: { 'portal-local': {
    api: 'openai-completions', apiKeyEnv: 'PORTAL_LOCAL_MODEL_KEY', baseURL: baseUrl,
    models: [{ id: input.model, contextWindow: input.contextWindow, maxTokens: input.maxTokens }],
    compat: { thinkingFormat: 'deepseek' }, timeoutMs: input.timeoutMs, streamIdleTimeoutMs: input.timeoutMs,
  } } });
  await ctx.plugin(TokenMeter);
  await ctx.plugin(Compaction, { thresholdRatio: 0.8, retainRatio: 0.2, maxTokens: 4096, compactionRetries: 1 });
  for (const tool of input.tools) ctx.tools.register(defineTool({
    name: tool.name, description: tool.description, parameters: parameters(tool.inputSchema),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, execution) {
      const id = `tool-${++toolSequence}`;
      const result = await new Promise((resolve, reject) => {
        const abort = () => { pending.delete(id); send({ type: 'tool_cancel', id }); reject(new Error('TOOL_CANCELLED')); };
        pending.set(id, { resolve, reject, cleanup: () => execution.signal.removeEventListener('abort', abort) });
        execution.signal.addEventListener('abort', abort, { once: true });
        if (execution.signal.aborted) { abort(); return; }
        send({ type: 'tool', id, name: tool.name, args });
      });
      return JSON.stringify(result);
    },
  }));
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'assistant/chunk') {
      const chunk = event.data.chunk;
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') send({ type: 'delta', reasoning: chunk.type === 'reasoning-delta', text: chunk.text || '' });
    }
  });
  const options = { agentOptions: { provider: 'portal-local', model: input.model, maxTokens: input.maxTokens } };
  handle = input.resume
    ? await ctx.agents.resume({ ...options, resumeSessionId: input.sessionId })
    : await ctx.agents.create({ ...options, sessionId: input.sessionId, meta: { cwd: input.sessionRoot } });
  // Portal owns delivery/retry. Never replay an unclaimed inbox item left by a crash.
  if (input.resume) { handle.agent.cancel({ kind: 'user' }); await handle.agent.whenIdle(); }
  else handle.agent.session.append('request/context', { provider: 'portal-local', model: input.model, contextWindow: input.contextWindow });
  await ctx.sessions.flush(handle.agent.session);
  initialized = true;
  send({ type: 'ready' });
}
async function run(input) {
  if (!initialized || running || stopped) throw new Error('WORKER_NOT_READY');
  running = true;
  const firstSeq = handle.agent.session.seq;
  handle.agent.followup(message(input.prompt, input.inputId));
  await handle.agent.whenIdle();
  await ctx.sessions.flush(handle.agent.session);
  let text = '', status = 'failed';
  for (const event of handle.agent.session.events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'assistant/message') text = event.data.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (event.type === 'turn/end') status = event.data.reason.kind === 'completed' ? 'completed' : stopped ? 'interrupted' : 'failed';
  }
  running = false;
  send({ type: 'done', text, status });
}
function stop() {
  stopped = true;
  handle?.agent.cancel({ kind: 'user' });
  for (const item of pending.values()) { item.cleanup(); item.reject(new Error('TOOL_CANCELLED')); }
  pending.clear();
}
async function dispatch(input) {
  if (input.type === 'init') return init(input);
  if (input.type === 'run') return run(input);
  if (input.type === 'stop') return stop();
  if (input.type === 'steer') {
    if (!running || stopped) { send({ type: 'steer_ack', id: input.id, ok: false }); return; }
    handle.agent.steer(message(input.prompt, input.id));
    await ctx.sessions.flush(handle.agent.session);
    send({ type: 'steer_ack', id: input.id, ok: true });
  }
  if (input.type === 'tool_result') {
    const item = pending.get(input.id);
    if (item) { pending.delete(input.id); item.cleanup(); item.resolve(input.result); }
  }
  if (input.type === 'dispose') { stop(); await handle?.dispose(); await ctx?.fiber.dispose(); process.exit(0); }
}
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let input;
  try { input = JSON.parse(line); } catch { send({ type: 'error', code: 'INVALID_WORKER_MESSAGE' }); return; }
  void dispatch(input).catch(() => send({ type: 'error', code: input.type === 'init' ? (input.resume ? 'LOCAL_RESUME_FAILED' : 'LOCAL_INIT_FAILED') : 'LOCAL_RUNTIME_FAILED' }));
});
process.stdin.on('end', () => { stop(); process.exit(0); });
