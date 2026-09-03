import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { HttpError, invariant } from './errors.mjs';

const HIDDEN_ROOT_ENTRIES = new Set(['.trash', '.home', '.tmp']);

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
    this.config = config;
    fs.mkdirSync(config.workspacesRoot, { recursive: true, mode: 0o700 });
  }

  userRoot(userId) {
    invariant(/^[a-f0-9-]{36}$/i.test(String(userId)), 400, 'INVALID_USER', '用户标识无效。');
    return path.join(this.config.workspacesRoot, userId);
  }

  ensureUserRoot(userId) {
    const root = this.userRoot(userId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, '.trash'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, '.home'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, '.tmp'), { recursive: true, mode: 0o700 });
    return root;
  }

  projectRoot(project) {
    const root = this.userRoot(project.userId);
    const candidate = path.resolve(root, project.slug);
    invariant(inside(root, candidate), 500, 'PROJECT_PATH_INVALID', '项目目录配置无效。');
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
      '- Work only inside this project unless the user explicitly asks to inspect another project they own.',
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
    const { target, relative } = this.resolve(project, relativePath, { mustExist: true, directory: true });
    const entries = [];
    const visit = (directoryPath, base, depth) => {
      if (depth > maxDepth || entries.length >= maxEntries) return;
      const children = fs.readdirSync(directoryPath, { withFileTypes: true })
        .filter((entry) => !(base === '' && HIDDEN_ROOT_ENTRIES.has(entry.name)))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      for (const entry of children) {
        if (entries.length >= maxEntries) break;
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
    visit(target, relative, 1);
    return { path: relative, entries, truncated: entries.length >= maxEntries };
  }

  readFile(project, relativePath) {
    const { target, relative } = this.resolve(project, relativePath, { mustExist: true });
    const stat = fs.statSync(target);
    invariant(stat.isFile(), 400, 'NOT_A_FILE', '目标不是文件。');
    invariant(stat.size <= this.config.fileMaxBytes, 413, 'FILE_TOO_LARGE', `文件超过 ${this.config.fileMaxBytes} 字节的在线读取上限。`);
    const buffer = fs.readFileSync(target);
    invariant(!buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0), 415, 'BINARY_FILE', '二进制文件不能在编辑器中打开。');
    return { path: relative, content: buffer.toString('utf8'), size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  readBuffer(project, relativePath, maxBytes = this.config.uploadMaxBytes) {
    const { target, relative } = this.resolve(project, relativePath, { mustExist: true });
    const stat = fs.statSync(target);
    invariant(stat.isFile(), 400, 'NOT_A_FILE', '目标不是文件。');
    invariant(stat.size <= maxBytes, 413, 'FILE_TOO_LARGE', `文件超过 ${maxBytes} 字节的在线预览上限。`);
    return { path: relative, buffer: fs.readFileSync(target), size: stat.size, modifiedAt: stat.mtime.toISOString() };
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

  writeFile(project, relativePath, content) {
    const { target, relative } = this.resolve(project, relativePath);
    invariant(relative, 400, 'INVALID_PATH', '必须指定文件路径。');
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
    invariant(buffer.length <= this.config.uploadMaxBytes, 413, 'FILE_TOO_LARGE', '文件超过写入上限。');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    this.resolve(project, path.posix.dirname(relative) === '.' ? '' : path.posix.dirname(relative), { mustExist: true, directory: true });
    if (fs.existsSync(target)) invariant(fs.statSync(target).isFile(), 400, 'NOT_A_FILE', '目标不是文件。');
    fs.writeFileSync(target, buffer, { mode: 0o600 });
    return { path: relative, size: buffer.length, modifiedAt: fs.statSync(target).mtime.toISOString() };
  }

  makeDirectory(project, relativePath) {
    const { target, relative } = this.resolve(project, relativePath);
    invariant(relative, 400, 'INVALID_PATH', '必须指定目录路径。');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    this.resolve(project, relative, { mustExist: true, directory: true });
    return { path: relative };
  }

  moveToTrash(project, relativePath) {
    const { target, relative } = this.resolve(project, relativePath, { mustExist: true });
    invariant(relative, 400, 'INVALID_PATH', '不能删除项目根目录。');
    const userRoot = this.ensureUserRoot(project.userId);
    const trashRoot = path.join(userRoot, '.trash', 'files', project.id);
    fs.mkdirSync(trashRoot, { recursive: true, mode: 0o700 });
    const safeName = path.basename(relative).replace(/[^a-zA-Z0-9._\u3400-\u9fff-]/g, '_');
    const destination = path.join(trashRoot, `${Date.now()}-${randomBytes(3).toString('hex')}-${safeName}`);
    fs.renameSync(target, destination);
    return { path: relative, recoverable: true };
  }

  trashProject(project) {
    const projectRoot = this.projectRoot(project);
    if (!fs.existsSync(projectRoot)) return { recoverable: false };
    const trashRoot = path.join(this.ensureUserRoot(project.userId), '.trash', 'projects');
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
        if (entry.name === '.trash') continue;
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
}
