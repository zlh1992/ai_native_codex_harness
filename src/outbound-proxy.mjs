import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError, invariant } from './errors.mjs';

const exec = promisify(execFile);
const bypass = 'localhost,127.0.0.1,::1';

export function outboundProxyMode(value = 'system') {
  if (value === 'system' || value === 'direct') return value;
  let url;
  try { url = new URL(value); } catch { /* sanitized error below */ }
  invariant(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && url.pathname === '/' && !url.search && !url.hash, 500, 'PROXY_CONFIGURATION_INVALID',
  'OUTBOUND_PROXY 必须为 system、direct 或不含凭据的 HTTP(S) 代理地址。');
  return url.origin;
}

export async function readSystemProxy(signal) {
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 65536, signal, env: { PATH: '/usr/bin:/bin:/usr/sbin' },
    });
    return stdout;
  } catch {
    throw new HttpError(503, 'PROXY_UNAVAILABLE', '无法读取系统代理；请检查 VPN 或系统网络配置。');
  }
}

export function parseSystemProxy(text) {
  invariant(/<dictionary>\s*\{/.test(text), 503, 'PROXY_UNAVAILABLE', '系统代理配置读取失败。');
  const fields = Object.fromEntries([...text.matchAll(/^\s*(HTTPEnable|HTTPProxy|HTTPPort|HTTPSEnable|HTTPSProxy|HTTPSPort|SOCKSEnable|ProxyAutoConfigEnable|ProxyAutoDiscoveryEnable)\s*:\s*(.*?)\s*$/gm)].map(m => [m[1], m[2]]));
  const endpoint = scheme => {
    if (fields[`${scheme}Enable`] !== '1') return undefined;
    const host = fields[`${scheme}Proxy`], port = Number(fields[`${scheme}Port`]);
    invariant(host && !/[\s/@?#]/.test(host) && Number.isInteger(port) && port > 0 && port <= 65535,
      503, 'PROXY_CONFIGURATION_INVALID', '系统代理地址或端口无效。');
    // macOS's HTTPS entry describes an HTTP CONNECT proxy, not TLS to the proxy.
    return outboundProxyMode(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`);
  };
  const result = { http: endpoint('HTTP'), https: endpoint('HTTPS') };
  invariant(!['ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable'].some(key => fields[key] === '1')
    && (result.http || result.https || fields.SOCKSEnable !== '1'), 503, 'PROXY_CONFIGURATION_UNSUPPORTED',
  '命令环境需要 HTTP/HTTPS 系统代理或 TUN；仅 PAC/SOCKS 配置请设置 OUTBOUND_PROXY 为 HTTP(S) 入口。');
  return result;
}

export async function resolveOutboundProxy(config, { signal, read = readSystemProxy } = {}) {
  const mode = outboundProxyMode(config.outboundProxy ?? 'system');
  if (mode === 'direct') return { mode };
  if (mode !== 'system') return { mode, http: mode, https: mode };
  return { mode, ...parseSystemProxy(await read(signal)) };
}

export function proxyEnvironment(proxy) {
  const env = { no_proxy: bypass, NO_PROXY: bypass };
  if (proxy.http) Object.assign(env, { http_proxy: proxy.http, HTTP_PROXY: proxy.http, npm_config_proxy: proxy.http });
  if (proxy.https) Object.assign(env, { https_proxy: proxy.https, HTTPS_PROXY: proxy.https, npm_config_https_proxy: proxy.https });
  return env;
}

export function browserProxyOptions(config) {
  const mode = outboundProxyMode(config.outboundProxy ?? 'system');
  // No fixed proxy in system mode: Chrome subscribes to macOS config changes.
  if (mode === 'system') return {};
  if (mode === 'direct') return { args: ['--no-proxy-server'] };
  return { proxy: { server: mode, bypass: '<loopback>' } };
}
