import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { loadConfig } from '../src/config.mjs';
import { CodexAppServerClient } from '../src/codex-client.mjs';

const fakeCodex = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;

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
