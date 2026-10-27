import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WorkspaceService } from '../src/fs-service.mjs';
import { WorktreeService } from '../src/worktree-service.mjs';

test('a shared project uses its own worktree and preserves dirty data on revoke', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-worktree-'));
  const config = {
    dataDir: base,
    workspacesRoot: path.join(base, 'workspaces'),
    treesRoot: path.join(base, 'trees'),
    runtimeRoot: path.join(base, 'runtime'),
    trashRoot: path.join(base, 'trash'),
    fileMaxBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
  };
  const workspace = new WorkspaceService(config);
  const worktrees = new WorktreeService(config);
  const ownerProject = {
    id: randomUUID(), userId: randomUUID(), accessUserId: randomUUID(), accessId: randomUUID(),
    slug: 'boss-project', name: 'Boss project', description: '', accessKind: 'owner',
  };
  ownerProject.accessUserId = ownerProject.userId;
  workspace.createProject(ownerProject);
  worktrees.initialize(workspace.projectRoot(ownerProject));
  workspace.writeFile(ownerProject, 'README.md', '# Owner\n\nUncommitted tracked change.\n');
  workspace.writeFile(ownerProject, 'owner-untracked.txt', 'uncommitted source snapshot');

  const accessId = randomUUID();
  const shared = worktrees.createShare({ projectRoot: workspace.projectRoot(ownerProject), projectId: ownerProject.id, accessId });
  const employeeProject = { ...ownerProject, accessId, accessUserId: randomUUID(), accessKind: 'shared', treePath: shared.treePath };
  assert.equal(shared.includedLocalChanges, true);
  assert.equal(shared.baseSha.length, 40);
  assert.equal(shared.baseTreeSha.length, 40);
  assert.match(workspace.readFile(employeeProject, 'README.md').content, /Uncommitted tracked change/);
  assert.equal(workspace.readFile(employeeProject, 'owner-untracked.txt').content, 'uncommitted source snapshot');
  assert.throws(() => workspace.readFile(employeeProject, '.git'), /内部路径/);
  workspace.writeFile(employeeProject, 'employee-only.txt', 'private work in progress');
  assert.equal(workspace.readFile(employeeProject, 'employee-only.txt').content, 'private work in progress');
  assert.deepEqual(workspace.usageForUser(employeeProject.accessUserId, [employeeProject]), workspace.projectUsage(employeeProject));
  assert.equal(fs.existsSync(path.join(workspace.projectRoot(ownerProject), 'employee-only.txt')), false);
  assert.throws(() => workspace.projectRoot({ ...employeeProject, treePath: path.join(base, 'outside') }), /项目目录配置无效/);

  const cleanup = worktrees.removeShare({ projectRoot: workspace.projectRoot(ownerProject), treePath: shared.treePath });
  assert.deepEqual({ removed: cleanup.removed, dirty: cleanup.dirty }, { removed: false, dirty: true });
  assert.equal(fs.existsSync(shared.treePath), true);
});

test('task submission snapshot is immutable and passed delivery merges it into the owner project', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-delivery-'));
  const config = {
    dataDir: base,
    workspacesRoot: path.join(base, 'workspaces'),
    treesRoot: path.join(base, 'trees'),
    runtimeRoot: path.join(base, 'runtime'),
    trashRoot: path.join(base, 'trash'),
    fileMaxBytes: 1024 * 1024,
    uploadMaxBytes: 1024 * 1024,
  };
  const workspace = new WorkspaceService(config);
  const worktrees = new WorktreeService(config);
  const ownerProject = {
    id: randomUUID(), accessId: randomUUID(), userId: randomUUID(), slug: 'delivery', name: 'Delivery', description: '',
  };
  workspace.createProject(ownerProject);
  const ownerRoot = workspace.projectRoot(ownerProject);
  worktrees.initialize(ownerRoot);
  const accessId = randomUUID();
  const shared = worktrees.createShare({ projectRoot: ownerRoot, projectId: ownerProject.id, accessId });
  const employeeProject = {
    ...ownerProject, accessId, accessUserId: randomUUID(), accessKind: 'shared', treePath: shared.treePath,
  };
  workspace.writeFile(employeeProject, 'employee-delivery.txt', 'snapshot-v1');
  const snapshot = worktrees.createSubmissionSnapshot({ treePath: shared.treePath, taskId: randomUUID(), taskVersion: 1 });
  workspace.writeFile(employeeProject, 'employee-delivery.txt', 'later-unsubmitted-change');
  workspace.writeFile(ownerProject, 'owner-current.txt', 'owner remains present');

  const delivered = worktrees.deliverSubmission({
    projectRoot: ownerRoot, treePath: shared.treePath,
    snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha,
    taskId: randomUUID(), taskVersion: 1,
  });
  assert.match(delivered.deliveryCommitSha, /^[0-9a-f]{40,64}$/);
  assert.equal(workspace.readFile(ownerProject, 'employee-delivery.txt').content, 'snapshot-v1');
  assert.equal(workspace.readFile(ownerProject, 'owner-current.txt').content, 'owner remains present');
  assert.equal(workspace.readFile(employeeProject, 'employee-delivery.txt').content, 'later-unsubmitted-change');

  const repeated = worktrees.deliverSubmission({
    projectRoot: ownerRoot, treePath: shared.treePath,
    snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha,
    taskId: randomUUID(), taskVersion: 1,
  });
  assert.equal(repeated.alreadyDelivered, true);
  assert.equal(repeated.deliveryCommitSha, delivered.deliveryCommitSha);
});


