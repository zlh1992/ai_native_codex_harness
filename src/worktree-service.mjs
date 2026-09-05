import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HttpError, invariant } from './errors.mjs';

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonical(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

export class WorktreeService {
  constructor(config) {
    this.config = config;
    this.treesRoot = path.resolve(config.treesRoot || path.join(config.dataDir || path.dirname(config.workspacesRoot), 'trees'));
    this.runtimeRoot = path.resolve(config.runtimeRoot || path.join(config.dataDir || path.dirname(config.workspacesRoot), 'runtime'));
    fs.mkdirSync(this.treesRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.runtimeRoot, 'git'), { recursive: true, mode: 0o700 });
  }

  #git(cwd, args, { allowFailure = false, input = undefined, trim = true, maxBuffer = 64 * 1024 * 1024 } = {}) {
    const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      input,
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: path.join(this.runtimeRoot, 'git'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      timeout: 30_000,
      maxBuffer,
    });
    if (result.error) throw new HttpError(500, 'GIT_FAILED', 'Git 操作失败。', result.error.message);
    if (result.status !== 0 && !allowFailure) {
      throw new HttpError(409, 'GIT_FAILED', 'Git 操作失败。', String(result.stderr || result.stdout || '').trim());
    }
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    return { ok: result.status === 0, stdout: trim ? stdout.trim() : stdout, stderr: trim ? stderr.trim() : stderr };
  }

  isReady(projectRoot) {
    if (!fs.existsSync(projectRoot)) return false;
    const top = this.#git(projectRoot, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (!top.ok || canonical(top.stdout) !== canonical(projectRoot)) return false;
    return this.#git(projectRoot, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).ok;
  }

  initialize(projectRoot) {
    const root = path.resolve(projectRoot);
    invariant(fs.existsSync(root) && fs.statSync(root).isDirectory(), 404, 'PROJECT_DIRECTORY_MISSING', '项目目录不存在。');
    const top = this.#git(root, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (!top.ok || canonical(top.stdout) !== canonical(root)) this.#git(root, ['init', '-b', 'main']);
    this.#git(root, ['config', 'user.name', 'Codex Harness']);
    this.#git(root, ['config', 'user.email', 'codex-harness@localhost']);
    if (!this.#git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).ok) {
      this.#git(root, ['add', '-A']);
      this.#git(root, ['commit', '-m', 'Initialize Codex Harness project']);
    } else if (this.#git(root, ['status', '--porcelain']).stdout) {
      this.#git(root, ['add', '-A']);
      this.#git(root, ['commit', '-m', 'Prepare Codex Harness sharing snapshot']);
    }
    return { ready: true, branch: this.#git(root, ['branch', '--show-current']).stdout || 'main' };
  }

  treePath(accessId) {
    invariant(/^[a-f0-9-]{36}$/i.test(String(accessId)), 400, 'INVALID_ACCESS_ID', '授权标识无效。');
    const target = path.resolve(this.treesRoot, accessId);
    invariant(inside(this.treesRoot, target), 500, 'TREE_PATH_INVALID', '工作树路径配置无效。');
    return target;
  }

  createShare({ projectRoot, projectId, accessId }) {
    invariant(this.isReady(projectRoot), 409, 'GIT_REQUIRED', '项目尚未准备为 Git 仓库，请先在驾驶舱中初始化。');
    const treePath = this.treePath(accessId);
    invariant(!fs.existsSync(treePath), 409, 'TREE_EXISTS', '授权工作树已经存在。');
    const compactProject = String(projectId).replaceAll('-', '').slice(0, 8);
    const compactAccess = String(accessId).replaceAll('-', '').slice(0, 8);
    const branchName = `portal/share/${compactProject}/${compactAccess}`;
    const baseSha = this.#git(projectRoot, ['rev-parse', 'HEAD']).stdout;
    const patch = this.#git(projectRoot, ['diff', '--binary', '--full-index', 'HEAD', '--', '.'], { trim: false }).stdout;
    const untracked = this.#git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false }).stdout
      .split('\0').filter(Boolean);
    this.#git(projectRoot, ['worktree', 'add', '-b', branchName, treePath, baseSha]);
    try {
      if (patch) this.#git(treePath, ['apply', '--whitespace=nowarn', '-'], { input: patch });
      for (const relative of untracked) {
        const source = path.resolve(projectRoot, relative);
        const destination = path.resolve(treePath, relative);
        invariant(inside(projectRoot, source) && inside(treePath, destination), 409, 'SHARE_SNAPSHOT_INVALID', '共享快照包含越界路径。');
        const stat = fs.lstatSync(source);
        invariant(stat.isFile() && !stat.isSymbolicLink(), 409, 'SHARE_SNAPSHOT_INVALID', `共享快照不支持符号链接: ${relative}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, destination);
        fs.chmodSync(destination, stat.mode & 0o777);
      }
      return { treePath, branchName, baseSha, includedLocalChanges: Boolean(patch || untracked.length), untrackedFiles: untracked.length };
    } catch (error) {
      this.#git(projectRoot, ['worktree', 'remove', '--force', treePath], { allowFailure: true });
      this.#git(projectRoot, ['branch', '-D', branchName], { allowFailure: true });
      throw error;
    }
  }

  isReusableShare({ treePath }) {
    const target = path.resolve(treePath);
    if (!inside(this.treesRoot, target) || !fs.existsSync(target)) return false;
    const top = this.#git(target, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    return top.ok && canonical(top.stdout) === canonical(target);
  }

  discardUnboundShare({ projectRoot, treePath, branchName }) {
    const target = path.resolve(treePath);
    invariant(inside(this.treesRoot, target), 500, 'TREE_PATH_INVALID', '授权工作树路径配置无效。');
    if (fs.existsSync(target)) this.#git(projectRoot, ['worktree', 'remove', '--force', target]);
    this.#git(projectRoot, ['worktree', 'prune'], { allowFailure: true });
    if (branchName) this.#git(projectRoot, ['branch', '-D', branchName], { allowFailure: true });
    return { removed: true };
  }

  removeShare({ projectRoot, treePath }) {
    const target = path.resolve(treePath);
    invariant(inside(this.treesRoot, target), 500, 'TREE_PATH_INVALID', '授权工作树路径配置无效。');
    if (!fs.existsSync(target)) {
      this.#git(projectRoot, ['worktree', 'prune'], { allowFailure: true });
      return { removed: true, dirty: false, missing: true };
    }
    const status = this.#git(target, ['status', '--porcelain'], { allowFailure: true });
    if (!status.ok || status.stdout) return { removed: false, dirty: true, preservedPath: target };
    this.#git(projectRoot, ['worktree', 'remove', target]);
    this.#git(projectRoot, ['worktree', 'prune'], { allowFailure: true });
    return { removed: true, dirty: false };
  }
}
