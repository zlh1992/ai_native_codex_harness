import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
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
  assert.equal(commandDiagnostic({ ok: false, output: 'curl: (7) Failed to connect' }, true, true).errorCode, 'PROXY_UNAVAILABLE');
  assert.equal(commandDiagnostic({ ok: false, output: 'zsh: command not found: missing' }, true).errorCode, 'COMMAND_TOOL_NOT_FOUND');
});

test('proxy routes HTTPS, Git and venv installation; PATH persists and disabled users cannot use the proxy', { skip: process.platform !== 'darwin', timeout: 90000 }, async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portal-proxy-')));
  const config = { workspacesRoot: path.join(base, 'workspaces'), runtimeRoot: path.join(base, 'runtime'), commandTimeoutMs: 25000, commandMaxOutputBytes: 65536 };
  const workspace = new WorkspaceService(config), user = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', networkAccess: true };
  const project = { accessId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', userId: user.id, slug: 'proxy', name: 'Proxy' };
  workspace.createProject(project); const root = workspace.projectRoot(project);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const git = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git'].find(file => fs.existsSync(file));
  const setup = args => { const result = spawnSync(git, args, { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  const repo = path.join(base, 'repo'); setup(['init', '--bare', repo]);
  const source = path.join(base, 'source'); setup(['init', source]); fs.writeFileSync(path.join(source, 'evidence.txt'), 'PUBLIC_GIT_FIXTURE');
  setup(['-C', source, 'add', '.']); setup(['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  setup(['-C', source, 'push', repo, 'HEAD:master']); setup(['--git-dir=' + repo, 'update-server-info']);
  const tlsConfig = path.join(base, 'tls.cnf'), certificate = path.join(root, 'test-ca.pem'), key = path.join(base, 'key.pem');
  fs.writeFileSync(tlsConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=tls.proxy.test\n[ext]\nsubjectAltName=DNS:tls.proxy.test\n');
  assert.equal(spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate, '-days', '1', '-config', tlsConfig]).status, 0);
  const wheel = path.join(root, 'portal_probe-1.0-py3-none-any.whl');
  let result = await runSandboxedCommand({ config: { ...config, outboundProxy: 'direct' }, workspace, user, project, command: `python3 -m venv .venv && python3 -c 'import zipfile; z=zipfile.ZipFile("${path.basename(wheel)}","w"); z.writestr("portal_probe.py", "def main(): print(123456789)\\n"); z.writestr("portal_probe-1.0.dist-info/METADATA", "Metadata-Version: 2.1\\nName: portal-probe\\nVersion: 1.0\\n"); z.writestr("portal_probe-1.0.dist-info/WHEEL", "Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"); z.writestr("portal_probe-1.0.dist-info/entry_points.txt", "[console_scripts]\\nportal-probe = portal_probe:main\\n"); z.writestr("portal_probe-1.0.dist-info/RECORD", ""); z.close()'` });
  assert.equal(result.ok, true, result.output);
  let node = 'A'; const hits = [];
  const tls = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, (req, res) => res.end('HTTPS_NODE_' + node));
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const makeProxy = async () => {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      const url = new URL(req.url);
      if (url.hostname === 'pkg.proxy.test') { res.end(fs.readFileSync(wheel)); return; }
      const file = path.resolve(repo, '.' + url.pathname.replace(/^\/repo/, ''));
      if (!file.startsWith(repo + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
      res.end(fs.readFileSync(file));
    });
    server.on('connect', (req, client, head) => {
      hits.push(req.url);
      const upstream = net.connect(tls.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream).pipe(client); });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy());
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    return server;
  };
  const proxy = await makeProxy(); config.outboundProxy = `http://127.0.0.1:${proxy.address().port}`;
  t.after(() => new Promise(resolve => tls.close(resolve)));
  const run = command => runSandboxedCommand({ config, workspace, user, project, command });
  result = await run(`curl -fsS --max-time 8 --cacert test-ca.pem https://tls.proxy.test:${tls.address().port}/ && git clone -q http://git.proxy.test/repo downloaded && cat downloaded/evidence.txt && python3 -m pip install --no-deps --trusted-host pkg.proxy.test http://pkg.proxy.test/${path.basename(wheel)} && mkdir -p .tools/bin && printf '#!/bin/sh\\necho BINARY_OK\\n' > .tools/bin/project-binary && chmod +x .tools/bin/project-binary`);
  assert.equal(result.ok, true, result.output); assert.match(result.output, /PUBLIC_GIT_FIXTURE/); assert.match(result.output, /HTTPS_NODE_A/); assert.doesNotMatch(result.output, /xcrun_db/);
  result = await run('portal-probe && project-binary && git --version');
  assert.equal(result.ok, true, result.output); assert.match(result.output, /123456789/); assert.match(result.output, /BINARY_OK/);
  assert.ok(hits.some(url => url.startsWith('tls.proxy.test:'))); assert.ok(hits.some(url => url.includes('git.proxy.test/repo'))); assert.ok(hits.some(url => url.includes('pkg.proxy.test')));
  node = 'B';
  result = await run(`curl -fsS --max-time 8 --cacert test-ca.pem https://tls.proxy.test:${tls.address().port}/`);
  assert.match(result.output, /HTTPS_NODE_B/);
  const proxy2 = await makeProxy(), port2 = proxy2.address().port;
  config.outboundProxy = `http://127.0.0.1:${port2}`;
  result = await run(`curl -fsS --max-time 8 --cacert test-ca.pem https://tls.proxy.test:${tls.address().port}/`); assert.equal(result.ok, true, result.output);
  // Force connection refusal, then verify recovery on the following manual call.
  const reserved = net.createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve)); const closedPort = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  config.outboundProxy = `http://127.0.0.1:${closedPort}`;
  result = await run('curl -fsS --max-time 2 http://git.proxy.test/repo/HEAD'); assert.equal(result.errorCode, 'PROXY_UNAVAILABLE'); assert.equal(result.retryable, false);
  config.outboundProxy = `http://127.0.0.1:${port2}`;
  result = await run('curl -fsS --max-time 5 http://git.proxy.test/repo/HEAD'); assert.equal(result.ok, true, result.output);
  const before = hits.length; user.networkAccess = false;
  result = await run(`curl --proxy http://127.0.0.1:${port2} -fsS --max-time 2 http://git.proxy.test/repo/HEAD`);
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'NETWORK_DISABLED'); assert.equal(hits.length, before);
  result = await run('test -z "$https_proxy" && portal-probe'); assert.equal(result.ok, true, result.output);
});
