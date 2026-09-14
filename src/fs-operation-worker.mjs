#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

class OperationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function assert(condition, status, code, message) {
  if (!condition) throw new OperationError(status, code, message);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function targetFor(root, relative = '') {
  const target = path.resolve(root, relative);
  assert(inside(root, target), 400, 'INVALID_PATH', '路径不能离开项目目录。');
  return target;
}

function assertNoSymlinkComponents(root, relative, { allowMissing = false } = {}) {
  let current = root;
  const rootStat = fs.lstatSync(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 403, 'PROJECT_SYMLINK_NOT_ALLOWED', '项目目录不能是符号链接。');
  for (const part of String(relative || '').split('/').filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return;
      throw error;
    }
    assert(!stat.isSymbolicLink(), 403, 'SYMLINK_NOT_ALLOWED', '不允许通过符号链接访问文件。');
  }
}

function hashFileDescriptor(fd, size) {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (count === 0) break;
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  return hash.digest('hex');
}

function read(payload) {
  assertNoSymlinkComponents(payload.root, payload.relative);
  const target = targetFor(payload.root, payload.relative);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assert(stat.isFile(), 400, 'NOT_A_FILE', '目标不是文件。');
    assert(stat.size <= payload.maxBytes, 413, 'FILE_TOO_LARGE', `文件超过 ${payload.maxBytes} 字节的在线读取上限。`);
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const content = offset === buffer.length ? buffer : buffer.subarray(0, offset);
    return {
      buffer: content.toString('base64'), size: content.length, modifiedAt: stat.mtime.toISOString(),
      version: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    fs.closeSync(fd);
  }
}

function stat(payload) {
  assertNoSymlinkComponents(payload.root, payload.relative);
  const target = targetFor(payload.root, payload.relative);
  let value = fs.lstatSync(target);
  let version = null;
  if (value.isFile()) {
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      value = fs.fstatSync(fd);
      version = hashFileDescriptor(fd, value.size);
    } finally { fs.closeSync(fd); }
  }
  return {
    type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other',
    size: value.isFile() ? value.size : 0,
    modifiedAt: value.mtime.toISOString(),
    version,
  };
}

function write(payload) {
  const target = targetFor(payload.root, payload.relative);
  const parentRelative = path.posix.dirname(payload.relative) === '.' ? '' : path.posix.dirname(payload.relative);
  assertNoSymlinkComponents(payload.root, parentRelative, { allowMissing: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(payload.root, parentRelative);
  let currentVersion = null;
  try {
    const stat = fs.lstatSync(target);
    assert(!stat.isSymbolicLink(), 403, 'SYMLINK_NOT_ALLOWED', '不允许通过符号链接访问文件。');
    assert(stat.isFile(), 400, 'NOT_A_FILE', '目标不是文件。');
    if (payload.expectedVersion) {
      const currentFd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const currentStat = fs.fstatSync(currentFd);
        currentVersion = hashFileDescriptor(currentFd, currentStat.size);
      } finally { fs.closeSync(currentFd); }
    }
  } catch (error) {
    if (error instanceof OperationError || error?.code !== 'ENOENT') throw error;
  }
  if (payload.expectedVersion) {
    assert(currentVersion === payload.expectedVersion, 409, 'FILE_VERSION_CONFLICT', '文件已被其他操作修改，请刷新后合并或重试。');
  }
  const buffer = Buffer.from(payload.buffer || '', 'base64');
  const temporary = path.join(path.dirname(target), `.codex-harness-write-${randomBytes(12).toString('hex')}`);
  const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset, offset);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
    throw error;
  }
  const stat = fs.lstatSync(target);
  assert(stat.isFile() && !stat.isSymbolicLink(), 400, 'NOT_A_FILE', '目标不是文件。');
  return {
    size: stat.size, modifiedAt: stat.mtime.toISOString(),
    version: createHash('sha256').update(buffer).digest('hex'),
  };
}

function makeDirectory(payload) {
  const target = targetFor(payload.root, payload.relative);
  assertNoSymlinkComponents(payload.root, payload.relative, { allowMissing: true });
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertNoSymlinkComponents(payload.root, payload.relative);
  const stat = fs.lstatSync(target);
  assert(stat.isDirectory(), 400, 'NOT_A_DIRECTORY', '目标不是目录。');
  return {};
}

