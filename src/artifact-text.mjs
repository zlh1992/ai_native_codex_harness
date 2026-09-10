import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { buildSeatbeltProfile } from './sandbox.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const worker = path.join(source, 'artifact-text-worker.mjs');
const modules = path.resolve(source, '../node_modules');
const metadata = [];
for (let directory = source; directory !== path.dirname(directory); directory = path.dirname(directory)) metadata.push(directory);

export async function artifactText(file, limit = 64 * 1024) {
  const ext = path.extname(file.path).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.xlsx', '.xls', '.pptx'].includes(ext)) {
    return { content: '', complete: false, reason: 'UNSUPPORTED_FORMAT' };
  }
  if (!['.pdf', '.docx'].includes(ext)) {
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); }
    catch { return { content: '', complete: false, reason: 'UNSUPPORTED_FORMAT' }; }
    if (content.includes('\0')) return { content: '', complete: false, reason: 'UNSUPPORTED_FORMAT' };
    if (!content.trim()) return { content: '', complete: false, reason: 'NO_EXTRACTABLE_TEXT' };
    const complete = file.bytes.length <= limit;
    return { content: file.bytes.subarray(0, limit).toString('utf8'), complete, reason: complete ? null : 'TEXT_LIMIT' };
  }
  if (process.platform !== 'darwin') return { content: '', complete: false, reason: 'EXTRACTOR_UNAVAILABLE' };
  const profile = buildSeatbeltProfile({ readableRoots: [source, modules, path.resolve(source, '../package.json')],
    readableMetadataPaths: metadata, writableRoots: [], networkAccess: false });
  return new Promise(resolve => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '--max-old-space-size=256', worker, ext, String(limit)], {
      cwd: source, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: '/nonexistent', TMPDIR: '/nonexistent' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = ''; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 512 * 1024) { failed = true; child.kill('SIGKILL'); }
    });
    child.stdin.on('error', () => {});
    child.on('error', () => { failed = true; });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        if (failed || code !== 0) throw new Error('failed');
        const result = JSON.parse(output);
        if (typeof result.content !== 'string' || typeof result.complete !== 'boolean') throw new Error('invalid');
        resolve(result);
      } catch { resolve({ content: '', complete: false, reason: 'EXTRACTION_FAILED' }); }
    });
    child.stdin.end(file.bytes);
  });
}
