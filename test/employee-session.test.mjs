import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { requestSessionCookieName } from '../src/session-selection.mjs';

test('session selection never falls back when an explicit selector is absent, invalid or contradictory', () => {
  assert.equal(requestSessionCookieName({headers:{}}),'codex_harness_session');
  const selector='a'.repeat(32);
  assert.equal(requestSessionCookieName({headers:{'x-portal-session':selector}}),`codex_harness_session_${selector}`);
  assert.equal(requestSessionCookieName({headers:{},url:`/api/file?portal_session=${selector}`}),`codex_harness_session_${selector}`);
  for(const value of ['none','','../../invalid',['a','b']])assert.throws(()=>requestSessionCookieName({headers:{'x-portal-session':value}}),{code:'AUTH_REQUIRED'});
  assert.throws(()=>requestSessionCookieName({headers:{'x-portal-session':selector},url:`/api/me?portal_session=${'b'.repeat(32)}`}),{code:'AUTH_REQUIRED'});
});

test('two frontend tab stores isolate login/logout, persist reload, and keep credential tokens out of URLs', async t => {
  const storage=()=>{const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
  const a=await import('../public/employee-session.js?fixture=a'); const b=await import('../public/employee-session.js?fixture=b');
  const aStore=storage(),bStore=storage();a.configureEmployeeSession(true,aStore);b.configureEmployeeSession(true,bStore);
  assert.equal(a.employeeSessionSelector(),'none');assert.equal(b.employeeSessionSelector(),'none');
  a.saveEmployeeSession('a'.repeat(32)); b.saveEmployeeSession('b'.repeat(32));
  a.clearEmployeeSession();assert.equal(a.employeeSessionSelector(),'none');assert.equal(b.employeeSessionSelector(),'b'.repeat(32));
  const reload=await import('../public/employee-session.js?fixture=reload');reload.configureEmployeeSession(true,bStore);
  assert.equal(reload.employeeSessionSelector(),'b'.repeat(32));
  assert.equal(b.sessionUrl('/api/raw?path=a.txt'),`/api/raw?path=a.txt&portal_session=${'b'.repeat(32)}`);
  assert.equal(b.sessionUrl('https://outside.example/api/me'),'https://outside.example/api/me');
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let captured;
  globalThis.fetch=async (...args)=>{captured=args;return {};};
  await b.sessionFetch('/api/me',{headers:{'x-csrf-token':'synthetic-csrf'}});
  assert.equal(captured[1].headers.get('x-portal-session'),'b'.repeat(32));
  assert.equal(captured[1].headers.get('x-csrf-token'),'synthetic-csrf');
  assert.equal(captured[0],'/api/me');
  b.configureEmployeeSession(false);assert.equal(b.sessionUrl('/api/raw'),'/api/raw');
  await b.sessionFetch('/api/me');assert.equal(captured[1].headers,undefined);
});

test('all non-client employee streams and private resource links carry tab selection', () => {
  const app=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const graph=fs.readFileSync(new URL('../public/work-graph.js',import.meta.url),'utf8');
  assert.match(app,/sessionFetch\(`\/api\/chats\//);
  assert.match(app,/return sessionUrl\(`\/api\/projects\//);
  assert.match(graph,/new EventSource\(sessionUrl\(/);
  assert.match(graph,/const artifactUrl = .*sessionUrl\(/);
  assert.match(graph,/const endpoint = sessionUrl\(/);
  assert.match(graph,/await sessionFetch\(/);
  assert.match(app,/saveEmployeeSession\(sessionSelector\); sessionClient.reset\(\)/);
});
