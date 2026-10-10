import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { TokenDashboard, usageValue } from '../public/token-dashboard.js';
const bucket = (total = 0) => ({ totalTokens:total,inputTokens:total,outputTokens:0,cachedInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0,calls:0,missingCalls:0,incompleteCalls:0,pendingCalls:0 });
const data = () => ({ from:'2026-09-22',to:'2026-09-22',startedAt:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T01:00:00Z',availableModels:['<unsafe>'],
  totals:{gpt:bucket(100),bossGpt:bucket(100),employeeGpt:bucket(),qwen:bucket()},days:[{date:'2026-09-22',gpt:bucket(100),qwen:bucket()}],
  employees:[],models:[{...bucket(100),model:'<unsafe>',effort:'medium'}],kinds:[],localQwen:{enabled:false} });
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,api) {
  const {document,window}=parseHTML('<html><body><section id="root"></section></body></html>');
  const descriptor=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value');
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get:descriptor.get,set(value){for(const option of this.options)option.removeAttribute('selected');const match=[...this.options].find(option=>option.value===value);if(match)match.setAttribute('selected','');}});
  const original=globalThis.document;globalThis.document=document;
  const dashboard=new TokenDashboard({root:document.querySelector('#root'),api});
  t.after(()=>{dashboard.stop();globalThis.document=original;Object.defineProperty(window.HTMLSelectElement.prototype,'value',descriptor);});
  return {dashboard,document,window,root:dashboard.root};
}

test('dashboard renders safe totals, missing versus disabled, and sends selected filters',async t=>{
  const calls=[];const f=fixture(t,async url=>{calls.push(url);return data();});
  f.dashboard.start([{id:'staff',displayName:'<script>bad</script>',role:'user'}]);await tick();
  assert.match(f.root.textContent,/GPT 总量/);assert.match(f.root.textContent,/引擎未启用/);
  assert.equal(f.root.querySelector('script'),null);assert.equal(f.root.querySelector('unsafe'),null);
  assert.equal(usageValue({...bucket(),calls:2,missingCalls:2}),'—');assert.equal(usageValue(bucket()),'0');
  f.root.querySelector('[name="userId"]').value='staff';f.root.querySelector('[name="engine"]').value='gpt';
  await f.dashboard.refresh();assert.match(calls.at(-1),/userId=staff/);assert.match(calls.at(-1),/engine=gpt/);
  assert.match(calls.at(-1),/from=\d{4}-\d{2}-\d{2}/);
});

test('dashboard discards older requests and clears data after logout',async t=>{
  const pending=[];const f=fixture(t,()=>new Promise(resolve=>pending.push(resolve)));
  f.dashboard.start([]);const second=f.dashboard.refresh();
  const newer=data();newer.totals.gpt.totalTokens=222;pending[1](newer);await second;
  const older=data();older.totals.gpt.totalTokens=111;pending[0](older);await tick();
  assert.equal(f.root.querySelector('.metric b').textContent,'222');
  const late=f.dashboard.refresh();f.dashboard.stop();pending[2](data());await late;
  assert.equal(f.root.childNodes.length,0);
});
