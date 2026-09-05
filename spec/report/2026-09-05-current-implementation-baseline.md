# 2026-09-05 当前实现基线：P0/P1 加固、协作语义与发布门控

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-05 |
| 负责人 | Codex 与项目负责人 |
| 关联目标 | 深度复核架构审计，修复全部 P0/P1，通过老板/员工公网链路测试并固化 E2E 门控 |
| 影响范围 | SQLite、ACL、worktree、并发、Codex thread、SSE、任务、UI、运维、协议、测试与文档 |
| 架构规格 | [架构总览](../architecture/00-overview-and-decisions.md)、[领域不变量](../architecture/03-domain-model-and-invariants.md)、[E2E 契约](../architecture/07-e2e-release-contracts.md) |

## 背景

原架构审计认为系统的服务端授权方向正确，但 submission 生命周期、thread 恢复、删除/撤权竞态、同 tree 并发、多员工授权、SSE 恢复、messages fallback 和审计存在 P0/P1 缺口；共享 App Server/`CODEX_HOME` 与企业身份属于更高阶段边界。

本轮选择最小但闭环的修复：继续保留单体 Portal 和 owner/shared ACL，不引入每任务 worktree、消息中间件或组织权限体系；以 access/worktree 单写者、不可变 submission、显式 thread lineage 和持久语义事件完成 P0/P1。

## 实施计划与完成情况

| 计划 | 结果 |
| --- | --- |
| 修复提交证据与 chat 删除不变量 | 完成：submission chat/run 外键改为 `SET NULL`，保留不可变快照，含证据 chat 禁止删除，历史孤儿幂等转 rework。 |
| 禁止 resume 失败静默换线 | 完成：保留旧 thread，进入 `resume_failed`，支持 retry 与确认 history break 的 reset，记录 lineage。 |
| 为撤权、删除、停用建立运行屏障 | 完成：覆盖 queued/starting/running、approval、subagent/recovery 和 lease，超时保留数据。 |
| 消除同 worktree 并发写 | 完成：同 `project_access` 全部 root 串行，浏览器写操作也使用 workspace busy guard。 |
| 支持一个项目多员工 | 完成：移除单 shared 员工索引，每名员工建立独立 access/branch/worktree，支持恢复原脏 tree。 |
| 建立断线恢复与历史兜底 | 完成：持久 turn event cursor、SSE replay、前端分页恢复、确定性 user/final/error messages。 |
| 固化真实 HTTP E2E | 完成：老板/双员工、隔离、任务、提交、审核、ACL、撤权、恢复全部进入 `npm run gate`。 |
| 重新加载正式服务并做公网真实验证 | 完成：升级协议后正式 health ready，公网老板/员工与真实 Codex 冒烟通过并清理。 |

## 架构审计处置结论

| ID | 处置 |
| --- | --- |
| R1 submission 级联丢失 | 已修复并加入数据不变量测试。 |
| R2 resume 覆盖 thread | 已修复并加入失败注入、显式恢复与 lineage E2E。 |
| R3 shared App Server/`CODEX_HOME` | 未伪装为已修复；已明确限制为内部互信 Pilot。 |
| R4 同 tree 多 chat 并发 | 已用 access/worktree 单写者锁修复；没有采用每任务 worktree。 |
| R5 单员工授权 | 已支持多员工独立 worktree。 |
| R6 SSE 不可恢复 | 已增加持久语义 journal、cursor 和重放。 |
| R7 messages fallback 空 | 已接入确定性终态快照与 native history 合并。 |
| R8 项目删除竞态 | 已对 chat/access/project 全范围 guard。 |
| R9 工具/子代理审计 | 已补脱敏语义事件与审计；敏感正文明确不记录。 |
| R10 企业身份 | 仍为 P2：邀请、OIDC/MFA、自助改密、设备会话和持久限流未实现。 |

## 主要实现

### 数据库与不变量

- `src/db.mjs` 新增/完善 `turn_runs`、`turn_approvals`、`execution_leases`、`turn_events`、`chat_thread_recoveries` 和 retention migration。
- submission 保存 final reply/diff/native ids，不随 chat/run 删除；来源 chat 仍由应用层保护。
- 增加 chat/access/project runtime 查询以及事务式删除 guard。
- 启动时把遗留运行转为 interrupted，取消 approval、清理 lease，并幂等修复孤儿 submitted task。

### Worktree、权限与容量

