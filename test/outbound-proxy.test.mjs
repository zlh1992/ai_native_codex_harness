import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundProxyMode, parseSystemProxy, resolveOutboundProxy, proxyEnvironment, browserProxyOptions } from '../src/outbound-proxy.mjs';

const settings = port => `<dictionary> {\n HTTPEnable : 1\n HTTPProxy : 127.0.0.1\n HTTPPort : ${port}\n HTTPSEnable : 1\n HTTPSProxy : ::1\n HTTPSPort : ${port}\n}`;

test('system proxy is resolved anew, including changed ports and disabled proxies', async () => {
  let port = 19001, calls = 0;
  const read = async () => { calls++; return port ? settings(port) : '<dictionary> {\n HTTPEnable : 0\n}'; };
  const config = { outboundProxy: 'system' };
  assert.equal((await resolveOutboundProxy(config, { read })).http, 'http://127.0.0.1:19001');
  port = 19002;
  const proxy = await resolveOutboundProxy(config, { read });
  assert.equal(proxy.http, 'http://127.0.0.1:19002'); assert.equal(proxy.https, 'http://[::1]:19002');
  const env = proxyEnvironment(proxy);
  assert.equal(env.http_proxy, proxy.http); assert.equal(env.HTTPS_PROXY, proxy.https);
  assert.equal(env.npm_config_https_proxy, proxy.https); assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
  port = 0;
  assert.deepEqual(await resolveOutboundProxy(config, { read }), { mode: 'system', http: undefined, https: undefined });
  assert.equal(calls, 3);
  await assert.rejects(resolveOutboundProxy(config, { read: async () => { throw new Error('unavailable'); } }));
});

test('explicit/direct and native Chrome modes do not pin the system proxy', async () => {
  const read = () => { throw new Error('must not read system'); };
  assert.deepEqual(await resolveOutboundProxy({ outboundProxy: 'direct' }, { read }), { mode: 'direct' });
  const explicit = await resolveOutboundProxy({ outboundProxy: 'http://127.0.0.1:19003' }, { read });
  assert.equal(explicit.https, 'http://127.0.0.1:19003');
  assert.deepEqual(browserProxyOptions({}), {});
  assert.deepEqual(browserProxyOptions({ outboundProxy: 'direct' }), { args: ['--no-proxy-server'] });
  assert.equal(browserProxyOptions({ outboundProxy: explicit.mode }).proxy.server, explicit.mode);
});

test('malformed, credential-bearing and unsupported system proxies fail without exposing secrets', () => {
  for (const value of ['ftp://127.0.0.1', 'http://test:private-marker@127.0.0.1', 'http://127.0.0.1/path', 'invalid']) {
    assert.throws(() => outboundProxyMode(value), error => error.code === 'PROXY_CONFIGURATION_INVALID' && !error.message.includes('private-marker'));
  }
  for (const input of ['invalid', settings(0), '<dictionary> {\n SOCKSEnable : 1\n}', '<dictionary> {\n ProxyAutoConfigEnable : 1\n}']) {
    assert.throws(() => parseSystemProxy(input));
  }
});
