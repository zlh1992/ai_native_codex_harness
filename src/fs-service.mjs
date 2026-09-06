import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { HttpError, invariant } from './errors.mjs';
import { buildSeatbeltProfile } from './sandbox.mjs';

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE_OPERATION_WORKER = path.join(SOURCE_DIR, 'fs-operation-worker.mjs');

const HIDDEN_ROOT_ENTRIES = new Set(['.git', '.codex', '.trash', '.home', '.tmp']);
const RESERVED_PATH_PARTS = new Set(['.git', '.codex', '.trash', '.home', '.tmp']);

function reservedPathPart(value) {
  return RESERVED_PATH_PARTS.has(String(value).normalize('NFKC').toLowerCase());
}

function hiddenRootEntry(value) {
  return HIDDEN_ROOT_ENTRIES.has(String(value).normalize('NFKC').toLowerCase());
}

function ancestors(value) {
  const entries = [];
  let current = path.resolve(value);
  while (current !== path.parse(current).root) {
    current = path.dirname(current);
    entries.push(current);
  }
  return entries;
}

export function slugify(value) {
  const base = String(value || 'project').normalize('NFKC').toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizedRelative(value = '') {
  const raw = String(value).replaceAll('\\', '/');
  invariant(!raw.includes('\0'), 400, 'INVALID_PATH', '路径包含非法字符。');
  invariant(!path.posix.isAbsolute(raw), 400, 'INVALID_PATH', '只允许工作区相对路径。');
  const parts = raw.split('/').filter((part) => part && part !== '.');
  invariant(!parts.some((part) => part === '..'), 400, 'INVALID_PATH', '路径不能离开工作区。');
  invariant(!parts.some(reservedPathPart), 403, 'RESERVED_PATH', '该内部路径不允许通过文件接口访问。');
  return parts.join('/');
}

function cellValue(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[binary ${value.length} bytes]`;
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('');
  if ('formula' in value) return value.result === undefined ? `=${value.formula}` : String(value.result);
  if ('hyperlink' in value) return String(value.text || value.hyperlink || '');
  if ('error' in value) return String(value.error);
  return JSON.stringify(value);
}

export class WorkspaceService {
  constructor(config) {
    const dataRoot = config.dataDir || path.dirname(config.workspacesRoot);
    this.config = {
      ...config,
      treesRoot: config.treesRoot || path.join(dataRoot, 'trees'),
      runtimeRoot: config.runtimeRoot || path.join(dataRoot, 'runtime'),
      trashRoot: config.trashRoot || path.join(dataRoot, 'trash'),
    };
    for (const root of [this.config.workspacesRoot, this.config.treesRoot, this.config.runtimeRoot, this.config.trashRoot]) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
  }

  #fileOperation(project, payload, { write = false, extraWritableRoots = [] } = {}) {
    invariant(process.platform === 'darwin', 501, 'FILE_SANDBOX_UNAVAILABLE', '当前安全文件操作器仅支持 macOS Seatbelt。');
    const root = fs.realpathSync(this.projectRoot(project));
    const canonicalExtraRoots = extraWritableRoots.map((entry) => fs.realpathSync(entry));
    const writableRoots = write ? [root, ...canonicalExtraRoots] : [];
    const profile = buildSeatbeltProfile({
      readableRoots: [root, SOURCE_DIR, ...canonicalExtraRoots],
      readableMetadataPaths: ancestors(FILE_OPERATION_WORKER),
      writableRoots,
      deniedPaths: [...RESERVED_PATH_PARTS].map((entry) => path.join(root, entry)),
      networkAccess: false,
    });
    const input = JSON.stringify({ ...payload, root });
    const maxBuffer = Math.max(1024 * 1024, Math.ceil(input.length * 1.5), (payload.maxBytes || 0) * 2);
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, FILE_OPERATION_WORKER], {
      input,
      encoding: 'utf8',
      env: {
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: root,
        TMPDIR: `${root}${path.sep}`,
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
      },
      timeout: 30_000,
      maxBuffer,
    });
    invariant(!result.error, 500, 'FILE_SANDBOX_FAILED', '无法启动项目文件沙箱。');
    invariant(result.status === 0, 500, 'FILE_SANDBOX_FAILED', '项目文件沙箱异常退出。');
    let response;
    try { response = JSON.parse(String(result.stdout || '')); }
    catch { throw new HttpError(500, 'FILE_SANDBOX_FAILED', '项目文件沙箱返回无效结果。'); }
    if (!response.ok) throw new HttpError(response.status || 500, response.code || 'FILE_OPERATION_FAILED', response.message || '项目文件操作失败。');
    return response.value;
  }

  userRoot(userId) {
    invariant(/^[a-f0-9-]{36}$/i.test(String(userId)), 400, 'INVALID_USER', '用户标识无效。');
    return path.join(this.config.workspacesRoot, userId);
  }

  ensureUserRoot(userId) {
    const root = this.userRoot(userId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return root;
  }

  ensureAccessRuntimeRoot(userId, accessId) {
    invariant(/^[a-f0-9-]{36}$/i.test(String(userId)), 400, 'INVALID_USER', '用户标识无效。');
    invariant(/^[a-f0-9-]{36}$/i.test(String(accessId)), 400, 'INVALID_ACCESS_ID', '授权标识无效。');
    const root = path.join(this.config.runtimeRoot, userId, accessId);
    fs.mkdirSync(path.join(root, 'home'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
    return root;
  }

  projectRoot(project) {
    const ownerRoot = this.userRoot(project.userId);
    const candidate = path.resolve(project.treePath || path.join(ownerRoot, project.slug));
    const allowedRoots = [path.resolve(this.config.workspacesRoot), path.resolve(this.config.treesRoot)];
    invariant(allowedRoots.some((root) => inside(root, candidate)), 500, 'PROJECT_PATH_INVALID', '项目目录配置无效。');
    if (fs.existsSync(candidate)) {
      invariant(!fs.lstatSync(candidate).isSymbolicLink(), 403, 'PROJECT_SYMLINK_NOT_ALLOWED', '项目目录不能是符号链接。');
      const actual = fs.realpathSync(candidate);
      invariant(allowedRoots.some((root) => inside(fs.realpathSync(root), actual)), 403, 'PROJECT_PATH_ESCAPE', '项目目录指向受控区域之外。');
    }
    return candidate;
  }

  createProject(project) {
    const root = this.ensureUserRoot(project.userId);
    const projectRoot = this.projectRoot(project);
    invariant(!fs.existsSync(projectRoot), 409, 'PROJECT_DIRECTORY_EXISTS', '项目目录已经存在。');
    fs.mkdirSync(projectRoot, { recursive: false, mode: 0o700 });
    const readme = `# ${project.name}\n\n${project.description || '由 Codex Harness 创建的隔离项目。'}\n`;
    fs.writeFileSync(path.join(projectRoot, 'README.md'), readme, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), [
      '# Codex Harness workspace',
      '',
      '- Work only inside this authorized project; never inspect another project, even under the same account.',
      '- Use the workspace tools supplied by Codex Harness for files and commands.',
      '- Never attempt to inspect host credentials, Codex state, or other users.',
      '',
    ].join('\n'), { mode: 0o600, flag: 'wx' });
    return { root, projectRoot };
  }

  resolve(project, relativePath = '', { mustExist = false, directory = false } = {}) {
    const root = this.projectRoot(project);
    const canonicalRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    const relative = normalizedRelative(relativePath);
    const target = path.resolve(root, relative);
    invariant(inside(root, target), 400, 'INVALID_PATH', '路径不能离开项目目录。');

    try {
      const directStat = fs.lstatSync(target);
      invariant(!directStat.isSymbolicLink(), 403, 'SYMLINK_NOT_ALLOWED', '不允许通过符号链接访问文件。');
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.code !== 'ENOENT') throw error;
    }

    let probe = target;
    while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
    if (fs.existsSync(probe)) {
      const actual = fs.realpathSync(probe);
      invariant(inside(canonicalRoot, actual), 403, 'SYMLINK_ESCAPE', '符号链接指向项目目录之外。');
    }
    if (mustExist) invariant(fs.existsSync(target), 404, 'PATH_NOT_FOUND', '文件或目录不存在。');
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (directory) invariant(stat.isDirectory(), 400, 'NOT_A_DIRECTORY', '目标不是目录。');
    }
    return { root, target, relative };
  }

  tree(project, relativePath = '', maxDepth = 5, maxEntries = 2000) {
    const { relative } = this.resolve(project, relativePath, { mustExist: true, directory: true });
    const result = this.#fileOperation(project, {
      operation: 'tree', relative, maxDepth, maxEntries, hiddenNames: [...HIDDEN_ROOT_ENTRIES],
    });
    return { path: relative, entries: result.entries, truncated: result.truncated };
  }

  readFile(project, relativePath) {
    const { relative } = this.resolve(project, relativePath, { mustExist: true });
    const result = this.#fileOperation(project, { operation: 'read', relative, maxBytes: this.config.fileMaxBytes });
    const buffer = Buffer.from(result.buffer, 'base64');
    invariant(!buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0), 415, 'BINARY_FILE', '二进制文件不能在编辑器中打开。');
    return { path: relative, content: buffer.toString('utf8'), size: result.size, modifiedAt: result.modifiedAt, version: result.version };
  }

  readBuffer(project, relativePath, maxBytes = this.config.uploadMaxBytes) {
    const { relative } = this.resolve(project, relativePath, { mustExist: true });
    const result = this.#fileOperation(project, { operation: 'read', relative, maxBytes });
    return { path: relative, buffer: Buffer.from(result.buffer, 'base64'), size: result.size, modifiedAt: result.modifiedAt, version: result.version };
  }

  fileMetadata(project, relativePath) {
    const { relative } = this.resolve(project, relativePath, { mustExist: true });
    const result = this.#fileOperation(project, { operation: 'stat', relative });
    invariant(result.type === 'file', 400, 'NOT_A_FILE', '目标不是文件。');
    return { path: relative, size: result.size, modifiedAt: result.modifiedAt, version: result.version };
  }

  async spreadsheetPreview(project, relativePath) {
    invariant(/\.(xlsx|xlsm)$/i.test(String(relativePath)), 415, 'UNSUPPORTED_SPREADSHEET', '当前表格预览支持 .xlsx 和 .xlsm。');
    const file = this.readBuffer(project, relativePath, Math.min(this.config.uploadMaxBytes, 20 * 1024 * 1024));
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(file.buffer, { ignoreNodes: ['dataValidations', 'extLst'] });
    } catch (error) {
      throw new HttpError(422, 'SPREADSHEET_PARSE_FAILED', '无法解析这个 Excel 文件。', error.message);
    }
    const maxSheets = 8;
    const maxRows = 300;
    const maxColumns = 60;
    const sheets = workbook.worksheets.slice(0, maxSheets).map((sheet) => {
      const rowCount = sheet.actualRowCount;
      const columnCount = sheet.actualColumnCount;
      const rows = [];
      for (let rowIndex = 1; rowIndex <= Math.min(rowCount, maxRows); rowIndex += 1) {
        const row = [];
        for (let columnIndex = 1; columnIndex <= Math.min(columnCount, maxColumns); columnIndex += 1) {
          row.push(cellValue(sheet.getCell(rowIndex, columnIndex).value));
        }
        rows.push(row);
      }
      return {
        name: sheet.name,
        rowCount,
        columnCount,
        rows,
        truncated: rowCount > maxRows || columnCount > maxColumns,
      };
    });
    return {
      path: file.path,
      size: file.size,
      sheets,
      truncated: workbook.worksheets.length > maxSheets || sheets.some((sheet) => sheet.truncated),
    };
  }

  writeFile(project, relativePath, content, { expectedVersion = null } = {}) {
    const { relative } = this.resolve(project, relativePath);
    invariant(relative, 400, 'INVALID_PATH', '必须指定文件路径。');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    invariant(buffer.length <= this.config.uploadMaxBytes, 413, 'FILE_TOO_LARGE', '文件超过写入上限。');
    invariant(expectedVersion === null || /^[0-9a-f]{64}$/i.test(String(expectedVersion)),
      400, 'INVALID_FILE_VERSION', '文件版本标识无效。');
    const result = this.#fileOperation(project, {
      operation: 'write', relative, buffer: buffer.toString('base64'), expectedVersion,
    }, { write: true });
    return { path: relative, size: result.size, modifiedAt: result.modifiedAt, version: result.version };
  }

  makeDirectory(project, relativePath) {
    const { relative } = this.resolve(project, relativePath);
    invariant(relative, 400, 'INVALID_PATH', '必须指定目录路径。');
    this.#fileOperation(project, { operation: 'makeDirectory', relative }, { write: true });
    return { path: relative };
  }

  moveToTrash(project, relativePath) {
    const { relative } = this.resolve(project, relativePath, { mustExist: true });
    invariant(relative, 400, 'INVALID_PATH', '不能删除项目根目录。');
    const actorId = project.accessUserId || project.userId;
    const trashRoot = path.join(this.config.trashRoot, actorId, 'files', project.accessId || project.id);
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const canonicalTrashRoot = fs.realpathSync(trashRoot);
    const safeName = path.basename(relative).replace(/[^a-zA-Z0-9._\u3400-\u9fff-]/g, '_');
    const destinationName = `${Date.now()}-${randomBytes(3).toString('hex')}-${safeName}`;
    this.#fileOperation(project, {
      operation: 'moveToTrash', relative, destinationRoot: canonicalTrashRoot, destinationName,
    }, { write: true, extraWritableRoots: [canonicalTrashRoot] });
    return { path: relative, recoverable: true };
  }

  trashProject(project) {
    const projectRoot = this.projectRoot(project);
    if (!fs.existsSync(projectRoot)) return { recoverable: false };
    const trashRoot = path.join(this.config.trashRoot, project.userId, 'projects');
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const destination = path.join(trashRoot, `${Date.now()}-${project.id}-${project.slug}`);
    fs.renameSync(projectRoot, destination);
    return { recoverable: true, destination };
  }

  usage(userId) {
    const root = this.ensureUserRoot(userId);
    let bytes = 0;
    let files = 0;
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (hiddenRootEntry(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) visit(full);
        else { bytes += stat.size; files += 1; }
      }
    };
    try { visit(root); } catch (error) {
      throw new HttpError(500, 'USAGE_SCAN_FAILED', '无法统计工作区用量。', error.message);
    }
    return { bytes, files };
  }

  projectUsage(project) {
    const root = this.projectRoot(project);
    let bytes = 0;
    let files = 0;
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (hiddenRootEntry(entry.name)) continue;
        const full = path.join(directory, entry.name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) visit(full);
        else { bytes += stat.size; files += 1; }
      }
    };
    if (fs.existsSync(root)) visit(root);
    return { bytes, files };
  }

  usageForUser(userId, accessibleProjects = []) {
    const total = this.usage(userId);
    for (const project of accessibleProjects) {
      if (project.accessKind !== 'shared') continue;
      const shared = this.projectUsage(project);
      total.bytes += shared.bytes;
      total.files += shared.files;
    }
    const trashRoot = path.join(this.config.trashRoot, userId);
    const visitTrash = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) visitTrash(full);
        else { total.bytes += stat.size; total.files += 1; }
      }
    };
    if (fs.existsSync(trashRoot)) {
      try { visitTrash(trashRoot); } catch (error) {
        throw new HttpError(500, 'USAGE_SCAN_FAILED', '无法统计回收站用量。', error.message);
      }
    }
    return total;
  }
}
