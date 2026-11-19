import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { CodexAppServerClient, bootstrapPrivateCodexHome } from '../src/codex-client.mjs';

const fakeCodex = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;

// 测试用的隔离私有 home：预置合成凭据，避免真实 ~/.codex 凭据被链接进测试目录。
function privateHomeFixture(t, prefix = 'portal-private-home-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, 'auth.json'), '{"tokens":{}}\n', { mode: 0o600 });
  return root;
}

test('app-server version mismatch is durable and machine-identifiable', async (t) => {
  const config = { ...loadConfig({ CODEX_BIN: fakeCodex }), codexCliVersion: '0.0.0-test',
    codexHome: privateHomeFixture(t) };
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

test('private CODEX_HOME links upstream credentials and fails closed without them', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"tokens":{}}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.codex', 'installation_id'), 'synthetic-installation\n');

  const privateHome = path.join(root, '.data', 'codex-home');
  bootstrapPrivateCodexHome(privateHome, home);
  assert.equal(fs.lstatSync(path.join(privateHome, 'auth.json')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(privateHome, 'auth.json'), 'utf8'), '{"tokens":{}}\n');
  assert.equal(fs.readFileSync(path.join(privateHome, 'installation_id'), 'utf8'), 'synthetic-installation\n');
  assert.equal(fs.statSync(privateHome).mode & 0o777, 0o700);
  // 再次引导必须幂等，且不把已存在的私有凭据换成别的。
  bootstrapPrivateCodexHome(privateHome, home);
  assert.equal(fs.readFileSync(path.join(privateHome, 'auth.json'), 'utf8'), '{"tokens":{}}\n');

  const orphan = path.join(root, 'orphan-home');
  assert.throws(() => bootstrapPrivateCodexHome(orphan, path.join(root, 'no-such-upstream')),
    (error) => error.code === 'CODEX_HOME_UNAUTHENTICATED');
});

test('bootstrap refuses a CODEX_HOME shared with the desktop Codex client', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-codex-home-shared-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const shared = path.join(home, '.codex');
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(shared, 'auth.json'), '{"tokens":{}}\n', { mode: 0o600 });

  // 共用桌面家目录会让 pin 版本的 CLI 覆写对端的 models_cache.json，必须拒绝且不落盘。
  assert.throws(() => bootstrapPrivateCodexHome(shared, home),
    (error) => error.code === 'CODEX_HOME_SHARED_WITH_DESKTOP');
  assert.equal(fs.existsSync(path.join(shared, 'models_cache.json')), false);
});

test('app-server refuses ready when native long-term memory remains enabled', async (t) => {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = privateHomeFixture(t, 'fake-native-memory-enabled-');
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
