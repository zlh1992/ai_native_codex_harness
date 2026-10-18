import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { invariant } from './errors.mjs';
import { CommandQueue } from './command-queue.mjs';

const queues = new WeakMap();
const runtimes = new WeakMap();
export function pathAncestors(values) {
  const result = new Set();
  for (const value of values) for (let dir = path.dirname(value); ; dir = path.dirname(dir)) {
    result.add(dir); if (dir === path.dirname(dir)) break;
  }
  return [...result];
}

function commandRuntime(config) {
  if (runtimes.has(config)) return runtimes.get(config);
  const candidates = config.commandPythonBin ? [config.commandPythonBin] : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3.13', '/usr/local/bin/python3'];
  const python = candidates.find(file => {
    if (!fs.existsSync(file)) return false;
    const result = spawnSync(file, ['--version'], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } });
    const match = /Python (\d+)\.(\d+)/.exec(result.stdout || '');
    return result.status === 0 && match && (Number(match[1]) > 3 || Number(match[1]) === 3 && Number(match[2]) >= 10);
  });
  invariant(python, 503, 'COMMAND_RUNTIME_UNAVAILABLE', '项目执行需要可直接启动的 Python 3.10+；请管理员设置 COMMAND_PYTHON_BIN。');
  const binary = fs.realpathSync(python);
  const root = path.join(config.runtimeRoot || path.join(path.dirname(config.workspacesRoot), 'runtime'), '.command-tools');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of ['python', 'python3']) {
    const target = path.join(root, name);
    try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(binary, target);
  }
  const result = { root: fs.realpathSync(root), binary };
  runtimes.set(config, result); return result;
}

export function commandDiagnostic(result, networkAccess) {
  if (result.ok) return result;
  let errorCode = 'COMMAND_FAILED', recoveryHint = '检查命令退出信息；确认副作用后再重试。';
  if (result.aborted) errorCode = 'COMMAND_ABORTED';
  else if (result.timedOut || /(?:ETIMEDOUT|timed? out|curl: \(28\))/i.test(result.output)) { errorCode = 'COMMAND_TIMEOUT'; recoveryHint = '请求超时；核对网络或服务状态后手动重试。'; }
  else if (/fork failed|EAGAIN|resource temporarily unavailable/i.test(result.output)) { errorCode = 'COMMAND_RESOURCE_EXHAUSTED'; recoveryHint = '宿主资源暂不可用，请稍后重试；不要反复启动相同任务。'; }
  else if (/openssl\.cnf|xcrun_db|realpath:.*Operation not permitted/i.test(result.output)) { errorCode = 'COMMAND_RUNTIME_UNAVAILABLE'; recoveryHint = '执行运行库受限，请管理员检查项目运行环境。'; }
  else if (!networkAccess && /(?:connect|resolve|network|socket|urlopen).*?(?:denied|permitted|failed|unreachable)|curl: \([567]\)/i.test(result.output)) { errorCode = 'NETWORK_DISABLED'; recoveryHint = '此账号未授权联网，请联系管理员。'; }
  else if (/当前环境异常|完成验证|captcha|verify you are human/i.test(result.output)) { errorCode = 'HUMAN_ACTION_REQUIRED'; recoveryHint = '请使用对话浏览器，并请求用户接管验证。'; }
  return { ...result, errorCode, retryable: false, recoveryHint };
}

