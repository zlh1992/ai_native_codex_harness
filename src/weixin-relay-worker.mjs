// One private IPC child per Portal identity; no HTTP listener or Codex runtime.
import { createDecipheriv, createHash } from 'node:crypto';
import { fetch, ProxyAgent, Agent } from 'undici';
import { getBotQr, getQrStatus, getUpdates, sendMessage } from '../.tools/weixin-transport.mjs';
import { resolveOutboundProxy } from './outbound-proxy.mjs';

export function weixinUrl(value, media = false) {
  const url = new URL(value);
  const allowed = media ? ['weixin.qq.com', 'weixin.qq.com.cn', 'wxapp.tc.qq.com'] : ['weixin.qq.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !allowed.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) throw new Error('WEIXIN_URL_REJECTED');
  return url.href;
}

async function boundedFetch(url, init = {}, { proxyMode = 'system', media = false, limit = 1024 * 1024 } = {}) {
  weixinUrl(url, media);
  const proxy = await resolveOutboundProxy({ outboundProxy: proxyMode });
  const dispatcher = proxy.https ? new ProxyAgent(proxy.https) : new Agent();
  try {
    const response = await fetch(url, { ...init, dispatcher, redirect: 'error', signal: init.signal || AbortSignal.timeout(60_000) });
    if (Number(response.headers.get('content-length')) > limit) throw new Error('WEIXIN_FILE_LIMIT');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('WEIXIN_FILE_LIMIT'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    return { ok: response.ok, status: response.status, headers: response.headers, text: async () => bytes.toString(), arrayBuffer: async () => bytes };
  } finally { await dispatcher.close(); }
}

async function execute(op, p) {
  const fetchImpl = (url, init) => boundedFetch(url, init, { proxyMode: p.proxyMode });
  const common = { baseUrl: weixinUrl(p.baseUrl || 'https://ilinkai.weixin.qq.com'), token: p.token, fetchImpl, locale: 'zh-CN' };
  if (op === 'qr') return getBotQr({ ...common, botType: '3' });
  if (op === 'qrStatus') return getQrStatus({ ...common, qrcode: p.qrcode });
  if (op === 'poll') return getUpdates({ ...common, get_updates_buf: p.cursor || '', timeoutMs: 25_000 });
  if (op === 'send') return sendMessage({ ...common, msg: { from_user_id: '', to_user_id: p.senderId,
    client_id: p.clientId, message_type: 2, message_state: 2, context_token: p.contextToken,
    item_list: [{ type: 1, text_item: { text: p.text } }] } });
  if (op === 'download') {
    const item = p.file;
    if (Number(item.len) > 50 * 1024 * 1024 || !item.media?.aes_key) throw new Error('WEIXIN_FILE_INVALID');
    const url = item.media.full_url || `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=${encodeURIComponent(item.media.encrypt_query_param || '')}`;
    const response = await boundedFetch(url, {}, { proxyMode: p.proxyMode, media: true, limit: 50 * 1024 * 1024 + 32 });
    if (!response.ok) throw new Error('WEIXIN_DOWNLOAD_FAILED');
    let key = Buffer.from(item.media.aes_key, 'base64');
    if (key.length === 32 && /^[a-f0-9]{32}$/i.test(key.toString())) key = Buffer.from(key.toString(), 'hex');
    if (key.length !== 16) throw new Error('WEIXIN_FILE_INVALID');
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    const bytes = Buffer.concat([decipher.update(await response.arrayBuffer()), decipher.final()]);
    if (bytes.length > 50 * 1024 * 1024 || (item.len && Number(item.len) !== bytes.length)
      || (item.md5 && createHash('md5').update(bytes).digest('hex') !== item.md5.toLowerCase())) throw new Error('WEIXIN_FILE_INVALID');
    return { bytes: bytes.toString('base64') };
  }
  throw new Error('WEIXIN_OPERATION_INVALID');
}

process.on('message', async ({ id, op, params }) => {
  try { const result = await execute(op, params); process.send?.({ id, result }); }
  catch { process.send?.({ id, error: 'WEIXIN_TRANSPORT_FAILED' }); }
});
process.on('disconnect', () => process.exit(0));
