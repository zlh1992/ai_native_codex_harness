import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { requestIngress, validateRequestOrigin } from '../src/public-ingress.mjs';

const config = loadConfig({ PORT: '4310', BOSS_PUBLIC_ORIGIN: 'https://boss.example.com',
  EMPLOYEE_PUBLIC_ORIGIN: 'https://staff.example.com', TRUST_PROXY_PROVIDER: 'cloudflare' });
const req = (headers = {}, peer = '127.0.0.1') => ({ socket: { remoteAddress: peer }, headers: {
  host: 'boss.example.com', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '203.0.113.7', ...headers,
} });

test('fixed ingress rejects unlisted hosts, invalid proxy identity and foreign origins', () => {
  assert.throws(() => requestIngress(req({ host: 'evil.example.com' }), config), { code: 'HOST_REJECTED' });
  for (const headers of [{ 'cf-connecting-ip': '' }, { 'cf-connecting-ip': 'bad,203.0.113.7' }, { 'x-forwarded-proto': 'http' }]) {
    assert.throws(() => requestIngress(req(headers), config), { code: 'PROXY_REJECTED' });
  }
  assert.throws(() => requestIngress(req({}, '192.0.2.1'), config), { code: 'PROXY_REJECTED' });
  assert.throws(() => validateRequestOrigin(req({ origin: 'https://staff.example.com' }), config), { code: 'ORIGIN_REJECTED' });
  assert.throws(() => validateRequestOrigin(req({ origin: 'null' }), config), { code: 'ORIGIN_REJECTED' });
});

test('both role origins are valid, XFF cannot change Cloudflare client IP, localhost ignores proxy claims', () => {
  for (const host of ['boss.example.com', 'staff.example.com']) {
    const request = req({ host, origin: `https://${host}`, 'x-forwarded-for': '198.51.100.1' });
    validateRequestOrigin(request, config);
    assert.equal(requestIngress(request, config).ip, '203.0.113.7');
    assert.equal(requestIngress(request, config).secure, true);
  }
  const local = req({ host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' });
  validateRequestOrigin(local, config);
  assert.equal(requestIngress(local, config).ip, '127.0.0.1');
  assert.equal(requestIngress(local, config).secure, false);
});

test('configuration fails closed and quick mode retains dynamic host support', () => {
  for (const value of ['http://boss.example.com', 'https://u:p@boss.example.com', 'https://boss.example.com/login', 'not-a-url']) {
    assert.throws(() => loadConfig({ BOSS_PUBLIC_ORIGIN: value }));
  }
  assert.throws(() => loadConfig({ TRUST_PROXY_PROVIDER: 'cloudflare' }));
  assert.throws(() => loadConfig({ ...{ BOSS_PUBLIC_ORIGIN: 'https://boss.example.com' }, TRUST_PROXY: 'false', TRUST_PROXY_PROVIDER: 'cloudflare' }));
  const quick = loadConfig({});
  const request = req({ host: 'random.trycloudflare.com', origin: 'https://random.trycloudflare.com' });
  validateRequestOrigin(request, quick);
  assert.equal(requestIngress(request, quick).secure, true);
});
