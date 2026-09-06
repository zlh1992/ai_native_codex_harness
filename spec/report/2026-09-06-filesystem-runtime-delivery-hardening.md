# 2026-09-06 文件系统、运行时与代码交付加固

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 复核并修复文件 TOCTOU、撤权窗口、跨项目 runtime、分享基线、同树并发与任务代码交付六项审查意见 |
| 影响范围 | 文件服务、命令沙箱、Git worktree、数据库迁移、任务提交/审核 API、架构规格、测试 |
| 架构规格 | [架构总览与决策](../architecture/00-overview-and-decisions.md)、[系统上下文与组件](../architecture/01-system-context-and-components.md)、[项目强制约束](../architecture/02-project-constraints.md)、[领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[执行、并发与生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[持久化、事件与恢复](../architecture/06-persistence-events-and-recovery.md)、[端到端发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

本轮收到六项静态审查意见。对当前工作树的初步核对结论如下：

1. 文件路径校验与主进程实际读写之间仍存在 TOCTOU；现有 `lstat`/`realpath` 检查本身不能约束外部进程在随后 `readFileSync`/`writeFileSync` 前替换路径。这是源码可见风险，尚未在真实攻击进程中验证利用。
2. 文件上传已在 `await readBody()` 后重新执行 `projectFor()` 和 workspace idle 检查，单纯撤权会阻止写入；但复验没有固定原 `accessId`，也没有确认入口 session 仍存在，仍需统一收紧异步授权复验。
3. 命令 `HOME`/`TMPDIR` 当前按 `user.id` 复用，导致同一员工不同 access 的命令可互相影响，意见属实。
4. 分享当前已经从 owner `HEAD` 加上 tracked diff 与 untracked files 创建员工快照，并由单元测试和 E2E 验证；“只分享旧 HEAD”不符合当前代码。不过原 `baseSha` 仍只指向旧 HEAD，复制进去的改动不是不可变基线，因此本轮继续收紧为先提交 owner 当前 Git 可见状态、再从该 commit 建树并展示 SHA。
5. root turn 当前以 `project.accessId` 为 workspace key 串行，浏览器写操作也检查 `workspaceBusy(accessId)`；“只按 chat 并发”不符合当前代码。但两个浏览器标签页仍可从同一旧内容整文件覆盖，因此补充 SHA-256 乐观版本校验。
6. submission 当前只保存回复/diff，未绑定 Git commit/tree；`passed` 只改变数据库状态而不交付代码，意见属实。

## 目标与非目标

### 目标

- 把 Portal 文件 API 的实际文件操作置于只允许目标项目/回收站的 Seatbelt 边界内，使路径竞态不能变成宿主文件越界。
- 所有带异步请求体或解析窗口的敏感写操作在落盘前确认原 session 和原 `project_access.id` 仍有效。
- 将命令 `HOME`/`TMPDIR` 按 `project_access.id` 隔离。
- 提交任务时创建不可变 Git commit/tree 快照；审核 `passed` 前把该固定快照合入 owner 项目，合并失败时不改变审核状态。
- 保持既有分享快照与同 worktree 单写者契约，并用回归测试证明。

### 非目标

- 不引入每 task/chat 独立 worktree、自动冲突解决或 PR 系统。
- 不宣称 Seatbelt 能替代独立 OS 用户、VM、容器或敌对多租户隔离。
- 不自动迁移历史无 Git 快照的 pending submission 为已交付；它们必须返工后重新形成可审核快照。
- 不改变 chat transcript 的私有边界，也不共享完整对话。

## 约束与风险

- 遵守 `FS-001` 至 `FS-006`、`DAT-001`、`DAT-004`、`DAT-006`、`DEV-001` 至 `DEV-006`。
- 文件 helper 必须 fail closed；不能因非 macOS 或 sandbox 启动失败退回不受保护的主进程读写。
- Git 与 SQLite 无法组成单一原子事务。交付合并必须可重试：若 Git 已包含 submission commit 而数据库尚未完成审核，重试应识别祖先关系并安全完成数据库状态迁移。
- owner 的未提交修改必须先形成明确快照后再合并；冲突必须中止 merge 并保留 owner 数据和 pending 审核状态。
- migration 使用兼容的 nullable `ADD COLUMN`；新 submission 在应用层要求完整快照字段，历史记录保持可读。
- 当前工作树已有一组与超级管理员边界相关的未提交规格修改；本轮不覆盖或回退这些用户现有修改。

## 实施计划

1. 为 WorkspaceService 增加受 Seatbelt 约束的文件操作 helper，覆盖读取、写入、建目录和移入回收站，并补竞态/越界回归测试。
2. 增加以原 session、project id、原 access id 为条件的异步复验，覆盖上传及其他相关 await 后写入路径。
3. 将 runtime 布局调整为 `runtime/<user-id>/<project-access-id>/{home,tmp}`，更新命令沙箱测试和长期架构说明。
4. 扩展 submission schema 和 DB 不变量，提交时由 WorktreeService 生成 commit/tree 快照，审核通过前执行可重试的 owner merge。
5. 更新 HTTP E2E，使提交确实带固定 Git 快照、审核 passed 后 owner 文件可见，并保持分享快照与 workspace 串行断言。
6. 运行针对性测试、`npm run gate`、`git diff --check` 和 Markdown 相对链接检查，回填实际结果与回滚方案。

## 实际改动

- `src/fs-operation-worker.mjs` 新增专用同步 helper。它在 Seatbelt 内再次检查路径分量，读取和版本计算使用 `O_NOFOLLOW` 文件描述符，写入使用同目录随机临时文件、`fsync` 和原子 rename；树遍历、文件读取/元数据、写入、建目录与文件回收均通过该 helper。
- `src/fs-service.mjs` 不再在主进程直接完成面向用户的 CRUD；每次操作生成只允许 canonical project、源码 helper，以及必要时本次 actor/access trash 的最小 profile。读取返回 SHA-256 `version`，条件写把 `expectedVersion` 传入 helper。
- `src/server.mjs` 将认证 session 设为可刷新事实。上传和其他解析请求体后的敏感 mutation 会重新读取 session、用户、project/chat/task，并固定操作开始时的 access id；登录密码验证后也会确认账号与哈希未变化。上传撤权窗口不再落盘。
- 浏览器编辑器保存携带读取所得 `If-Match`；服务端 stale save 返回 `FILE_VERSION_CONFLICT`。显式勾选覆盖的上传仍保留人工 force overwrite 语义。
- 命令 runtime 从 user 级改为 `runtime/<user-id>/<project-access-id>/{home,tmp}`；同一员工不同 access 的命令不能共享可写 HOME/TMP。旧 user 级 runtime 不再进入新命令 profile。
- 分享授权不再从旧 HEAD 建树后应用易变 patch；它先把 owner 当前 Git 可见状态提交成 baseline commit，再持久化/返回 `baseSha` 并从该 commit 建 worktree。老板 UI 显示 baseline 短 SHA。
- `task_submissions` 增加原 `project_access_id`、snapshot commit/tree、delivery commit/time。员工提交前等待 worktree 空闲并提交完整 Git 状态；保留路径、symlink 和 submodule 条目 fail closed。
- `passed` 审核先复验 owner、submission、原 access、下一 assignee 及两个 workspace 的状态，再快照 owner 当前修改并合入精确 submission commit。冲突会 abort 且不推进数据库状态；成功记录 owner delivery commit 后才将 task/roadmap 标为 passed。若 Git 成功后 SQLite 未更新，重试通过 ancestor 检查幂等收敛。
- 更新架构规格、员工提交说明、老板分享展示、单元/集成测试和固定 HTTP E2E；既有超级管理员边界修改保持不变。

## 数据、接口与安全影响

- 数据迁移：对 `task_submissions` 幂等增加 5 个 nullable 字段：`project_access_id`、`snapshot_commit_sha`、`snapshot_tree_sha`、`delivery_commit_sha`、`delivered_at`；保留旧 submission 可读性。新 submission 由应用层强制快照字段，历史无快照的 pending submission 只能 `rework` 后重提，不能直接 passed。
- API/协议：文件 GET/PUT 响应新增 `version`；PUT 可接受标准 `If-Match` SHA-256，冲突返回 409 `FILE_VERSION_CONFLICT`。submission payload 新增 access/snapshot/delivery 字段；review `passed` 现在包含实际 Git merge，可能返回 `WORKSPACE_BUSY`、`SUBMISSION_ACCESS_REVOKED` 或 `DELIVERY_MERGE_CONFLICT`。Codex app-server 协议未改变。
- 权限与秘密：异步 mutation 固定原 session/access；文件实际打开受 Seatbelt 限制；命令 runtime 按 access 分离。审计只记录资源 id 与 Git SHA，不记录文件正文、密码、token、命令或 raw diff。
- 回滚：nullable schema 字段不会阻止旧二进制读取，但旧实现会重新允许无 Git 快照的 submission 和“passed 不 merge”，因此不能在活跃任务流程中把降级视为安全回滚。必须先停服、备份并确认没有 pending/active task，再切换代码；授权 baseline commit、submission commit 和已完成的 owner merge 都是需要保留的 Git 证据，不能静默删除。确需撤销某次交付时应在 owner 仓库显式 revert 对应 delivery commit。旧 user 级 runtime 目录不会自动删除，可在停服核对后离线清理。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm test` | 通过 | 55/55；覆盖旧 submission schema 幂等迁移、deterministic path swap、access runtime 隔离、Git snapshot/delivery 与既有权限/生命周期契约。 |
| `npm run test:e2e` | 通过 | 10/10；覆盖 baseline SHA、workspace 串行、stale editor save、submission/delivery、上传中撤权及原有发布流程。 |
| `npm run gate` | 通过 | 当前 macOS 25.5.0 主机具备 loopback bind 与 Seatbelt；语法、Shell、55 个单元/集成测试及 10 个 HTTP E2E 全部通过。 |
| `git diff --check` | 通过 | 无 whitespace error。 |
| Markdown 相对链接检查 | 通过 | Node 脚本验证 `spec/architecture/` 与 `spec/report/` 共 17 个 Markdown 文件的相对链接均存在。 |

## 结论

六项意见已逐条复核并处理：文件 TOCTOU、原 access/session 复验、access runtime、不可变分享基线、浏览器版本冲突和代码交付链均形成实现与测试契约；原本已经存在的 access 级 root 串行保持不变并继续由 E2E 覆盖。任务 `passed` 现在同时代表固定 submission commit 已合入 owner 且 delivery commit 已记录。完整 macOS 发布 gate 已通过，可以进入发布复核。

## 遗留事项

- 历史无 Git 快照的 pending submission 需要老板选择 `rework` 并让员工重新提交；系统不会伪造历史 commit。
- 每 task 独立 worktree、自动冲突解决、PR 和完整代码审核 UI 仍是明确非目标；当前交付边界是 access worktree snapshot + owner merge。
- 旧 `runtime/<user-id>/{home,tmp}` 不再使用但未自动删除，以避免未经核对清除潜在用户数据。
