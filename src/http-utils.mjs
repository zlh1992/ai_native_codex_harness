import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './errors.mjs';

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.json', 'application/json; charset=utf-8'],
]);

export function securityHeaders(config) {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    ...(config.cookieSecure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

export function sendJson(res, status, payload, config, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders(config),
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

export async function readBody(req, limit) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过允许大小。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '请求体超过允许大小。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 1024 * 1024) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try { return JSON.parse(body.toString('utf8')); } catch {
    throw new HttpError(400, 'INVALID_JSON', '请求 JSON 无效。');
  }
}

export function serveStatic(res, config, pathname) {
  let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (!path.extname(relative)) relative = 'index.html';
  const target = path.resolve(config.publicDir, relative);
  if (!target.startsWith(`${config.publicDir}${path.sep}`) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return false;
  }
  const body = fs.readFileSync(target);
  const immutable = /\.[a-f0-9]{8,}\./i.test(path.basename(target));
  res.writeHead(200, {
    ...securityHeaders(config),
    'content-type': MIME.get(path.extname(target)) || 'application/octet-stream',
    'content-length': String(body.length),
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
  return true;
}

export function sseHeaders(res, config) {
  res.writeHead(200, {
    ...securityHeaders(config),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

export function sse(res, event, payload) {
  if (res.writableEnded || res.destroyed) return;
  const id = Number(payload?.eventId);
  res.write(`${Number.isSafeInteger(id) && id > 0 ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
