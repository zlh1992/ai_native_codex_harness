import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HttpError, invariant } from './errors.mjs';
import { graphRelativePath } from './work-graph-contract.mjs';

const RESERVED_DELIVERY_PARTS = new Set(['.git', '.codex', '.trash', '.home', '.tmp']);

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

  #git(cwd, args, { allowFailure = false, input = undefined, trim = true, maxBuffer = 64 * 1024 * 1024, encoding = 'utf8' } = {}) {
    const result = spawnSync('/usr/bin/git', ['-C', cwd, ...args], {
      encoding,
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
    const stdout = encoding === null ? result.stdout : String(result.stdout || '');
    const stderr = String(result.stderr || '');
    return { ok: result.status === 0, stdout: trim && encoding !== null ? stdout.trim() : stdout, stderr: trim ? stderr.trim() : stderr };
  }

  #assertDeliverableIndex(cwd) {
    const entries = this.#git(cwd, ['ls-files', '-s', '-z'], { trim: false }).stdout.split('\0').filter(Boolean);
    for (const entry of entries) {
      const match = entry.match(/^(\d+) [0-9a-f]+ \d+\t([\s\S]+)$/i);
      invariant(match, 409, 'DELIVERY_INDEX_INVALID', 'Git 索引包含无法验证的条目。');
      const [, mode, relative] = match;
      const parts = relative.split('/').map((part) => part.normalize('NFKC').toLowerCase());
      invariant(!parts.some((part) => RESERVED_DELIVERY_PARTS.has(part)),
        409, 'DELIVERY_RESERVED_PATH', `交付快照包含保留路径: ${relative}`);
      invariant(['100644', '100755'].includes(mode),
        409, 'DELIVERY_UNSUPPORTED_ENTRY', `交付快照只支持普通文件: ${relative}`);
    }
  }

  #snapshot(cwd, message) {
    this.#git(cwd, ['add', '-A']);
    try { this.#assertDeliverableIndex(cwd); }
    catch (error) {
      this.#git(cwd, ['reset', '--mixed', 'HEAD'], { allowFailure: true });
      throw error;
    }
    const staged = this.#git(cwd, ['diff', '--cached', '--quiet'], { allowFailure: true });
    if (!staged.ok) this.#git(cwd, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', message]);
    const [commitSha, treeSha] = this.#git(cwd, ['rev-parse', 'HEAD', 'HEAD^{tree}']).stdout.split('\n');
    invariant(/^[0-9a-f]{40,64}$/i.test(commitSha) && /^[0-9a-f]{40,64}$/i.test(treeSha),
      500, 'DELIVERY_SNAPSHOT_INVALID', 'Git 未返回有效的交付快照。');
    return { commitSha, treeSha };
  }

  isReady(projectRoot) {
    if (!fs.existsSync(projectRoot)) return false;
    const metadata = this.#git(projectRoot, ['rev-parse', '--show-toplevel', '--verify', 'HEAD'], { allowFailure: true });
    if (!metadata.ok) return false;
    const [top, head] = metadata.stdout.split('\n');
    return Boolean(top && /^[0-9a-f]{40,64}$/i.test(head || '') && canonical(top) === canonical(projectRoot));
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
      this.#assertDeliverableIndex(root);
      this.#git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'Initialize Codex Harness project']);
    } else if (this.#git(root, ['status', '--porcelain']).stdout) {
      this.#git(root, ['add', '-A']);
      this.#assertDeliverableIndex(root);
      this.#git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Prepare Codex Harness sharing snapshot']);
    }
    return { ready: true, branch: this.#git(root, ['branch', '--show-current']).stdout || 'main' };
  }

  treePath(accessId) {
    invariant(/^[a-f0-9-]{36}$/i.test(String(accessId)), 400, 'INVALID_ACCESS_ID', '授权标识无效。');
    const target = path.resolve(this.treesRoot, accessId);
    invariant(inside(this.treesRoot, target), 500, 'TREE_PATH_INVALID', '工作树路径配置无效。');
    return target;
  }

  createShare({ projectRoot, projectId, accessId, baseline = null }) {
    invariant(this.isReady(projectRoot), 409, 'GIT_REQUIRED', '项目尚未准备为 Git 仓库，请先在驾驶舱中初始化。');
    const treePath = this.treePath(accessId);
    invariant(!fs.existsSync(treePath), 409, 'TREE_EXISTS', '授权工作树已经存在。');
    const compactProject = String(projectId).replaceAll('-', '').slice(0, 8);
    const compactAccess = String(accessId).replaceAll('-', '').slice(0, 8);
    const branchName = `portal/share/${compactProject}/${compactAccess}`;
    const includedLocalChanges = Boolean(this.#git(projectRoot, ['status', '--porcelain']).stdout);
    const untracked = this.#git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z'], { trim: false }).stdout
      .split('\0').filter(Boolean);
    baseline ||= this.#snapshot(projectRoot, `Codex Harness sharing baseline for access ${accessId}`);
    try {
      this.#git(projectRoot, ['worktree', 'add', '-b', branchName, treePath, baseline.commitSha]);
      return {
        treePath, branchName, baseSha: baseline.commitSha, baseTreeSha: baseline.treeSha,
        includedLocalChanges, untrackedFiles: untracked.length,
      };
    } catch (error) {
      this.#git(projectRoot, ['worktree', 'remove', '--force', treePath], { allowFailure: true });
      this.#git(projectRoot, ['branch', '-D', branchName], { allowFailure: true });
      throw error;
    }
  }

  createSubmissionSnapshot({ treePath, taskId, taskVersion }) {
    invariant(this.isReusableShare({ treePath }), 409, 'DELIVERY_WORKTREE_INVALID', '任务工作树不可用，无法创建交付快照。');
    const snapshot = this.#snapshot(treePath, `Codex Harness task ${taskId} v${taskVersion}`);
    return { ...snapshot, createdFrom: canonical(treePath) };
  }

  snapshotProject(projectRoot) {
    if (!this.isReady(projectRoot)) this.initialize(projectRoot);
    return this.#snapshot(projectRoot, 'Codex Harness work graph input snapshot');
  }

  head(projectRoot) { return this.#git(projectRoot, ['rev-parse', 'HEAD']).stdout; }

  synchronizeShare({ projectRoot, treePath, commitSha }) {
    invariant(this.isReady(projectRoot) && this.isReusableShare({ treePath }), 409, 'INPUT_WORKTREE_INVALID', '任务工作树不可用。');
    invariant(/^[0-9a-f]{40,64}$/.test(commitSha)
      && this.#git(projectRoot, ['merge-base', '--is-ancestor', commitSha, 'HEAD'], { allowFailure: true }).ok,
    409, 'INPUT_BASE_INVALID', '任务输入基线不属于老板项目。');
    invariant(!this.#git(treePath, ['status', '--porcelain']).stdout, 409, 'INPUT_WORKTREE_DIRTY', '工作树有未提交修改，请先处理再同步任务输入。');
    const head = this.head(treePath);
    if (head === commitSha) return { commitSha, alreadyPrepared: true };
    invariant(this.#git(treePath, ['merge-base', '--is-ancestor', head, commitSha], { allowFailure: true }).ok,
      409, 'INPUT_BASE_DIVERGED', '工作树有尚未交付的独立提交，请先处理基线冲突。');
    this.#git(treePath, ['-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', commitSha]);
    return { commitSha: this.head(treePath), alreadyPrepared: false };
  }

  readSnapshotFiles({ projectRoot, commitSha, paths, maxBytes = 2 * 1024 * 1024, includeContent = true, includeBytes = false }) {
    invariant(/^[0-9a-f]{40,64}$/.test(String(commitSha)), 400, 'INVALID_SNAPSHOT', '成果版本无效。');
    const files = [];
    let total = 0;
    for (const input of paths) {
      const relative = graphRelativePath(input);
      const entries = this.#git(projectRoot, ['ls-tree', '-z', commitSha, '--', relative], { trim: false }).stdout.split('\0').filter(Boolean);
      const entry = entries.find((line) => line.slice(line.indexOf('\t') + 1) === relative);
      invariant(entry && /^(100644|100755) blob /.test(entry), 409, 'OUTPUT_FILE_REQUIRED', `成果不是快照中的普通文件: ${relative}`);
      const blobId = entry.split('\t')[0].split(' ')[2];
      const size = Number(this.#git(projectRoot, ['cat-file', '-s', blobId]).stdout);
      total += size;
      invariant(Number.isSafeInteger(size) && size >= 0 && total <= maxBytes, 413, 'CONTEXT_TOO_LARGE', '成果内容超过本次读取预算。');
      const bytes = this.#git(projectRoot, ['cat-file', 'blob', blobId], { encoding: null, trim: false, maxBuffer: Math.max(1024, size + 1024) }).stdout;
      const file = { path: relative, size, sha256: createHash('sha256').update(bytes).digest('hex') };
      if (includeContent) {
        try { file.content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); file.readable = !file.content.includes('\0'); }
        catch { file.readable = false; }
        if (!file.readable) delete file.content;
      }
      if (includeBytes) file.bytes = bytes;
      files.push(file);
    }
    return files;
  }

  deliverSubmission({ projectRoot, treePath, snapshotCommitSha, snapshotTreeSha, taskId, taskVersion }) {
    invariant(this.isReady(projectRoot), 409, 'GIT_REQUIRED', '项目 Git 仓库不可用，无法交付代码。');
    invariant(this.isReusableShare({ treePath }), 409, 'DELIVERY_WORKTREE_INVALID', '任务工作树不可用，无法交付代码。');
    invariant(/^[0-9a-f]{40,64}$/i.test(String(snapshotCommitSha || ''))
      && /^[0-9a-f]{40,64}$/i.test(String(snapshotTreeSha || '')),
    409, 'DELIVERY_SNAPSHOT_MISSING', '任务提交没有可验证的 Git 快照。');
    const exists = this.#git(treePath, ['cat-file', '-e', `${snapshotCommitSha}^{commit}`], { allowFailure: true });
    invariant(exists.ok, 409, 'DELIVERY_SNAPSHOT_MISSING', '任务提交引用的 Git commit 已不存在。');
    const actualTree = this.#git(treePath, ['rev-parse', `${snapshotCommitSha}^{tree}`]).stdout;
    invariant(actualTree === snapshotTreeSha, 409, 'DELIVERY_SNAPSHOT_CHANGED', '任务提交的 Git tree 与记录不一致。');
    invariant(this.#git(treePath, ['merge-base', '--is-ancestor', snapshotCommitSha, 'HEAD'], { allowFailure: true }).ok,
      409, 'DELIVERY_SNAPSHOT_DETACHED', '任务提交的 Git commit 不属于原授权工作树。');

    const ownerSnapshot = this.#snapshot(projectRoot, `Codex Harness owner snapshot before task ${taskId} v${taskVersion}`);
    if (this.#git(projectRoot, ['merge-base', '--is-ancestor', snapshotCommitSha, 'HEAD'], { allowFailure: true }).ok) {
      return { deliveryCommitSha: ownerSnapshot.commitSha, alreadyDelivered: true };
    }
    const merged = this.#git(projectRoot, [
      '-c', 'core.hooksPath=/dev/null', 'merge', '--no-ff', '--no-edit',
      '-m', `Deliver Codex Harness task ${taskId} v${taskVersion}`, snapshotCommitSha,
    ], { allowFailure: true });
    if (!merged.ok) {
      this.#git(projectRoot, ['merge', '--abort'], { allowFailure: true });
      throw new HttpError(409, 'DELIVERY_MERGE_CONFLICT', '交付快照与老板当前代码冲突；审核仍保持待处理，请先解决基线冲突。');
    }
    const deliveryCommitSha = this.#git(projectRoot, ['rev-parse', 'HEAD']).stdout;
    invariant(this.#git(projectRoot, ['merge-base', '--is-ancestor', snapshotCommitSha, deliveryCommitSha], { allowFailure: true }).ok,
      500, 'DELIVERY_MERGE_INVALID', 'Git 合并完成但交付 commit 未进入 owner 历史。');
    return { deliveryCommitSha, alreadyDelivered: false };
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
