// Build only the pinned transport exports, never upstream's bot/agent service.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'tools/weixin/upstream.json')));
const upstream = path.resolve(process.argv[2] || '');
if (!process.argv[2] || execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== pin.commit
  || execFileSync('git', ['-C', upstream, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('A clean checkout at the pinned commit is required.');
const output = path.join(root, '.tools/weixin-transport.mjs'); fs.mkdirSync(path.dirname(output), { recursive: true });
await build({ stdin: { contents: `export {getBotQr,getQrStatus,getUpdates,sendMessage} from './src/platforms/weixin/official/api.ts';`, resolveDir: upstream },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: output, logLevel: 'silent' });
const sha256 = createHash('sha256').update(fs.readFileSync(output)).digest('hex');
fs.writeFileSync(`${output}.json`, JSON.stringify({ ...pin, sha256 }) + '\n');
console.log(JSON.stringify({ commit: pin.commit, sha256, built: true }));
