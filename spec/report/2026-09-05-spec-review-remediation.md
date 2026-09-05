# 2026-09-05 Spec Review 八项问题修复

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-05 |
| 负责人 | Codex |
| 关联目标 | 修复 2026-09-05 代码审查发现的八项安全、生命周期、数据与运维问题 |
| 影响范围 | 文件 API、Codex approval、用户生命周期、读取 ACL、运行终态、任务审核、存储配额、健康检查、安装脚本、文档、测试 |
| 架构规格 | [项目约束](../architecture/02-project-constraints.md)、[领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[执行并发与生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[E2E 发布契约](../architecture/07-e2e-release-contracts.md)、[运维与演进](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

按当前 spec 对工作树实施只读审查后确认八类问题：macOS 大小写不敏感文件系统可绕过保留目录检查；原生文件 approval 未校验真实目标；改密/停用不能覆盖 thread setup 窗口且不等待排空；异步 chat/goal 读取返回前未复验 ACL；运行容量早于持久终态释放；submission 审核只检查下一任务 assignee；trash 未计入用户存储用量；skill 注册失败可被 health 误报为 ready，且干净 checkout 的安装/首次启动流程不完整。

其中保留路径、trash 配额和跨 assignee 审核均已在隔离临时目录复现。修复前的 `npm run gate` 虽然通过，但没有覆盖这些分支，因此当时的门控成功不能消除风险。

## 目标与非目标

### 目标

- 对大小写不敏感文件系统实施保留目录的规范化拒绝，并增加回归测试。
- 对 Codex 原生文件 approval 提取、展示并逐项校验目标；无法证明安全时默认拒绝。
- 让用户改密、停用和网络策略变化中断并等待 queued、setup、active、approval、subagent 与 lease 排空。
- 在敏感异步读取返回数据前重新获取用户、chat、task 和 project access。
- 保证 run、chat、approval 和 lease 的持久终态先于内存容量释放。
- 审核 submission 前校验当前 task assignee 仍有 active project access。
- 把可恢复 trash 纳入用户存储配额。
- 让 health 依赖 Portal skill ready，并使干净 checkout 的安装和首次启动流程可用。

### 非目标

- 不实现敌对多租户、独立 worker、硬文件系统 quota 或企业身份能力。
- 不改变 roadmap 的线性语义，不新增数据库表或公开 API。
- 不处理审查中编号 9 的 Origin、plan journal 和项目配置 allow-list 加固。

## 约束与风险

- 遵守 `FS-001`、`FS-002`、`DAT-004`、`DAT-006`、`CAP-005`、`RUN-004` 和 `DEV-003`。
- approval 协议同时存在 legacy `applyPatchApproval` 与 v2 file-change request；目标字段缺失或形态未知时必须 fail closed。为消除 `workspaceWrite` 下无需 approval 的原生写入旁路，Codex thread/turn 改用 `readOnly` 基线，文件写入只通过受检 approval 或 Portal dynamic tool。
- lifecycle 排空不能只依赖数据库轮询，必须覆盖尚未进入 `activeByChat` 的 setup 窗口。
- 终态顺序调整不能让 queue 永久占用；数据库失败时仍需记录错误并安全清理内存。
- trash 归属按 actor user 存储；owner 项目删除和共享 access 文件删除都必须被计入对应 actor 的用量。
- 当前工作树存在既有未提交修改，实施时保留并避免覆盖无关内容。

## 实施计划

1. 强化路径规范化和原生 approval 目标解析，补充单元测试。
2. 增加 user-scope setup 中断与排空，并在异步读取后复验 ACL。
3. 调整终态持久化/容量释放顺序，修复 task ACL 与 trash 用量。
4. 修复 skill-ready 状态、依赖安装和首次日志创建。
5. 更新架构/E2E 契约、运行针对性测试、完整 `npm run gate`、`git diff --check` 和 Markdown 链接检查。

## 实际改动

- `src/fs-service.mjs` 对保留路径和隐藏目录执行 NFKC 规范化与大小写折叠；用户用量新增 actor trash 递归统计，符号链接不计入。
- `src/codex-service.mjs` 将 Codex thread/turn sandbox 基线改为 `readOnly`；缓存 v2 file-change item/patch 目标并解析 legacy `fileChanges`/`move_path`，将目标转为项目相对路径逐项校验和展示。缺失、越界、保留目录、目标变化和持久 `grantRoot` 请求全部拒绝；未知 approval method 不再误分类为命令批准。
- `public/app.js` 在文件批准卡显示经后端校验的相对目标列表，不展示 diff 或文件正文。
- 用户级中断新增 pending setup 标记、capacity user 查询、数据库 runtime 复核和 `interruptUserAndWait`；用户停用、改密或网络策略变化在返回前等待排空，超时返回 `USER_DRAIN_TIMEOUT` 并记录策略已生效但排空未完成的审计状态。
- chat history、goal 和 spreadsheet preview 在相关 await 后重新查询原 session、用户、chat/thread mapping 与 project access；Codex history 在把原生内容写入本地消息快照前调用授权回调。
- run 启动失败和正常终止都先持久化 run/chat/approval/事件/消息终态，再删除 lease、释放 capacity 并唤醒队列。
- `reviewSubmission` 在事务内先校验当前 task assignee 的 active project access，再按 passed 结果校验下一 assignee，避免不同 assignee 时绕过撤权。
- Codex health 的 ready 同时要求 client initialize、Portal skill 注册成功且无服务级启动错误；skill 注册失败会稳定报告 failed。
- `install-mac.sh` 使用 lockfile 执行 `npm ci --omit=dev --ignore-scripts`；`start-local.sh` 在读取日志行号前创建并收紧日志权限；README 同步说明自动安装行为。
- 更新安全、领域、并发、运维架构规格，并新增 approval、路径、quota、生命周期、终态顺序、任务 ACL、health、安装与 UI 回归测试。固定 HTTP E2E 新增大小写保留路径、trash 用量和改密排空场景。

与原计划的主要强化是：仅校验 approval 不足以覆盖 `workspaceWrite` 内无需审批的原生修改，因此把原生 sandbox 改为 `readOnly`，由受检的单次 file approval 或 Portal dynamic tool 完成写入。该决策已同步进入安全架构。

## 数据、接口与安全影响

- 数据迁移：无；trash 用量统计会即时反映已有可恢复文件。
- API/协议：无新增端点、无 schema 变化。approval 公共 payload 新增脱敏 `files` 数组；用户策略 PATCH 在策略已更新但 45 秒未排空时返回 `409 USER_DRAIN_TIMEOUT`；health 对 skill-ready 的判定更严格。
- 权限与秘密：加强路径、单次 file approval、异步读取和用户生命周期校验；不记录真实 prompt、命令、diff 或文件正文。原生 sandbox 从 `workspaceWrite` 收紧为 `readOnly`，Portal dynamic tool 的授权写入不受影响。
- 回滚：可按本报告列出的文件逐项还原；无不可逆数据迁移。已有 trash 不需转换。回滚 sandbox、路径或 drain 修复会重新暴露已确认的安全和一致性问题，不建议单独回滚。
- 清理：测试数据库、worktree、文件和 fake app-server 均位于测试临时目录并由进程退出清理；未使用真实账号、生产数据或公网隧道。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/approval-security.test.mjs test/workspace.test.mjs test/task.test.mjs test/recovery.test.mjs test/protocol.test.mjs` | 通过 | 31/31；覆盖八项问题的核心服务与数据分支。 |
| `npm ci --omit=dev --ignore-scripts` | 通过 | 从 lockfile 安装 97 个包，审计为 0 vulnerability；存在既有 transitive package deprecated 警告。 |
| `npm run gate` | 通过 | macOS 主机执行；51/51 单元/集成测试，固定 E2E 9/9，无 skip。 |
| `git diff --cached --check` | 通过 | 最终暂存集合无空白或 patch 格式错误。 |
| Markdown 相对链接检查 | 通过 | 扫描 23 个 Markdown 文件，无缺失相对目标。 |

所有复现与验证使用临时目录、fake app-server 或本机开发数据；不写入真实密码、token、Cookie、生产文件内容或完整 prompt。

## 结论

八项目标均已实现并形成回归覆盖：文件保留边界和原生写入默认拒绝旁路；用户生命周期与异步内容读取重新验证授权；容量只在持久终态后释放；任务审核和 trash 配额遵守现有不变量；health、依赖安装与首次日志创建完成闭环。`npm run gate` 已在符合要求的 macOS 主机通过。

本报告范围内可以进入合并审查；最终暂存 diff 与 Markdown 检查已通过。当前暂存集合已按本阶段整体范围纳入既有 spec、E2E 与生成协议文件。

## 遗留事项

- 真实上游 Codex 模型质量、账号策略和延迟仍按 `E2E-008` 排除在确定性 gate 之外；部署前应使用隔离账号对 read-only + 单次 file approval 做一次真实冒烟。
- `exceljs` 的依赖树在 npm 安装时报告若干 deprecated transitive packages，但当前审计为 0 vulnerability；后续依赖升级单独处理。
