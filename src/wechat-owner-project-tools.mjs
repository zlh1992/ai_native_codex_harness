import { HttpError, invariant } from './errors.mjs';

const CHANNEL = 'wechat';
const TOOL_NAMES = new Set([
  'owner_projects_list',
  'owner_project_list',
  'owner_project_read_file',
  'owner_project_search',
]);

export const WECHAT_OWNER_PROJECT_TOOLS = Object.freeze([
  {
    type: 'function', name: 'owner_projects_list',
    description: 'List standard Portal projects currently authorized for this user, including owned and shared projects. Excludes local-private and unmanaged host projects.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'owner_project_list',
    description: 'Read-only list of files and directories in one standard Portal project currently authorized for this user. Paths are relative to that target project.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, path: { type: 'string' }, max_depth: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['project_id'], additionalProperties: false },
  },
  {
    type: 'function', name: 'owner_project_read_file',
    description: 'Read one UTF-8 text file from a standard Portal project currently authorized for this user. The operation is read-only and the path is target-project-relative.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, path: { type: 'string' } }, required: ['project_id', 'path'], additionalProperties: false },
  },
  {
    type: 'function', name: 'owner_project_search',
    description: 'Search literal text in UTF-8 files inside one standard Portal project currently authorized for this user. The operation is read-only.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, query: { type: 'string' }, path: { type: 'string' } }, required: ['project_id', 'query'], additionalProperties: false },
  },
]);

export class WechatOwnerProjectTools {
  constructor({ config, db, workspace }) {
    this.config = config;
    this.db = db;
    this.workspace = workspace;
  }

  handles(name) { return TOOL_NAMES.has(name); }

  bindingFor(context) {
    if (this.config.weixinEnabled && context?.chat && context?.project && context?.user
      && context.project.projectType === 'standard' && context.user.networkAccess
      && (!this.config.weixinPilotUserIds?.length || this.config.weixinPilotUserIds.includes(context.user.id))) {
      const row = this.db.db.prepare("SELECT * FROM weixin_connections WHERE user_id=? AND chat_id=? AND project_id=? AND access_id=? AND status='active'")
        .get(context.user.id, context.chat.id, context.project.id, context.project.accessId);
      if (row && row.credential_epoch === this.db.db.prepare('SELECT workflow_policy_epoch FROM users WHERE id=?').get(context.user.id)?.workflow_policy_epoch
        && this.db.getProjectForUser(context.project.id, context.user.id)?.accessId === context.project.accessId) return row;
    }
    if (!this.config.wechatChannelEnabled || !this.config.wechatChannelProjectId) return null;
    if (!context?.chat || !context?.project || !context?.user) return null;
    if (context.chat.projectId !== this.config.wechatChannelProjectId || context.project.id !== this.config.wechatChannelProjectId) return null;
    const binding = this.db.getChannelBindingByChat(CHANNEL, context.chat.id);
    if (!binding || binding.status !== 'active') return null;
    if (binding.userId !== context.user.id || binding.projectId !== context.project.id || binding.chatId !== context.chat.id) return null;
    if (context.user.role !== 'admin' || context.project.projectType !== 'standard' || context.project.userId !== context.user.id || context.project.accessKind !== 'owner') return null;
    return binding;
  }

  toolsFor(context) { return this.bindingFor(context) ? WECHAT_OWNER_PROJECT_TOOLS : []; }

  #assertHub(active) {
    invariant(this.bindingFor(active), 403, 'WECHAT_OWNER_PROJECT_TOOLS_FORBIDDEN', '该对话不是当前有效的微信项目入口。');
    const user = this.db.getUserById(active.user.id);
    invariant(user?.status === 'active' && user.networkAccess, 403, 'WECHAT_OWNER_REQUIRED', '微信项目入口要求当前活动且获准联网的用户。');
    return user;
  }

  #target(active, projectId) {
    const user = this.#assertHub(active);
    const project = this.db.getProjectForUser(String(projectId || ''), user.id);
    invariant(project && project.projectType === 'standard' && (this.bindingFor(active)?.user_id || (project.userId === user.id && project.accessKind === 'owner')),
      403, 'OWNER_PROJECT_FORBIDDEN', '目标项目不是当前用户获准访问的普通项目。');
    return project;
  }

  call(active, name, args = {}) {
    if (!this.handles(name)) throw new HttpError(400, 'UNKNOWN_TOOL', `未知老板项目工具: ${name}`);
    if (name === 'owner_projects_list') {
      const user = this.#assertHub(active);
      const projects = this.db.listProjectsForUser(user.id)
        .filter((project) => project.projectType === 'standard' && (this.bindingFor(active)?.user_id || (project.userId === user.id && project.accessKind === 'owner')))
        .map((project) => ({
          id: project.id,
          name: project.name,
          slug: project.slug,
          description: project.description || '',
          updatedAt: project.updatedAt,
          hub: project.id === active.project.id,
          accessKind: project.accessKind,
        }));
      return { projects };
    }
    const project = this.#target(active, args.project_id);
    if (name === 'owner_project_list') {
      return this.workspace.tree(project, args.path || '', Math.min(12, Math.max(1, Number(args.max_depth) || 5)));
    }
    if (name === 'owner_project_read_file') return this.workspace.readFile(project, args.path);
    if (name === 'owner_project_search') {
      const query = String(args.query || '');
      invariant(query && query.length <= 1000, 400, 'INVALID_SEARCH', '搜索文本长度必须为 1–1000。');
      const tree = this.workspace.tree(project, args.path || '', 20, 3000);
      const matches = [];
      for (const entry of tree.entries) {
        if (entry.type !== 'file' || entry.size > 1024 * 1024) continue;
        let file;
        try { file = this.workspace.readFile(project, entry.path); } catch { continue; }
        file.content.split(/\r?\n/).forEach((line, index) => {
          if (matches.length < 200 && line.includes(query)) matches.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
        });
        if (matches.length >= 200) break;
      }
      return { query, matches, truncated: matches.length >= 200 };
    }
    throw new HttpError(400, 'UNKNOWN_TOOL', `未知老板项目工具: ${name}`);
  }
}
