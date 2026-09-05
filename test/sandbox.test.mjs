import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceService } from '../src/fs-service.mjs';
import { runSandboxedCommand } from '../src/sandbox.mjs';

test('macOS command sandbox can write its tenant and cannot read Codex credentials', { skip: process.platform !== 'darwin' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-sandbox-'));
  const config = { workspacesRoot: path.join(base, 'workspaces'), fileMaxBytes: 1024 * 1024, uploadMaxBytes: 1024 * 1024, commandTimeoutMs: 10_000, commandMaxOutputBytes: 64 * 1024 };
  const workspace = new WorkspaceService(config);
  const user = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', networkAccess: false };
  const project = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', userId: user.id, slug: 'sandbox-test', name: 'Sandbox', description: '' };
  const outsideSecret = path.join(base, 'outside-secret.txt');
  const sibling = { ...project, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', slug: 'sibling-project', name: 'Sibling' };
  fs.writeFileSync(outsideSecret, 'must-not-leak');
  workspace.createProject(project);
  workspace.createProject(sibling);
  workspace.writeFile(sibling, 'secret.txt', 'sibling-secret');
  const siblingSecret = path.join(workspace.projectRoot(sibling), 'secret.txt');
  const result = await runSandboxedCommand({ config, workspace, project, user, command: `printf safe > generated.txt; if test -r "${outsideSecret}" || test -r "${siblingSecret}"; then echo LEAK; else echo DENIED; fi` });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /DENIED/);
  assert.doesNotMatch(result.output, /LEAK/);
  assert.equal(workspace.readFile(project, 'generated.txt').content, 'safe');
});

test('shared-worktree sandbox hides Git indirection metadata', { skip: process.platform !== 'darwin' }, async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-shared-sandbox-'));
  const config = { workspacesRoot: path.join(base, 'workspaces'), treesRoot: path.join(base, 'trees'), runtimeRoot: path.join(base, 'runtime'), fileMaxBytes: 1024 * 1024, uploadMaxBytes: 1024 * 1024, commandTimeoutMs: 10_000, commandMaxOutputBytes: 64 * 1024 };
  const workspace = new WorkspaceService(config);
  const user = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', networkAccess: false };
  const treePath = path.join(config.treesRoot, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
  fs.mkdirSync(treePath, { recursive: true });
  fs.writeFileSync(path.join(treePath, '.git'), 'gitdir: /private/boss/project/.git/worktrees/employee');
  fs.writeFileSync(path.join(treePath, 'visible.txt'), 'visible');
  const project = { id: 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', accessUserId: user.id, accessId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', accessKind: 'shared', treePath, slug: 'shared', name: 'Shared' };
  const result = await runSandboxedCommand({ config, workspace, project, user, command: 'test -r visible.txt && test ! -r .git && echo SEALED' });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /SEALED/);
  assert.doesNotMatch(result.output, /private\/boss/);
});