function seatbeltString(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function readableRoot(root) {
  return `(literal "${seatbeltString(root)}") (subpath "${seatbeltString(root)}")`;
}

function literalPath(value) {
  return `(literal "${seatbeltString(value)}")`;
}

export function buildSeatbeltProfile({ userRoot, readableRoots = [], readableMetadataPaths = [], writableRoots = [], deniedPaths = [], networkAccess,
  systemRoots = ['/bin', '/sbin', '/usr', '/System', '/Library/Apple', '/Library/Developer', '/Library/Frameworks', '/Library/Python', '/Library/Ruby', '/Applications/Xcode.app', '/opt/homebrew', '/usr/local', '/private/var/select'] }) {
  const allowedWriteRoots = [...new Set([...(writableRoots.length ? writableRoots : [userRoot])].filter(Boolean))];
  const runtimeRoots = [
    ...allowedWriteRoots, ...readableRoots,
    ...systemRoots,
  ].filter((candidate) => allowedWriteRoots.includes(candidate) || readableRoots.includes(candidate) || fs.existsSync(candidate));
  return [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    `(allow file-read* ${runtimeRoots.map(readableRoot).join(' ')})`,
    readableMetadataPaths.length ? `(allow file-read-metadata ${[...new Set(readableMetadataPaths)].map(literalPath).join(' ')})` : '',
    `(allow file-write* ${allowedWriteRoots.map(readableRoot).join(' ')})`,
    ...deniedPaths.flatMap((denied) => [
      `(deny file-read* (literal "${seatbeltString(denied)}") (subpath "${seatbeltString(denied)}"))`,
      `(deny file-write* (literal "${seatbeltString(denied)}") (subpath "${seatbeltString(denied)}"))`,
    ]),
    networkAccess ? '(allow network-outbound)' : '',
  ].filter(Boolean).join(' ');
}

function killGroup(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

export async function runSandboxedCommand(options) {
  const { config, signal, runKey = Symbol('command'), authorize = () => {} } = options;
  if (!queues.has(config)) queues.set(config, new CommandQueue(config.portalMaxExecuteLeases || 11));
  return queues.get(config).run(runKey, signal, async () => {
    if (signal?.aborted) return commandDiagnostic({ ok: false, aborted: true, exitCode: null, output: '命令已取消。' }, false);
    await authorize();
    const networkAccess = options.project.projectType !== 'local_private' && options.user.networkAccess;
    return commandDiagnostic(await launchCommand(options), networkAccess);
  });
}

async function launchCommand({ config, workspace, project, user, command, cwd = '', signal }) {
  invariant(process.platform === 'darwin', 501, 'SANDBOX_UNAVAILABLE', '当前安全命令执行器仅支持 macOS Seatbelt。');
  const projectRoot = fs.realpathSync(workspace.projectRoot(project));
  const runtimeRoot = fs.realpathSync(workspace.ensureAccessRuntimeRoot(user.id, project.accessId));
  const requestedCwd = workspace.resolve(project, cwd || '', { mustExist: true, directory: true }).target;
  const home = path.join(runtimeRoot, 'home');
  const tmp = path.join(runtimeRoot, 'tmp');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const runtime = commandRuntime(config);
  const profile = buildSeatbeltProfile({
    writableRoots: [projectRoot, runtimeRoot],
    readableRoots: [runtime.root, '/private/etc/ssl', '/private/etc/resolv.conf', '/private/etc/hosts'],
    readableMetadataPaths: pathAncestors([projectRoot, runtimeRoot, runtime.root, runtime.binary, '/Library/Developer']),
    deniedPaths: project.accessKind === 'shared' ? [path.join(projectRoot, '.git')] : [],
    networkAccess: project.projectType === 'local_private' ? false : user.networkAccess,
  });
  const cpuSeconds = Math.max(5, Math.ceil(config.commandTimeoutMs / 1000));
  const wrapped = `ulimit -t ${cpuSeconds}; ulimit -n 256; ${String(command)}`;
  const env = {
    PATH: `${runtime.root}:${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: `${tmp}${path.sep}`,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'dumb',
    CI: 'true',
    XDG_CACHE_HOME: path.join(home, '.cache'),
    PIP_CACHE_DIR: path.join(home, '.cache', 'pip'),
    PIP_REQUIRE_VIRTUALENV: 'true',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    npm_config_cache: path.join(home, '.cache', 'npm'),
    CODEX_HARNESS_PROJECT_ROOT: projectRoot,
  };

  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, '/bin/zsh', '-f', '-c', wrapped], {
      cwd: requestedCwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
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
    const abort = () => {
      aborted = true;
      killGroup(child, 'SIGTERM');
      setTimeout(() => killGroup(child, 'SIGKILL'), 1500).unref();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ ok: false, exitCode: null, output: error.message, timedOut, aborted, truncated });
    });
    child.on('close', (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      const output = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: code === 0 && !timedOut && !aborted,
        exitCode: code,
        signal: closeSignal,
        output: `${output}${truncated ? '\n[output truncated]' : ''}${timedOut ? '\n[command timed out]' : ''}`.trim(),
        timedOut,
        aborted,
        truncated,
      });
    });
  });
}
