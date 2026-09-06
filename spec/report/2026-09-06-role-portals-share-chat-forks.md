# 2026-09-06 角色入口分离与共享对话分叉

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 老板/员工独立入口；share 时复制 owner 既有对话并隔离续聊 |
| 影响范围 | 代码、数据库、API、UI、协议、运维、文档、测试 |
| 架构规格 | [架构索引](../architecture/index.md) |

## 背景与证据

已确认 01 的统一登录入口与新需求冲突；00、02 PRD-003/004 及演进描述禁止完整 transcript 分享，与显式一次性 fork 冲突。现有 share 只复制 Git 文件，chat ACL 仍私有。工作树已有其他未提交变更，本报告仅覆盖新增需求。

## 目标与非目标

### 目标

- 本地与公网使用不同角色路径、登录页面和角色校验。
- 新 share 同时创建独立 worktree 和 owner 当前所有对话的私有 native fork。

### 非目标

- 不做实时同步、员工对话反向共享、不同域名/端口或每 chat 独立 worktree。

## 约束与风险

- 保留 PRD-001/002、DAT-003/004/006 与既有 E2E；先修改 PRD-003/004 的显式 share 例外。
- 分享需 owner 空闲屏障；fork 失败不得授予部分 access；异步完成前复验会话与员工状态。
- 原生 fork 非 SQLite 事务；失败可能保留不可访问的上游孤立 fork，不能删除原始 thread。恢复保留 access 不重复复制。

## 实施计划

1. 先修订架构冲突、一次性共享语义与发布契约。
2. 实现角色入口及 role 登录检查；实现 share 锁、native fork、私有副本/来源记录与失败回滚。
3. 增加 HTTP 隔离、历史快照、续聊与失败测试；运行 npm run gate、diff 与 Markdown 链接检查并补充报告。
4. 真实冒烟发现 ChatGPT App 内置 CLI 已升级为 0.153.4，与固定 pin 不符；保留协议检查，尝试获取官方 npm 的固定版本二进制供本项目运行，验证后才重启。

## 实际改动

- `src/server.mjs`、角色登录页面及脚本：新增 `/employee`、`/boss/login`、`/boss`、`/boss/workbench`，旧入口兼容跳转；新增角色登录 API，密码正确但角色不匹配时不签发会话。老板工作台默认显示项目工作区。
- `src/codex-service.mjs`：owner 分享空闲屏障；原生 thread/fork 使用接收者 cwd、provider、sandbox、instructions。后续 resume 重新安装 Portal dynamic tools。来源 run 只在当前 chat 内关联，避免复制历史越权。
- `src/db.mjs`：新增 nullable `source_chat_id/shared_at`，access、全部 chat 与 fallback 消息原子发布；fork 失败不建立 access；复制 chat 不继承 task 绑定。当前 access 对话列表过滤过期旧副本。
- UI 显示共享范围、复制数量和独立副本标识；本地/公网脚本分别输出两个角色地址；README 与管理员/员工/部署指南同步。
- E2E 保留原有契约并增加角色登录、历史独立续聊、owner busy、失败回滚、恢复不重复与 clean regrant；单元测试覆盖分享屏障、异步撤权与事务回滚/迁移幂等。
- 偏差：真实测试发现 App 内置 CLI 已漂移到 0.153.4；安装官方 npm 的固定版本到被 Git 忽略的 `.tools`，保持源码/schema pin 不变。

## 数据、接口与安全影响

- 数据迁移：两个 chat 来源字段使用幂等 ADD COLUMN；既有授权不自动补发历史。
- API/协议：新增角色登录 API；旧 `/api/login` 保留。share 响应增加 copiedChats，chat 增加来源字段。启用现有精确 schema 已定义的 thread/fork，不升级协议。
- 权限与秘密：显式 owner share 是一次性完整历史分享；不开放原 chat/run/SSE，不复制 task/submission 权限。audit 仅保存复制数量与资源 ID，不记录历史正文。
- 回滚：先排空并停服，恢复发布前代码与配置；新增 nullable 字段可保留。已发布的员工副本与上游 fork 不删除，回滚不能撤回已被员工读取的历史。若回退到不支持 fork 的旧版本，暂停新 share；需要撤回 access 应走正常撤权流程。固定二进制保留，不能回退到协议不兼容的 App 路径后直接重启。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git diff --check` | 通过 | 无空白错误；保留本轮开始前的未提交改动 |
| `npm run gate` | 通过 | macOS 真实 loopback 与 Seatbelt；63 个单元/集成测试、14 个 E2E 测试，0 失败、0 跳过 |
| `python3 /tmp/check-portal-markdown-links.py` | 通过 | README/docs/spec 共 27 份文档、74 个相对文件链接无断链 |
| `node /tmp/portal-native-share-smoke.mjs` | 通过 | 官方固定版本真实模型：fork 继承早前上下文，员工续聊后 owner 用户消息仍为 1 条，员工为 2 条 |
| CUA 浏览器检查临时服务 `/boss/login`、`/employee` | 通过 | 独立标题、文案、配色、表单；老板标题换行已修正，未提交真实登录 |
| `./bin/stop-local.sh`、`./bin/start-local.sh` | 通过 | 先验证空闲并做私有 DB/config 备份；保留隧道；固定二进制 initialize 后 ready |
| `python3 /tmp/portal-role-live-check.py` | 通过 | 本地/公网两个入口 HTTP 200，health ready；正式库 integrity ok、外键错误/active run/pending approval/lease 均 0 |

自动 gate 使用临时 DB/worktree 和 fake app-server。浏览器检查两个登录页，没有提交真实账号。真实 native smoke 使用一次性 Portal 用户、项目与工作树，仅使用本机既有 Codex 上游登录；测试源 thread 和 fork 都请求归档，临时数据库与工作树删除。

预览首次启动发现 `.env` 的显式 DATABASE_PATH/WORKSPACES_ROOT 会覆盖 DATA_DIR 派生默认，曾短暂连到正式库并执行幂等 schema 初始化；立即停止并以完整临时路径重新启动。随后只读检查确认没有 active run、没有本次新生成的 PORTAL_RESTARTED 事件；未执行生产对话或文件操作。新增来源字段已提前幂等添加。正式重启前另做 SQLite backup 与完整性检查。

## 结论

两个需求已完成，且先修订原有冲突 spec 后实施。新 share 同时复制文件基线与 owner 已有对话，员工后续在自己的 worktree/thread 中继续；原内容 ACL、task/submission 与 release gate 保持。已完成本地服务重启及公网页面验证，可使用新入口；现有 Quick Tunnel 未重启。

## 遗留事项

- 已有 active share 不自动补发历史，恢复 retained access 不覆盖员工已有副本；这是本轮明确的迁移语义。
- 上游 fork 与 SQLite 不能组成分布式事务；失败时可能保留不可由 Portal 用户访问的上游孤立 fork，后续可另建运维清理能力。
- 新增真实测试线程已归档，真实 smoke 的临时数据库/worktree 与预览服务/目录已清理；普通 gate 延续既有临时目录留存方式，仅含合成数据。
- `.tools` 中固定版本与 `.env` 的 CODEX_BIN 是本机部署配置；其他机器需单独安装匹配架构版本。未提交 Git commit。
