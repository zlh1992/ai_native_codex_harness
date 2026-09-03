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

  #git(cwd, args, { allowFailure = false } = {}) {
    const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: path.join(this.runtimeRoot, 'git'),
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
      },
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) throw new HttpError(500, 'GIT_FAILED', 'Git 操作失败。', result.error.message);
    if (result.status !== 0 && !allowFailure) {
      throw new HttpError(409, 'GIT_FAILED', 'Git 操作失败。', String(result.stderr || result.stdout || '').trim());
    }
    return { ok: result.status === 0, stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim() };
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
    this.#git(projectRoot, ['worktree', 'add', '-b', branchName, treePath, 'HEAD']);
    return { treePath, branchName };
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
