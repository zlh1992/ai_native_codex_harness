import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../src/config.mjs';

const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('generated app-server schema contains every native employee workflow contract', () => {
  const version = JSON.parse(read('../protocol/version.json'));
  assert.equal(version.codexCli, '0.164.0-alpha.11.1');
  assert.equal(loadConfig({}).codexCliVersion, version.codexCli);
  assert.match(version.generatedBy, /--experimental/);
  assert.match(read('../protocol/generated/v2/ThreadStartParams.ts'), /dynamicTools\?: Array<DynamicToolSpec>/);
  assert.ok(read('../src/codex-client.mjs').includes('Codex 协议版本不匹配'));
  const client = read('../protocol/generated/ClientRequest.ts');
  for (const method of ['thread/fork', 'thread/read', 'thread/goal/set', 'thread/goal/get', 'skills/list', 'turn/start', 'turn/interrupt', 'turn/steer', 'config/read']) {
    assert.match(client, new RegExp(`"${method.replace('/', '\\/')}"`));
  }
  assert.ok(read('../protocol/generated/v2/TurnSteerParams.ts').includes('expectedTurnId: string'));
  const requests = read('../protocol/generated/ServerRequest.ts');
  for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/call']) {
    assert.ok(requests.includes(`"method": "${method}"`));
  }
  const notifications = read('../protocol/generated/ServerNotification.ts');
  for (const method of ['turn/diff/updated', 'turn/plan/updated', 'item/fileChange/patchUpdated', 'item/completed', 'serverRequest/resolved']) {
    assert.ok(notifications.includes(`"method": "${method}"`));
  }
  const item = read('../protocol/generated/v2/ThreadItem.ts');
  assert.ok(item.includes('"type": "collabAgentToolCall"'));
  assert.ok(item.includes('model: string | null'));
});

test('local launcher surfaces Codex startup failure instead of appearing hung', () => {
  const server = read('../src/server.mjs');
  const common = read('../bin/_common.sh');
  const start = read('../bin/start-local.sh');
  const status = read('../bin/status.sh');
  assert.ok(server.includes("codexStatus.lastError ? 'failed' : 'starting'"));
  assert.ok(common.includes('local_codex_failed()'));
  assert.ok(start.includes('Web 服务已启动，但 Codex app-server 启动失败。'));
  assert.ok(start.includes('仍在等待 Codex app-server'));
  assert.ok(status.includes('Codex app-server 启动失败'));
  assert.ok(start.indexOf('touch "$SERVER_LOG"') < start.indexOf('wc -l < "$SERVER_LOG"'));
  assert.ok(read('../bin/install-mac.sh').includes('npm ci --omit=dev --ignore-scripts'));
});

test('app-server launch policy fixes the native subagent limit and Luna model', () => {
  const source = read('../src/codex-client.mjs');
  assert.ok(source.includes('agents.max_concurrent_threads_per_session'));
  assert.ok(source.includes('agents.default_subagent_model'));
  assert.ok(source.includes("['default', 'worker', 'explorer']"));
  assert.ok(source.includes('agents.${role}.config_file'));
  assert.match(read('../portal-agents/luna.toml'), /^model = "gpt-5\.6-luna"/m);
  assert.ok(source.includes("'HOME', 'PATH', 'TMPDIR'"));
  assert.ok(!source.includes('const childEnv = { ...process.env }'));
  assert.ok(!source.match(/disabledFeatures[\s\S]{0,500}'multi_agent'/));
  assert.ok(source.includes("'memories'"));
  assert.ok(source.includes('memories.generate_memories=false'));
  assert.ok(source.includes('memories.use_memories=false'));
  assert.ok(read('../src/codex-service.mjs').includes('config: PORTAL_MEMORY_CONFIG'));
});

test('task turns discover and inject the bundled native skill', () => {
  const source = read('../src/codex-service.mjs');
  assert.ok(source.includes("'skills/extraRoots/set'"));
  assert.ok(source.includes("'skills/list'"));
  assert.ok(source.includes("type: 'skill'"));
  assert.match(read('../portal-skills/task-execution/SKILL.md'), /^---[\s\S]*name: task-execution/m);
});

test('employee quota and turn timeout remain hard server boundaries', () => {
  const server = read('../src/server.mjs');
  const service = read('../src/codex-service.mjs');
  assert.ok(server.includes("owner.role === 'user' ? Math.min(owner.maxProjects, 100)"));
  assert.ok(server.includes("'项目上限', 1, 100)"));
  assert.ok(service.includes("'TURN_TIMEOUT'"));
  assert.ok(service.includes('clearTimeout(active.turnTimer)'));
  assert.ok(service.includes("'PROJECT_AGENT_POLICY'"));
  assert.ok(service.includes("message.method === 'thread/started'"));
  assert.ok(service.includes("message.method === 'thread/settings/updated'"));
  assert.ok(service.includes("'thread/read', { threadId: cursor, includeTurns: false }"));
  assert.ok(service.includes('this.parentBySubagent.get(message.params?.threadId)') === false);
  assert.ok(server.includes("patch.status === 'disabled' || patch.passwordHash"));
  assert.ok(service.includes("sandbox: 'read-only'"));
  assert.ok(service.includes("sandboxPolicy: { type: 'readOnly', networkAccess: false }"));
});
