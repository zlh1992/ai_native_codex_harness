import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { TokenUsageLedger, normalizeUsage, beijingDay } from '../src/token-usage.mjs';
import { defaultEffort, rootEffort, rootModel, ROOT_MODELS } from '../src/models.mjs';
import { createLocalUsageMeter } from '../src/local-usage.mjs';

function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec("CREATE TABLE users(id TEXT,role TEXT,display_name TEXT,username TEXT); INSERT INTO users VALUES('staff','user','Staff','staff'),('boss','admin','Boss','boss')");
  const ledger = new TokenUsageLedger(sql); t.after(() => sql.close());
  return { sql, ledger };
}
const user = { id: 'staff', role: 'user' }, boss = { id: 'boss', role: 'admin' };
const sample = (input, output, cached = 0) => ({ inputTokens: input, outputTokens: output, cachedInputTokens: cached, totalTokens: input+output });
const event = (threadId, turnId, total, last = total) => ({ threadId, turnId, tokenUsage: { total, last } });

test('role defaults, visible models and explicit/chat/default effort precedence', () => {
  const config = { codexModel: 'gpt-6.1-sol', codexReasoningEffort: 'high' };
  assert.equal(defaultEffort(config,user), 'medium'); assert.equal(defaultEffort(config,boss), 'high');
  assert.deepEqual(ROOT_MODELS.map((model) => model.id), ['gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
  for (const role of [user,boss]) for (const model of ROOT_MODELS) assert.equal(rootModel(config, { preferredModel: model.id }, role), model.id);
  for (const role of [user, boss]) {
    assert.equal(rootModel(config, { preferredModel: 'gpt-6-astra' }, role), 'gpt-6.1-sol');
    assert.throws(() => rootModel({ codexModel: 'gpt-6-astra' }, {}, role), { code: 'INVALID_MODEL' });
  }
  assert.equal(rootEffort(config, {}, user), 'medium');
  assert.equal(rootEffort(config, { preferredEffort: 'max' }, user), 'max');
  assert.equal(rootEffort(config, { preferredEffort: 'max' }, user, 'low'), 'low');
  assert.throws(() => rootEffort(config, {}, user, ''), /推理强度/);
  assert.throws(() => rootEffort(config, {}, user, 'invented'), /推理强度/);
});

test('cumulative samples count incremental root/child/auxiliary consumption once and retain attribution', t => {
  const { ledger, sql } = fixture(t);
  ledger.stream('root',true);
  const first = ledger.start({ id:'one', user, model:'gpt-6-astra', effort:'medium', streamId:'root', turnId:'turn1', runId:'r' });
  ledger.codex(event('root','turn1',sample(100,20,10)));
  ledger.codex(event('root','turn1',sample(100,20,10)));
  ledger.codex(event('root','turn1',sample(300,70,30),sample(200,50,20)));
  ledger.finish(first);
  ledger.start({ id:'two',user,model:'gpt-5.6-sol',effort:'high',streamId:'root',turnId:'turn2' });
  ledger.codex(event('root','turn2',sample(450,100,40),sample(150,30,10)));
  ledger.finish('two');
  // A late duplicate of the old turn must neither charge again nor rewind the baseline.
  ledger.codex(event('root','turn1',sample(300,70,30)));
  ledger.codex(event('root','turn2',sample(450,100,40)));
  ledger.stream('child',true);
  ledger.start({ id:'child',user,model:'gpt-5.6-luna',kind:'subagent',streamId:'child',turnId:'childTurn',runId:'r' });
  ledger.codex(event('child','childTurn',sample(40,10))); ledger.finish('child');
  ledger.start({ id:'search',user:boss,model:'gpt-5.6-luna',effort:'low',kind:'search' });
  ledger.sample('search',sample(20,5),'gpt'); ledger.finish('search');
  const data = ledger.dashboard();
  assert.equal(data.totals.gpt.incompleteCalls,0);
  assert.equal(data.totals.gpt.totalTokens,625); assert.equal(data.totals.employeeGpt.totalTokens,600); assert.equal(data.totals.bossGpt.totalTokens,25);
  assert.equal(data.totals.gpt.inputTokens,510); assert.equal(data.totals.gpt.cachedInputTokens,40);
  assert.equal(data.models.find(m=>m.model==='gpt-6-astra').totalTokens,370);
  assert.equal(data.employees[0].totalTokens,600);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM token_usage_calls').get().n,4);
  assert.equal(ledger.dashboard({ model:'gpt-6-astra' }).totals.gpt.totalTokens,370);
});

test('unknown resume/fork baselines exclude inherited history; missing and interrupted usage stays incomplete', t => {
  const { ledger,sql }=fixture(t);
  ledger.stream('old');
  ledger.start({ id:'resumed',user,model:'gpt-5.6-sol',streamId:'old',turnId:'new' });
  ledger.codex(event('old','new',sample(10000,2000),sample(100,20))); ledger.finish('resumed');
  assert.equal(ledger.dashboard().totals.gpt.totalTokens,120);
  assert.equal(ledger.dashboard().totals.gpt.incompleteCalls,1);
  ledger.stream('fork'); ledger.codex(event('fork','past',sample(9000,1000)));
  ledger.start({ id:'forked',user,model:'gpt-6-astra',streamId:'fork',turnId:'new' });
  ledger.codex(event('fork','new',sample(9040,1010),sample(40,10))); ledger.finish('forked');
  ledger.start({ id:'missing',user,model:'gpt-6-astra' }); ledger.recover();
  assert.equal(ledger.dashboard().totals.gpt.totalTokens,170);
  assert.equal(ledger.dashboard().totals.gpt.missingCalls,1);
  assert.equal(ledger.dashboard().totals.gpt.pendingCalls,0);
  assert.equal(new TokenUsageLedger(sql).dashboard().totals.gpt.totalTokens,170);
  ledger.codex(event('fork','new',sample(9050,1015))); // late final usage
  assert.equal(ledger.dashboard().totals.gpt.totalTokens,185);
});

test('local counters use disjoint cache buckets, replacement samples, no estimated missing zeros and Beijing boundaries', t => {
  const {ledger,sql}=fixture(t);
  assert.deepEqual(normalizeUsage({ inputTokens:100,outputTokens:20,cacheReadTokens:30,cacheWriteTokens:10 },'qwen'),
    {inputTokens:140,outputTokens:20,cachedInputTokens:30,cacheWriteInputTokens:10,reasoningOutputTokens:0,totalTokens:160});
  const id=ledger.start({ id:'local',user:boss,engine:'qwen',model:'local-model',kind:'compaction' });
  ledger.sample(id,{inputTokens:100,outputTokens:20,cacheReadTokens:30});
  ledger.sample(id,{inputTokens:100,outputTokens:20,cacheReadTokens:30}); ledger.finish(id);
  ledger.sample(id,{inputTokens:-1,outputTokens:20});
  sql.prepare('UPDATE token_usage_calls SET created_at=? WHERE id=?').run('2026-09-21T16:00:00.000Z',id);
  assert.equal(beijingDay('2026-09-21T15:59:59Z'),'2026-09-21');
  assert.equal(ledger.dashboard({from:'2026-09-21',to:'2026-09-21'}).totals.qwen.totalTokens,0);
  assert.equal(ledger.dashboard({from:'2026-09-22',to:'2026-09-22'}).totals.qwen.totalTokens,150);
  assert.throws(()=>ledger.dashboard({from:'2026-02-30'}),/日期/);
  assert.throws(()=>ledger.dashboard({from:'2026-09-22',to:'2026-09-21'}),/范围/);
  assert.throws(()=>ledger.dashboard({engine:'bogus'}),/引擎/);
});

test('local stream meter captures provider SSE usage including compaction and preserves bytes without leaking text', async () => {
  const packets=[]; const meter=createLocalUsageMeter(p=>packets.push(p));
  const source='data: {"choices":[{"delta":{"content":"PRIVATE_MARKER"}}]}\n\ndata: {"usage":{"prompt_tokens":120,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":5},"total_tokens":140}}\n\ndata: [DONE]\n\n';
  const fakeFetch=async()=>new Response(new ReadableStream({start(c){const bytes=new TextEncoder().encode(source); c.enqueue(bytes.slice(0,19)); c.enqueue(bytes.slice(19)); c.close();}}));
  async function* request(){ const response=await meter.fetchMetered(fakeFetch,'http://127.0.0.1/v1/chat/completions',{}); assert.equal(await response.text(),source); yield {type:'finish'}; }
  for await (const _ of meter.stream({purpose:'compaction'},request)) {}
  assert.deepEqual(packets.map(p=>p.type),['usage_start','usage_sample','usage_end']);
  assert.equal(packets[0].kind,'compaction'); assert.equal(packets[1].usage.inputTokens,120); assert.equal(packets[1].usage.cachedInputTokens,30);
  assert.equal(JSON.stringify(packets).includes('PRIVATE_MARKER'),false);
  packets.length=0;
  const response=await meter.fetchMetered(async()=>new Response('data: [DONE]\n\n'),'http://127.0.0.1/v1/chat/completions',{}); await response.text();
  assert.deepEqual(packets.map(p=>p.type),['usage_start','usage_end']);
  packets.length=0;
  await assert.rejects(meter.fetchMetered(async()=>{throw new Error('offline');},'',{}));
  assert.deepEqual(packets.map(p=>p.type),['usage_start','usage_end']);
});
