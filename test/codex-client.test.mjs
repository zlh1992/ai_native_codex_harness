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
