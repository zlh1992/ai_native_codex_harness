import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const helper = path.resolve('bin/background-process.py');
test('detached process is reused and foreign PID identity is never signalled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-process-'));
  const record = path.join(root, 'process.json');
  const run = (action, ...args) => execFileSync('python3', [helper, action, record, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let saved;
  try {
    const args = [root, path.join(root, 'out.log'), process.execPath, '-e', 'setInterval(() => {}, 1000)'];
    const pid = run('start', ...args);
    assert.match(pid, /^\d+$/);
    assert.equal(run('status'), pid);
    assert.equal(run('start', ...args), pid);
    saved = fs.readFileSync(record, 'utf8');
    const changed = JSON.parse(saved);
    changed.identity = 'not the recorded process';
    fs.writeFileSync(record, JSON.stringify(changed));
    assert.throws(() => run('stop'), /PID identity changed/);
    process.kill(Number(pid), 0);
    fs.writeFileSync(record, saved);
    run('stop');
    assert.throws(() => run('status'));
    assert.equal(fs.existsSync(record), false);
  } finally {
    if (saved && fs.existsSync(record)) { fs.writeFileSync(record, saved); run('stop'); }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