- `src/worktree-service.mjs` 为每个 shared access 创建独立 worktree，授权快照包含 owner 已跟踪与未跟踪本地变化。
- 撤权先 revoked，再中断/排空；干净 tree 删除，脏 tree 保留；重授权同一员工恢复原 access/tree。
- `src/capacity-service.mjs` 增加 workspace key 单写者、11 个 root、2 个 EXECUTE lease 和可取消队列。
- 文件 PUT/DELETE/mkdir、chat/project 删除和恢复操作都参与同一生命周期边界。

### Codex 生命周期

- `src/codex-client.mjs` 只启动 stdio app-server，以最小环境运行并检查精确 CLI 版本。
- `src/codex-service.mjs` 在异步边界后重查 user/access/network/task policy；处理启动前 interrupt 和 fast-completion 竞态。
- task turn 注入受 Portal 管理的 skill，goal 保持 paused，避免绕过 Portal lease 自动续跑。
- 原生子代理固定最多 3 个、默认 Luna，并检查 thread settings/collab item。

### 事件、前端与 API

- turn SSE 带持久 id；新增按 run 重放接口，跨用户和跨 chat 拒绝。
- 前端按最多 5000 条分页恢复 queued/status/approval/tool/plan/diff/subagent/final/terminal 语义状态。
- thread resume failure 显示显式恢复 UI；reset 需要确认上下文断裂。
- 老板驾驶舱展示多个员工授权，逐条撤权或恢复。
- 文件上传覆盖、新建文件/文件夹、删除和上下文 reset 使用应用内 dialog，避免原生 prompt/confirm 状态问题。

### 运维与协议

- `npm run check` 修正为遍历所有 `src/*.mjs`、`public/*.js` 和测试脚本。
- Codex 从 `0.148.0-alpha.9` 升级后，按官方规则将 config、生成 schema、fixture 与测试同步至 `0.150.0-alpha.8`。
- 协议不匹配使用机器可识别错误并阻止 ready。
- `/api/health` 增加 `codexState=starting|failed|ready`；启动脚本显示阶段并在明确失败时快速退出，不再无提示等待 60 秒。

## 数据与兼容性

- 迁移以幂等 `CREATE TABLE IF NOT EXISTS`、`ADD COLUMN`、索引迁移和受控 submission 表重建实现。
- 多员工授权落库后，旧代码可能重新创建单席索引；不能把直接启动旧二进制视为安全回滚。
- 生产修改前已留 SQLite 备份：`.data/backups/pre-p0p1-fix-20260904T174900Z/`。
- 当前生产库最终检查：`integrity_check=ok`，外键违规 0，active run 0，pending approval 0，active execution lease 0。

## 验证结果

### 自动门控

2026-09-05 宿主执行 `npm run gate`：

- 44 个单元、契约、前端静态、恢复、真实 Seatbelt、workspace/worktree 测试全部通过；
- 固定 HTTP E2E 报告 7 个 test records 全部通过；
- `git diff --check`、JavaScript syntax 和 Shell syntax 通过。

自动门控的详细行为映射见 [07 端到端发布契约](../architecture/07-e2e-release-contracts.md)。

### 正式服务与公网真实冒烟

- 正式 launchd 服务使用真实 `codex app-server 0.150.0-alpha.8` 启动，local/public health 均为 `codexState=ready`。
- 经 Cloudflare Quick Tunnel 分别完成老板和员工认证。
- 老板创建临时项目并授予一次性员工独立 worktree。
- 员工经公网创建/读取文件；真实 Codex 使用 `workspace_read_file` 读取并返回预期双标记。
- 清理文件/chat，撤权后员工访问返回 403，干净 worktree 移除，项目删除，测试员工停用。
- 管理员临时验证密码只以一次性内存值使用，原 password hash 已原样恢复；未输出任何凭据。

## 结论

原审计关于协作模型的核心判断正确：“项目是权限与共享事实边界，worktree 是写入隔离边界，chat 是私有 transcript，task/submission/handoff 是显式协作协议”。当前分支已闭环报告中的 P0/P1，并用固定门控和一次真实公网链路证明关键流程可用。

当前可以作为内部互信 Pilot 发布，但不能对外宣称敌对多租户、企业身份治理、任务级 merge/review 或任意 chat 互通已经完成。

## 遗留事项

- P2：OIDC/MFA、邀请、首次/自助改密、设备会话、持久限流。
- 敌对租户：per-user/per-tenant worker、独立 OS/Codex identity、硬磁盘 quota。
- 协作增强：versioned artifacts、handoff manifest、每任务 worktree 与 merge/review；必须按真实业务触发引入。
