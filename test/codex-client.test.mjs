import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { CodexAppServerClient } from '../src/codex-client.mjs';

const fakeCodex = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;

async function stopClient(client) {
  if (client.process?.exitCode === null) {
    const exited = once(client, 'exit');
    client.stop();
    await exited;
  }
}

test('native child receives current configured proxy, never conflicting host overrides', async () => {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'PORTAL_TEST_SECRET'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = 'host-value-must-not-leak';
  let reads = 0, port = 19001;
  const readProxy = async () => { reads++; return `<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : ${port}\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : ${port}\n}`; };
  try {
    for (const mode of ['system', 'system', 'http://127.0.0.1:19003', 'direct']) {
      const client = new CodexAppServerClient(loadConfig({ CODEX_BIN: fakeCodex, OUTBOUND_PROXY: mode }), { readProxy });
      try {
        await client.start();
        const env = await client.request('test/proxy-environment');
        const expected = mode === 'system' ? `http://127.0.0.1:${port}` : mode === 'direct' ? null : mode;
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(env[key], expected);
        for (const key of ['ALL_PROXY', 'all_proxy', 'PORTAL_TEST_SECRET']) assert.equal(env[key], null);
        assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
        assert.equal(env.no_proxy, env.NO_PROXY);
      } finally { await stopClient(client); }
      port++;
    }
    assert.equal(reads, 2, 'explicit/direct must not consult the system proxy');
  } finally {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test('unreadable or unsupported system proxy prevents spawning the native client', async () => {
  for (const readProxy of [async () => { throw Object.assign(new Error('system unavailable'), { code: 'PROXY_UNAVAILABLE' }); },
    async () => '<dictionary> {\n ProxyAutoConfigEnable : 1\n}']) {
    const client = new CodexAppServerClient(loadConfig({ CODEX_BIN: fakeCodex }), { readProxy });
    await assert.rejects(client.start(), error => /^PROXY_/.test(error.code));
    assert.equal(client.process, null);
    assert.equal(client.started, false);
  }
});

test('isolated search client retains configured proxy after resetting its environment', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-search-proxy-'));
  const client = new CodexAppServerClient({ ...loadConfig({ CODEX_BIN: fakeCodex, OUTBOUND_PROXY: 'http://127.0.0.1:19004' }),
    searchOnly: true, rootDir });
  try {
    await client.start();
    const env = await client.request('test/proxy-environment');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:19004');
    assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY);
    assert.equal(env.HOME, rootDir);
    assert.equal(env.CODEX_HOME, rootDir);
    assert.equal(env.ALL_PROXY, null);
  } finally {
    await stopClient(client);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('stopping while system proxy lookup is pending never launches an orphan process', async () => {
  let release;
  const readProxy = () => new Promise(resolve => { release = resolve; });
  const client = new CodexAppServerClient(loadConfig({ CODEX_BIN: fakeCodex }), { readProxy });
  const starting = client.start();
  client.stop();
  release('<dictionary> {\n HTTPEnable : 0\n}');
  await assert.rejects(starting, { code: 'CODEX_START_CANCELLED' });
  assert.equal(client.process, null);
  assert.equal(client.started, false);
});

test('app-server version mismatch is durable and machine-identifiable', async () => {
  const config = { ...loadConfig({ CODEX_BIN: fakeCodex }), codexCliVersion: '0.0.0-test' };
  const client = new CodexAppServerClient(config);
  await assert.rejects(client.start(), (error) => {
    assert.equal(error.code, 'CODEX_PROTOCOL_VERSION_MISMATCH');
    assert.match(error.message, /需要 0\.0\.0-test/);
    return true;
  });
  assert.equal(client.lastError?.code, 'CODEX_PROTOCOL_VERSION_MISMATCH');
  if (client.process?.exitCode === null) {
    const exited = once(client, 'exit');
    client.stop();
    await exited;
  }
});

test('app-server refuses ready when native long-term memory remains enabled', async () => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/tmp/fake-native-memory-enabled';
  const client = new CodexAppServerClient(loadConfig({ CODEX_BIN: fakeCodex }));
  try {
    await assert.rejects(client.start(), (error) => {
      assert.equal(error.code, 'CODEX_NATIVE_MEMORY_ENABLED');
      return true;
    });
    assert.equal(client.started, false);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    client.stop();
  }
});
