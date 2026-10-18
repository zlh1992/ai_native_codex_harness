import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { CommandQueue } from '../src/command-queue.mjs';
import { WorkspaceService } from '../src/fs-service.mjs';
import { commandDiagnostic, runSandboxedCommand } from '../src/sandbox.mjs';

test('command queue serializes a run, bounds concurrency and cancels queued side effects', async () => {
  const queue = new CommandQueue(2), events = [], releases = [];
  const work = name => async () => { events.push(name); await new Promise(resolve => releases.push(resolve)); return name; };
  const a = queue.run('a', null, work('a1')), a2 = queue.run('a', null, work('a2'));
  const b = queue.run('b', null, work('b')), abort = new AbortController();
  const cancelled = queue.run('c', abort.signal, () => { throw new Error('must not launch'); });
  abort.abort(); assert.equal((await cancelled).errorCode, 'COMMAND_ABORTED');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['a1', 'b']);
  releases.shift()(); await a; await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['a1', 'b', 'a2']);
  releases.splice(0).forEach(resolve => resolve()); await Promise.all([a2, b]); assert.equal(queue.waiting.length, 0);
});

test('real Python venv and multiprocess commands work with a high host process count', { skip: process.platform !== 'darwin' }, async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-runtime-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const config = { workspacesRoot: path.join(base, 'workspaces'), runtimeRoot: path.join(base, 'runtime'), commandTimeoutMs: 60000, commandMaxOutputBytes: 65536 };
  const workspace = new WorkspaceService(config), user = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', networkAccess: true };
  const project = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', accessId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', userId: user.id, slug: 'runtime', name: 'Runtime' };
  workspace.createProject(project);
  // TLS is real, but its availability must not depend on an external site's routing.
  const certificate = path.join(workspace.projectRoot(project), 'test-ca.pem');
  const key = path.join(base, 'ephemeral.key'), tlsConfig = path.join(base, 'tls.cnf');
  fs.writeFileSync(tlsConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n');
  const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', tlsConfig], { encoding: 'utf8', timeout: 10000 });
  assert.equal(generated.status, 0, 'Ephemeral TLS fixture certificate generation failed');
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, (req, res) => { res.end('TLS_OK'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await runSandboxedCommand({ config, workspace, user, project, command: `test -r /private/etc/ssl/openssl.cnf && test -r /private/etc/ssl/cert.pem && python3 -m venv .venv && .venv/bin/python -c 'import ssl, subprocess, sys; assert sys.prefix != sys.base_prefix; assert all(subprocess.check_output(["/bin/echo", "child"]).strip() == b"child" for _ in range(8)); print("VENV_MULTIPROCESS_OK")' && .venv/bin/pip --version && curl --fail --max-time 10 --silent --cacert test-ca.pem --output /dev/null --write-out 'HTTPS_%{http_code}' https://127.0.0.1:${server.address().port}` });
  assert.equal(result.ok, true, result.output); assert.match(result.output, /VENV_MULTIPROCESS_OK/); assert.match(result.output, /HTTPS_200/);
  const cancelled = new AbortController(); cancelled.abort();
  const stopped = await runSandboxedCommand({ config, workspace, user, project, signal: cancelled.signal, command: 'touch must-not-exist' });
  assert.equal(stopped.errorCode, 'COMMAND_ABORTED'); assert.equal(fs.existsSync(path.join(workspace.projectRoot(project), 'must-not-exist')), false);
});

test('command diagnostics distinguish environment, timeout, policy and human intervention without replay', () => {
  for (const [output, network, code] of [
    ['fork failed: resource temporarily unavailable', true, 'COMMAND_RESOURCE_EXHAUSTED'],
    ['cannot read openssl.cnf', true, 'COMMAND_RUNTIME_UNAVAILABLE'],
    ['curl: (28) timeout', true, 'COMMAND_TIMEOUT'],
    ['curl: (7) failed to connect', false, 'NETWORK_DISABLED'],
    ['please complete captcha', true, 'HUMAN_ACTION_REQUIRED'],
  ]) { const result = commandDiagnostic({ ok: false, output }, network); assert.equal(result.errorCode, code); assert.equal(result.retryable, false); }
});