function tree(payload) {
  assertNoSymlinkComponents(payload.root, payload.relative);
  const target = targetFor(payload.root, payload.relative);
  assert(fs.lstatSync(target).isDirectory(), 400, 'NOT_A_DIRECTORY', '目标不是目录。');
  const entries = [];
  const visit = (directoryPath, base, depth) => {
    if (depth > payload.maxDepth || entries.length >= payload.maxEntries) return;
    const children = fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => !payload.hiddenNames.includes(entry.name.normalize('NFKC').toLowerCase()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of children) {
      if (entries.length >= payload.maxEntries) break;
      const entryRelative = [base, entry.name].filter(Boolean).join('/');
      const fullPath = path.join(directoryPath, entry.name);
      const stat = fs.lstatSync(fullPath);
      const item = {
        path: entryRelative,
        name: entry.name,
        type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
        size: stat.isFile() ? stat.size : 0,
        modifiedAt: stat.mtime.toISOString(),
      };
      entries.push(item);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(fullPath, entryRelative, depth + 1);
    }
  };
  visit(target, payload.relative, 1);
  return { entries, truncated: entries.length >= payload.maxEntries };
}

function moveToTrash(payload) {
  assertNoSymlinkComponents(payload.root, payload.relative);
  const source = targetFor(payload.root, payload.relative);
  const destinationRoot = path.resolve(payload.destinationRoot);
  const destination = path.resolve(destinationRoot, payload.destinationName);
  assert(inside(destinationRoot, destination), 500, 'TRASH_PATH_INVALID', '回收站路径配置无效。');
  assert(fs.lstatSync(destinationRoot).isDirectory(), 500, 'TRASH_PATH_INVALID', '回收站路径配置无效。');
  fs.renameSync(source, destination);
  return {};
}

// One sandbox invocation, bounded work, and no file contents returned to the caller.
function fingerprint(payload) {
  const hash = createHash('sha256'); let count = 0, bytes = 0;
  const walk = relative => {
    assert(++count <= 3000, 413, 'APPROVAL_TARGET_TOO_LARGE', '审批目标包含过多条目。');
    assertNoSymlinkComponents(payload.root, relative);
    const target = targetFor(payload.root, relative), value = fs.lstatSync(target);
    assert(value.isDirectory() || value.isFile(), 400, 'INVALID_FILE_OPERATION', '审批目标类型不支持。');
    hash.update(JSON.stringify([relative, value.isDirectory() ? 'directory' : 'file']));
    if (value.isDirectory()) for (const name of fs.readdirSync(target).sort()) walk([relative, name].filter(Boolean).join('/'));
    else {
      bytes += value.size;
      assert(bytes <= 256 * 1024 * 1024, 413, 'APPROVAL_TARGET_TOO_LARGE', '审批目标超过 256 MiB，请缩小范围。');
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { hash.update(hashFileDescriptor(fd, fs.fstatSync(fd).size)); } finally { fs.closeSync(fd); }
    }
  };
  try { walk(payload.relative); } catch (error) { if (count === 1 && error.code === 'ENOENT') return { version: 'missing' }; throw error; }
  return { version: hash.digest('hex') };
}

function errorResult(error) {
  if (error instanceof OperationError) return { ok: false, status: error.status, code: error.code, message: error.message };
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: false, status: 404, code: 'PATH_NOT_FOUND', message: '文件或目录不存在。' };
  if (['EACCES', 'EPERM', 'ELOOP'].includes(error?.code)) return { ok: false, status: 403, code: 'FILE_SANDBOX_DENIED', message: '文件操作被项目沙箱拒绝。' };
  if (['EISDIR', 'ENOTEMPTY'].includes(error?.code)) return { ok: false, status: 400, code: 'INVALID_FILE_OPERATION', message: '文件操作的目标类型不正确。' };
  return { ok: false, status: 500, code: 'FILE_OPERATION_FAILED', message: '项目文件操作失败。' };
}

try {
  const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  const operations = { read, stat, write, makeDirectory, tree, moveToTrash, fingerprint };
  assert(operations[payload.operation], 400, 'INVALID_FILE_OPERATION', '未知文件操作。');
  process.stdout.write(JSON.stringify({ ok: true, value: operations[payload.operation](payload) }));
} catch (error) {
  process.stdout.write(JSON.stringify(errorResult(error)));
}
