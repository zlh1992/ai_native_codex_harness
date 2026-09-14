import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { securityHeaders } from './http-utils.mjs';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// A release is a single immutable snapshot, including transitive ESM imports.
// HTML itself is never immutable and always points at the current snapshot.
export function createStaticAssets(config) {
  const sources = new Map();
  for (const entry of fs.readdirSync(config.publicDir, { withFileTypes: true })) {
    if (entry.isFile() && types[path.extname(entry.name)]) {
      sources.set(`/${entry.name}`, fs.readFileSync(path.join(config.publicDir, entry.name)));
    }
  }
  const vendor = path.join(config.rootDir, 'node_modules/sortablejs/modular/sortable.complete.esm.js');
  if (fs.existsSync(vendor)) sources.set('/vendor/sortable.js', fs.readFileSync(vendor));
  const hash = createHash('sha256');
  for (const [name, bytes] of [...sources].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(bytes).update('\0');
  const version = hash.digest('hex').slice(0, 20);
  const prefix = `/assets/${version}`;
  const contents = new Map();
  for (const [name, bytes] of sources) {
    let content = bytes;
    if (name.endsWith('.html')) {
      content = Buffer.from(bytes.toString().replace(/\b(src|href)="(\/[^"?#]+\.(?:js|css))"/g,
        (match, attribute, asset) => sources.has(asset) ? `${attribute}="${prefix}${asset}"` : match));
    } else if (name.endsWith('.js')) {
      content = Buffer.from(bytes.toString().replaceAll("import('/vendor/sortable.js')", `import('${prefix}/vendor/sortable.js')`));
    }
    contents.set(name, content);
  }
  return {
    version,
    serve(res, pathname) {
      const versioned = pathname.startsWith('/assets/');
      if (versioned && !pathname.startsWith(`${prefix}/`)) return false;
      const name = versioned ? pathname.slice(prefix.length) : pathname;
      const body = contents.get(name);
      // HTML has a canonical route, not an indefinitely cached versioned URL.
      if (!body || (versioned && name.endsWith('.html'))) return false;
      res.writeHead(200, { ...securityHeaders(config),
        'content-type': types[path.extname(name)], 'content-length': String(body.length),
        'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      res.end(body);
      return true;
    },
  };
}