test('owner local clones never block snapshots/delivery, but tracked gitlinks and employee links are rejected', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-local-clone-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'owner'); fs.mkdirSync(root);
  const worktrees = new WorktreeService({ dataDir: base, workspacesRoot: base });
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const nested = path.join(root, 'local library'); fs.mkdirSync(nested);
  git(nested, 'init'); git(nested, 'config', 'user.name', 'Synthetic'); git(nested, 'config', 'user.email', 'synthetic@localhost');
  fs.writeFileSync(path.join(nested, 'source.txt'), 'original'); git(nested, 'add', '.'); git(nested, 'commit', '-m', 'Synthetic source');
  const head = git(nested, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(nested, 'source.txt'), 'uncommitted source');
  fs.writeFileSync(path.join(root, 'ordinary.txt'), 'shared ordinary file');
  const baseline = worktrees.snapshotProject(root);
  assert.deepEqual(baseline.excludedLocalRepositories, ['local library']);
  assert.equal(git(root, 'ls-tree', '--name-only', 'HEAD'), 'ordinary.txt');
  worktrees.initialize(root); // Already-initialized project with only a local clone is a no-op.
  const shared = worktrees.createShare({ projectRoot: root, projectId: randomUUID(), accessId: randomUUID() });
  assert.equal(fs.existsSync(path.join(shared.treePath, 'local library')), false);
  assert.equal(fs.readFileSync(path.join(shared.treePath, 'ordinary.txt'), 'utf8'), 'shared ordinary file');
  fs.writeFileSync(path.join(shared.treePath, 'result.txt'), 'fixed result');
  const snapshot = worktrees.createSubmissionSnapshot({ treePath: shared.treePath, taskId: randomUUID(), taskVersion: 1 });
  const deliveryArgs = { projectRoot: root, treePath: shared.treePath, snapshotCommitSha: snapshot.commitSha,
    snapshotTreeSha: snapshot.treeSha, taskId: randomUUID(), taskVersion: 1 };
  const delivered = worktrees.deliverSubmission(deliveryArgs);
  assert.equal(delivered.alreadyDelivered, false);
  assert.equal(fs.readFileSync(path.join(root, 'result.txt'), 'utf8'), 'fixed result');
  assert.equal(git(nested, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(nested, 'source.txt'), 'utf8'), 'uncommitted source');
  // Crash after merge, before database update: unrelated unsupported local changes
  // must not prevent recognition of the already-delivered immutable submission.
  fs.symlinkSync('/dev/null', path.join(root, 'local-link'));
  assert.equal(worktrees.deliverSubmission(deliveryArgs).alreadyDelivered, true);
  assert.throws(() => worktrees.snapshotProject(root), { code: 'DELIVERY_UNSUPPORTED_ENTRY' });
  fs.unlinkSync(path.join(root, 'local-link'));
  fs.symlinkSync('/dev/null', path.join(shared.treePath, 'bad-link'));
  assert.throws(() => worktrees.createSubmissionSnapshot({ treePath: shared.treePath, taskId: randomUUID(), taskVersion: 1 }), { code: 'DELIVERY_UNSUPPORTED_ENTRY' });
  fs.unlinkSync(path.join(shared.treePath, 'bad-link'));
  git(root, 'add', 'local library'); git(root, 'commit', '-m', 'Synthetic tracked gitlink');
  assert.throws(() => worktrees.snapshotProject(root), { code: 'DELIVERY_UNSUPPORTED_ENTRY' });
});

test('excluded local repository cannot be overwritten by a colliding submission', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-clone-collision-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'owner'); fs.mkdirSync(root);
  const worktrees = new WorktreeService({ dataDir: base, workspacesRoot: base });
  worktrees.initialize(root);
  const shared = worktrees.createShare({ projectRoot: root, projectId: randomUUID(), accessId: randomUUID() });
  const local = path.join(root, 'library'); fs.mkdirSync(local);
  execFileSync('/usr/bin/git', ['-C', local, 'init'], { stdio: 'pipe' });
  fs.writeFileSync(path.join(local, 'source.txt'), 'keep me');
  fs.mkdirSync(path.join(shared.treePath, 'library'));
  fs.writeFileSync(path.join(shared.treePath, 'library/source.txt'), 'colliding delivery');
  const snapshot = worktrees.createSubmissionSnapshot({ treePath: shared.treePath, taskId: randomUUID(), taskVersion: 1 });
  assert.throws(() => worktrees.deliverSubmission({ projectRoot: root, treePath: shared.treePath,
    snapshotCommitSha: snapshot.commitSha, snapshotTreeSha: snapshot.treeSha, taskId: randomUUID(), taskVersion: 1 }), { code: 'DELIVERY_MERGE_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(local, 'source.txt'), 'utf8'), 'keep me');
  fs.unlinkSync(path.join(shared.treePath, 'library/source.txt'));
  fs.writeFileSync(path.join(shared.treePath, 'library/new.txt'), 'must not enter the local clone');
  const next = worktrees.createSubmissionSnapshot({ treePath: shared.treePath, taskId: randomUUID(), taskVersion: 2 });
  assert.throws(() => worktrees.deliverSubmission({ projectRoot: root, treePath: shared.treePath, snapshotCommitSha: next.commitSha,
    snapshotTreeSha: next.treeSha, taskId: randomUUID(), taskVersion: 2 }), { code: 'DELIVERY_MERGE_CONFLICT' });
  assert.equal(fs.existsSync(path.join(local, 'new.txt')), false);
});
