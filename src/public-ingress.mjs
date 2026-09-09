import { isIP } from 'node:net';
import { invariant } from './errors.mjs';

export function publicIngressConfig(env) {
  const origin = (value) => {
    if (!value) return '';
    const input = String(value).trim();
    let url;
    try { url = new URL(input); } catch { throw new Error('公网地址必须是完整 HTTPS origin。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('公网地址必须是无路径、无凭据的 HTTPS origin。');
    }
    return url.origin;
  };
  const publicOrigin = origin(env.PUBLIC_ORIGIN);
  const bossPublicOrigin = origin(env.BOSS_PUBLIC_ORIGIN);
  const employeePublicOrigin = origin(env.EMPLOYEE_PUBLIC_ORIGIN);
  const publicOrigins = Object.freeze([...new Set([
    publicOrigin, bossPublicOrigin, employeePublicOrigin,
    ...String(env.PUBLIC_ORIGINS || '').split(',').map(origin),
  ].filter(Boolean))]);
  const trustProxyProvider = env.TRUST_PROXY_PROVIDER || 'generic';
  if (!['generic', 'cloudflare'].includes(trustProxyProvider)) throw new Error('TRUST_PROXY_PROVIDER 无效。');
  if (trustProxyProvider === 'cloudflare' && (!publicOrigins.length || ['false', '0'].includes(String(env.TRUST_PROXY)))) {
    throw new Error('Cloudflare 代理模式需要固定公网 origin 和 TRUST_PROXY=true。');
  }
  return { publicOrigin, publicOrigins, bossPublicOrigin, employeePublicOrigin, trustProxyProvider };
}

export function requestIngress(req, config) {
  const host = String(req.headers.host || '').toLowerCase();
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map(name => `${name}:${config.port}`));
  const local = localHosts.has(host);
  const configured = config.publicOrigins.find(origin => new URL(origin).host === host);
  invariant(!config.publicOrigins.length || local || configured, 421, 'HOST_REJECTED', '请求域名未配置。');
  const peer = req.socket.remoteAddress || 'unknown';
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
  const proto = config.trustProxy && !local ? String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim().toLowerCase() : 'http';
  let ip = peer;
  if (config.trustProxy && !local) {
    if (config.trustProxyProvider === 'cloudflare') {
      const candidate = String(req.headers['cf-connecting-ip'] || '').trim();
      invariant(loopback && configured && proto === 'https' && isIP(candidate), 400, 'PROXY_REJECTED', '公网代理来源无效。');
      ip = candidate;
    } else {
      ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || peer;
    }
  }
  return { origin: `${proto}://${host}`, ip, secure: config.cookieSecure || proto === 'https', configured };
}

export function validateRequestOrigin(req, config) {
  const ingress = requestIngress(req, config);
  const origin = String(req.headers.origin || '');
  invariant(!origin || origin === ingress.origin, 403, 'ORIGIN_REJECTED', '请求来源不受信任。');
}
