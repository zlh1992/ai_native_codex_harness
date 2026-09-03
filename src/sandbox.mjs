import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { invariant } from './errors.mjs';

function seatbeltString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function readableRoot(root) {
  return `(subpath "${seatbeltString(root)}")`;
}

export function buildSeatbeltProfile({ userRoot, networkAccess }) {
  const runtimeRoots = [
    userRoot,
    '/bin', '/sbin', '/usr', '/System',
    '/Library/Apple', '/Library/Developer', '/Library/Frameworks', '/Library/Python', '/Library/Ruby',
    '/Applications/Xcode.app',
    '/opt/homebrew', '/usr/local', '/private/var/select',
  ].filter((candidate) => candidate === userRoot || fs.existsSync(candidate));
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    `(allow file-read* ${runtimeRoots.map(readableRoot).join(' ')})`,
    `(allow file-write* ${readableRoot(userRoot)})`,
    networkAccess ? '(allow network-outbound)' : '',
  ].filter(Boolean).join(' ');
}

function killGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

export async function runSandboxedCommand({ config, workspace, project, user, command, cwd = '' }) {
  invariant(process.platform === 'darwin', 501, 'SANDBOX_UNAVAILABLE', '当前安全命令执行器仅支持 macOS Seatbelt。');
  const projectRoot = workspace.projectRoot(project);
  const userRoot = fs.realpathSync(workspace.ensureUserRoot(user.id));
  const requestedCwd = workspace.resolve(project, cwd || '', { mustExist: true, directory: true }).target;
  const home = path.join(userRoot, '.home');
  const tmp = path.join(userRoot, '.tmp');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const profile = buildSeatbeltProfile({ userRoot, networkAccess: user.networkAccess });
  const cpuSeconds = Math.max(5, Math.ceil(config.commandTimeoutMs / 1000));
  const wrapped = `ulimit -t ${cpuSeconds}; ulimit -n 256; ulimit -u 96; ${String(command)}`;
  const env = {
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    TMPDIR: `${tmp}${path.sep}`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: 'true',
    CODEX_HARNESS_PROJECT_ROOT: projectRoot,
  };

  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/zsh', '-lc', wrapped], {
      cwd: requestedCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const collect = (stream, chunk) => {
      if (bytes >= config.commandMaxOutputBytes) { truncated = true; return; }
      const remaining = config.commandMaxOutputBytes - bytes;
      const kept = chunk.subarray(0, remaining);
      chunks.push(Buffer.from(`[${stream}] `), kept);
      bytes += kept.length;
      if (kept.length < chunk.length) truncated = true;
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 1500).unref();
    }, config.commandTimeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, output: error.message, timedOut, truncated });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal,
        output: `${output}${truncated ? '\n[output truncated]' : ''}${timedOut ? '\n[command timed out]' : ''}`.trim(),
        timedOut,
        truncated,
      });
    });
  });
}
