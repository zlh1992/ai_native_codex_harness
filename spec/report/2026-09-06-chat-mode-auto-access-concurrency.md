# 2026-09-06 对话独立模式、项目内自动放行与并发执行

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 修复同项目不同对话共享 EDIT/EXECUTE 选择、EXECUTE 逐命令确认和同 access 对话互相阻塞的问题 |
| 影响范围 | SQLite、API、UI、Codex approval、执行调度、文档、测试 |
| 架构规格 | [架构总览与决策](../architecture/00-overview-and-decisions.md)、[系统上下文与组件](../architecture/01-system-context-and-components.md)、[项目强制约束](../architecture/02-project-constraints.md)、[领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[执行、并发与生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[持久化、事件与恢复](../architecture/06-persistence-events-and-recovery.md)、[端到端发布契约](../architecture/07-e2e-release-contracts.md)、[运维与演进](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

当前页面只有一个全局 `#mode-select`，chat payload 和 SQLite `chats` 均不保存偏好模式。用户在一个对话选择 EXECUTE 后切换到同项目另一对话，下拉框保持原值，因此表现为对话之间互相改变模式。

当前调度把 `project_access.id` 作为排他 workspace key，同一 owner 目录或员工 worktree 上的所有顶层 turn 强制串行；EXECUTE 另有 2 个 lease 的硬上限。当前命令 dynamic tool 与原生文件变更还会创建 pending approval，等待浏览器逐次接受。这些都是现有契约，而不是单纯的 UI 展示问题。

用户明确要求老板与员工使用同一策略：项目内默认完全访问，EXECUTE 不再逐次确认，同一项目的不同对话具备并发能力。

## 目标与非目标

### 目标

- 为每个 chat 持久化独立 `preferred_mode`，新建与迁移后的对话默认 EXECUTE，切换对话恢复各自选择。
- EDIT 继续只提供项目文件读写；EXECUTE 提供项目文件读写与命令执行。
- 对已经通过用户、chat、active access、项目路径和保留目录校验的文件变更，以及 EXECUTE 中的项目命令，自动记录并接受 approval，不再等待浏览器点击。
- 移除同一 `project_access` 不同 chat 之间的排他 turn 锁；只受同 chat、用户并发、Portal root 11 席和 Codex 40 turn 上限约束。
- 默认 EXECUTE lease 上限与 Portal root 上限一致，使默认配置不再额外把 EXECUTE 压到 2 路。

### 非目标

- 不开放宿主机任意路径、其他项目、Codex/Portal 凭据、保留目录或跨用户资源。
- 不改变用户网络策略；命令网络仍由账号的 `networkAccess` 控制。
- 不允许同一个 chat 同时启动两个 root turn。
- 不实现 per-chat worktree、自动合并或冲突消解；并发 turn/命令同时修改同一文件时仍可能产生业务级覆盖或构建冲突。
- 浏览器文件写入、任务快照与交付 merge 仍要求整个 access 空闲，以免与未知命令写入并发。

## 约束与风险

- 继续满足 `PRD-001`、`PRD-003`、`FS-001`、`FS-002`、`FS-006`、`DAT-004`、`CAP-001`、`CAP-003`、`DEV-001` 至 `DEV-006`。
- 本变更有意替换 `FS-004` 的 access 单写者部分与原 `CAP-002` 的两路 EXECUTE 上限，并同步修改架构和 E2E 契约。
- 自动放行只发生在服务端重新确认 active user/access，且路径被规范化到当前项目之后；校验失败继续 fail closed。
- 同目录并发会牺牲原单写者提供的写入确定性。回归测试必须证明并发本身成立，同时明确冲突风险和 access 级生命周期屏障仍存在。
- SQLite 新列迁移必须幂等；旧对话统一获得 EXECUTE 默认值。

## 实施计划

1. 为 chat 增加 `preferred_mode` 迁移、映射与 PATCH/turn 启动持久化，更新前端切换与默认文案。
2. 将项目内合法文件/命令 approval 改为自动接受并保留脱敏审计记录，继续拒绝 EDIT 命令和越界目标。
3. 移除 capacity 的 access 排他启动条件，把默认 EXECUTE 上限提升到 root 上限，同时保留 access busy 查询供浏览器写入、提交、交付和生命周期屏障使用。
4. 更新单元测试、HTTP E2E、长期架构和操作文档。
5. 运行语法、单元、E2E、Markdown 相对链接、`git diff --check` 与完整 `npm run gate`，记录结果和遗留风险。

## 实际改动

- `src/db.mjs` 为 chat 新增 `preferred_mode`，新库建表与旧库 `ADD COLUMN` 均默认 `execute`；chat 创建、映射和更新接口统一读写该字段。
- `src/server.mjs` 让 chat PATCH 可独立更新标题或模式，turn 启动默认使用并持久化 chat 自己的模式；两条路径都在异步请求体读取后复验 session、chat 与 active access。
- `public/app.js`/`public/index.html` 把 EXECUTE 作为默认选项，切换 chat 时恢复各自模式，修改下拉框时立即持久化；文案明确 EDIT 仅文件读写、EXECUTE 为文件加命令。
- `src/codex-service.mjs` 保留 app-server `readOnly + on-request` 基线，以便 Portal 在原生文件写入前取得目标集合。合法文件目标与 EXECUTE 命令在 active user/access、模式、cwd、保留目录和网络策略校验后自动记录 accepted approval 并继续；不再产生等待浏览器点击的 pending approval。EDIT 命令、越界和目标缺失仍拒绝。
- `src/capacity-service.mjs` 不再用 `workspaceKey` 作为启动排他锁，但仍保留 access 占用查询，供浏览器写入、submission、delivery、删除和撤权排空使用。`src/config.mjs` 把默认 EXECUTE lease 从 2 提升为 root 上限 11，并保证配置值不超过 root 上限。
- 单元测试新增旧 chat 模式迁移、模式隔离、自动文件 approval、免确认 EXECUTE、EDIT 命令拒绝和同 access 多 chat 并发；固定 HTTP E2E 由“同 tree 串行”更新为“第二 chat 在第一 chat 仍运行时完成”，并继续验证浏览器写锁和排空恢复。
- 同步更新 README、操作文档和全部相关架构规格；没有修改 Codex 协议 pin 或生成 schema。
- 发布前只读检查确认正式库没有 active run、pending approval 或 lease；随后停止本地服务，把停服后的 SQLite 主文件备份到 `.data/backups/chat-mode-20260906-9TAWiH/harness.sqlite`，再启动新版本。公网隧道未停止，重启后 health 恢复 ready。

与计划一致。为保持现有安全边界，没有把 app-server 改成宿主级 `dangerFullAccess`，也没有放开其他项目或凭据路径；这里的“完全访问”定义为当前 active access 的项目目录与其隔离 runtime 内免交互读写/执行。

## 数据、接口与安全影响

- 数据迁移：`chats` 幂等增加 `preferred_mode TEXT NOT NULL DEFAULT 'execute' CHECK(...)`；旧 chat 自动得到 EXECUTE，无数据重写或删除。迁移回归连续关闭/重开数据库后通过。
- API/协议：chat payload 新增 `preferredMode`；现有 `PATCH /api/chats/:id` 接受 `preferredMode`，`POST /turns` 省略 mode 时采用 chat 偏好并在显式传入时同步偏好。Codex app-server 协议版本不变。
- 权限与秘密：老板与员工的项目内文件/EXECUTE approval 均改为自动 accepted；ACL、chat 所有权、项目路径、`.git`/`.codex`、符号链接、最小环境、Seatbelt、配额、超时和网络策略不放宽。事件与审计只记录 approval id、kind 和 automatic 标志，不记录命令、文件正文或 raw diff。
- 并发：同 access 不再是 turn 启动排他键；同 chat、用户、Portal root、Codex 和可选运营 EXECUTE 上限仍有效。浏览器写入、submission 和 delivery 的 access 空闲屏障保持不变。
- 清理：测试全部使用临时数据库、临时项目与 fake app-server；未创建或修改生产账号、会话、项目内容。正式库只执行 additive chat 列迁移，备份保留用于回滚；公网隧道沿用既有受管进程。
- 回滚：先中断并排空所有同 access turn，再恢复 capacity workspace 排他条件、人工 approval 流程、默认 2 个 EXECUTE lease 和旧 UI。新增 `preferred_mode` 列可保留供旧二进制忽略；若必须移除，应在停服备份后重建 chats 表，不能在线破坏 thread/submission 外键。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/approval-security.test.mjs test/chat-mode.test.mjs test/capacity.test.mjs test/config.test.mjs test/frontend.test.mjs` | 通过 | 18/18；覆盖自动放行、EDIT 拒绝、模式迁移/隔离和同 access 并发。 |
| `npm test` | 通过 | 60/60；包含真实 macOS Seatbelt 命令和文件 helper。 |
| `node --test --test-concurrency=1 test/e2e/portal-gate.test.mjs` | 通过 | 固定 Portal release gate 10/10。 |
| `npm run gate` | 通过 | 退出码 0；check 60/60，固定 HTTP E2E 10/10，macOS loopback 与 Seatbelt 用例实际执行、无 skip。 |
| `git diff --check` | 通过 | 无空白错误。 |
| Markdown 相对链接校验 | 通过 | 复核 28 个 Markdown 文件，所有相对目标存在。 |
| `./bin/healthcheck.sh` | 通过 | 正式服务重启后返回 `ok=true`、`codex=true`、`codexState=ready`、`initialized=true`。 |
| 公网 quick tunnel `/api/health` | 通过 | 重启后经既有 HTTPS 隧道返回同一 ready 状态；未把临时 URL 写入报告。 |
| 正式 SQLite 只读检查 | 通过 | `integrity_check=ok`，`chats.preferred_mode` 已存在，active run/pending approval/lease 均为 0。 |

## 结论

目标已达成并已部署到当前试用服务：模式现在属于 chat 且默认 EXECUTE；同一 access 的不同 chat 可并发；老板与员工的合法项目内文件变更和 EXECUTE 命令都不再等待逐次点击；项目、路径、秘密、网络与生命周期边界保持有效。完整 macOS release gate、正式库迁移与重启后健康检查均已通过。

## 遗留事项

- P2：若未来要求并发任务互不观察中间修改或自动消除同文件冲突，需要引入 per-chat/task worktree 与显式 merge；本轮按试用目标接受共享 tree 并发语义。
