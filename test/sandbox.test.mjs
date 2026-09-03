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
  fs.writeFileSync(outsideSecret, 'must-not-leak');
  workspace.createProject(project);
  const result = await runSandboxedCommand({ config, workspace, project, user, command: `printf safe > generated.txt; if test -r "${outsideSecret}"; then echo LEAK; else echo DENIED; fi` });
  assert.equal(result.ok, true);
  assert.match(result.output, /DENIED/);
  assert.doesNotMatch(result.output, /LEAK/);
  assert.equal(workspace.readFile(project, 'generated.txt').content, 'safe');
});
