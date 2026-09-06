import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { WorkspaceService } from '../src/fs-service.mjs';

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-harness-workspace-'));
  const service = new WorkspaceService({ workspacesRoot: path.join(base, 'workspaces'), fileMaxBytes: 1024 * 1024, uploadMaxBytes: 1024 * 1024 });
  const project = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'demo-123456', name: 'Demo', description: '' };
  service.createProject(project);
  return { base, service, project };
}

test('workspace file CRUD stays inside the project', () => {
  const { service, project } = fixture();
  service.writeFile(project, 'src/index.js', 'console.log("ok")\n');
  assert.equal(service.readFile(project, 'src/index.js').content, 'console.log("ok")\n');
  assert.throws(() => service.readFile(project, '../secret'), /路径不能离开工作区/);
  assert.throws(() => service.writeFile(project, '/tmp/escape', 'bad'), /相对路径/);
  assert.throws(() => service.writeFile(project, '.codex/agents/override.toml', 'model = "other"'), /内部路径/);
  assert.throws(() => service.writeFile(project, '.CoDeX/config.toml', 'model = "other"'), /内部路径/);
  assert.throws(() => service.readFile(project, '.GIT/config'), /内部路径/);
  const usageBeforeTrash = service.usageForUser(project.userId, [project]);
  const deleted = service.moveToTrash(project, 'src/index.js');
  assert.equal(deleted.recoverable, true);
  assert.equal(fs.existsSync(path.join(service.projectRoot(project), 'src/index.js')), false);
  assert.deepEqual(service.usageForUser(project.userId, [project]), usageBeforeTrash);
});

test('workspace rejects symlinks that escape the project', () => {
  const { base, service, project } = fixture();
  fs.symlinkSync(path.join(base, 'outside'), path.join(service.projectRoot(project), 'escape'));
  assert.throws(() => service.readFile(project, 'escape'), /符号链接/);
});

test('sandboxed file operations reject a path swapped after main-process validation', { skip: process.platform !== 'darwin' }, () => {
  const { base, service, project } = fixture();
  const root = service.projectRoot(project);
  const safe = path.join(root, 'safe');
  const parked = path.join(root, 'safe-original');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(safe);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(safe, 'target.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'target.txt'), 'host-secret');

  const originalResolve = service.resolve.bind(service);
  let swapped = false;
  service.resolve = (...args) => {
    const result = originalResolve(...args);
    if (!swapped && args[1] === 'safe/target.txt') {
      swapped = true;
      fs.renameSync(safe, parked);
      fs.symlinkSync(outside, safe);
    }
    return result;
  };
  assert.throws(() => service.readFile(project, 'safe/target.txt'), /符号链接|沙箱/);
  assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'host-secret');

  fs.unlinkSync(safe);
  fs.renameSync(parked, safe);
  swapped = false;
  assert.throws(() => service.writeFile(project, 'safe/target.txt', 'overwrite-host'), /符号链接|沙箱/);
  assert.equal(fs.readFileSync(path.join(outside, 'target.txt'), 'utf8'), 'host-secret');
});

test('workspace previews xlsx values without exposing another path', async () => {
  const { service, project } = fixture();
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('模块清单');
  sheet.addRow(['模块', '状态']);
  sheet.addRow(['数字农业', '已规划']);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  service.writeFile(project, '模块清单.xlsx', buffer);
  const preview = await service.spreadsheetPreview(project, '模块清单.xlsx');
  assert.deepEqual(preview.sheets[0].rows.slice(0, 2), [['模块', '状态'], ['数字农业', '已规划']]);
  assert.throws(() => service.readBuffer(project, '../outside.xlsx'), /路径不能离开工作区/);
});
