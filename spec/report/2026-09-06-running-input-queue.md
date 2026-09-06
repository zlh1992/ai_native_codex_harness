# 2026-09-06 运行中输入、消息队列与调整方向

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 运行时保持输入和发送可用，排队消息支持编辑、取消、打断插队调整当前任务方向 |
| 影响范围 | UI、服务端调度、SQLite、HTTP、原生协议调用、测试与规格 |
| 架构规格 | [执行](../architecture/05-execution-concurrency-and-lifecycle.md)、[数据恢复](../architecture/06-persistence-events-and-recovery.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[领域模型](../architecture/03-domain-model-and-invariants.md) |

## 背景与证据

前端 setComposer 和 submit 会在当前 chat 运行时禁用输入/拒绝发送；runTurn 拒绝同 chat 的第二个 root。固定版本生成协议已提供 turn/steer 及 expectedTurnId 前置条件。当前工作树有其他已完成功能的未提交修改，本次在其基础上增量实施并保留。

## 目标与非目标

### 目标

- 运行期间保持输入框和发送按钮可用；消息持久排队并按 chat 顺序执行。
- 队列可编辑、取消；可用原生 steer 将选中消息送入当前 turn 调整方向。
- 刷新/断线恢复队列，停止/失败/重启后暂停待发消息，显式继续，避免意外重复运行。

### 非目标

- 不改变同 chat 单 root、项目 ACL、模式/沙箱与容量上限。
- 不升级 CLI，不开放任意 RPC，不实现跨 chat 消息注入。

## 约束与风险

- 遵循 FS-004、DAT-004/005/006、PRO-001/002、DEV-001 至 DEV-006。
- 编辑与自动出队竞态需版本前置条件；steer 必须绑定当前服务端 turn，不能落到下一轮。
- 队列正文按私有消息内容保护，不进入 journal/audit；请求结果不确定时暂停，不能自动重发。

## 实施计划

1. 新增幂等 SQLite 队列表、版本更新、恢复规则与生命周期占用。
2. 增加队列 HTTP API、串行调度和原生 steer；复验 access、用户、task 与运行模式。
3. 输入框持续可用，展示队列及编辑/取消/调整方向/继续操作，恢复自动启动轮次。
4. 增加行为及 HTTP 回归测试，更新架构，执行 macOS 完整 gate、diff 与 Markdown 链接检查。

## 实际改动

- `src/db.mjs`：增加 chat_inputs、revision 条件更新、幂等输入标识与容量限制使用的数据操作；queued/steering 纳入三层生命周期屏障；启动恢复暂停待发输入，保留不确定发送。
- `src/input-queue-service.mjs`：实现 FIFO 调度、编辑、取消、继续、steer 与用户/access/task 策略复查。正常发送与 run/用户消息在同一事务中落库；steer 绑定原运行，原 turn 提前完成时阻止下一条提前出队。
- `src/codex-service.mjs`：绑定队列生命周期、失败/停止暂停、steer fallback 与多 userMessage 去重；GET SSE 增加受 ACL 的实时非持久正文投递。并发复查排除当前 chat，修复 maxConcurrentTurns=1 时把自身计为额外占用的问题，这是保证串行队列正常工作的必要修正。
- `src/server.mjs`：新增队列 CRUD/steer/resume API、JSON 类型/大小、session/CSRF/chat/access 复查、脱敏 audit；旧 POST turns 保留但不能越过待处理输入。
- `public/app.js`、`public/index.html`、`public/styles.css`：运行中输入与发送可用、队列卡片和多行编辑、取消/调整方向/继续；所有工作台新输入统一入队，再恢复 run SSE。请求失败保留草稿并复用 id，恢复请求失败不会留下无法重试的占位状态。
- `test/input-queue.test.mjs`、frontend/protocol 测试与固定 HTTP E2E：新增队列状态机、单并发、旧 revision、重启、steer 完成竞态、不确定发送和正文脱敏验证；fake Codex 实现 expectedTurnId 的 steer 流程。
- 同步 architecture 01/03/05/06/07/08 与报告索引。未修改精确 CLI pin，未删除或弱化已有发布契约。
- 工作树中的老板模型选择属于并行的既有修改，本报告只记录输入队列范围，增量修改保留其他工作。

## 数据、接口与安全影响

- 数据迁移：新增私有 chat 输入队列表与索引，使用 CREATE TABLE/INDEX IF NOT EXISTS；重复 migrate、新连接重开、仅服务启动恢复均已验证。已发送/取消行清空正文但保留幂等标识。
- API/协议：新增 GET/POST queue、PATCH/DELETE queue/:id、POST queue/:id/steer|resume。写操作要求 revision；steer 另需 expectedRunId。不确定发送恢复须 acknowledgeUncertain=true；不自动重发。使用既有固定版本 turn/steer，expectedTurnId/clientUserMessageId/response turnId 受检。
- 权限与秘密：沿用有效 user/access/task 校验，事件和审计不记录正文。
- 回滚：先停止并排空运行、暂停队列后恢复本次代码；保留新表与未发内容，不回滚其他工作树修改。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git diff --check` | 通过 | 无空白错误 |
| `npm run gate > /tmp/codex-input-queue-gate.log 2>&1` | 通过 | 最终代码退出 0；75 项单元/集成、15 个 HTTP E2E 测试节点全部通过，0 失败、0 跳过；macOS Seatbelt 实测包含在 gate 内 |
| `node --test test/input-queue.test.mjs test/frontend.test.mjs` | 通过 | 19 项通过，包括当前队列 7 个状态机/恢复用例和前端输入/幂等测试 |
| `npm run test:e2e > /tmp/codex-input-queue-e2e.log 2>&1` | 通过 | 固定 gate 与新增队列 HTTP 场景通过；脱敏断言针对 events journal，受 ACL 的 latestTurnRun 业务快照不视为 journal |
| `python3 /tmp/check-queue-markdown-links.py` | 通过 | 扫描 README、docs 和 spec 的相对 Markdown 文件链接，29 文件、83 链接、0 无效 |
| `uname -s`、`node --version` | 通过 | Darwin / Node v25.6.0，支持 loopback 与实际 Seatbelt |
| 浏览器 UI 操作 | 通过 | 隔离 fake Codex：运行时输入/发送、编辑保存、steer 后原任务继续、取消、刷新重入恢复队列、停止保留、继续后完成；窄屏布局与亮色发送按钮经截图检查 |

## 清理

HTTP E2E 与单元测试使用隔离临时数据；浏览器验证使用单独临时数据库、workspace 和 fake app-server，不访问生产账号、生产项目或真实上游。浏览器验证结束时 SQLite integrity=ok、foreign key violations=0，active runs、pending inputs、pending approvals、leases 均为 0；临时浏览器已关闭，验证 Portal 已停止，临时 UI 数据目录已清理。报告、源码和日志中未保存真实凭据或生产正文。

## 结论

本次目标已实现，完整 macOS gate 通过；运行中输入、持久 FIFO、编辑/取消、原生当前 turn steer 和暂停/恢复契约成立。正式服务进程需加载新后端后与新前端配套生效；本次只完成仓库实施及隔离验证，没有重启正式 Portal，也没有把 fake Codex 验证描述为真实上游冒烟。

## 遗留事项

- 无本次功能实现遗留；正式服务重启和真实 Codex 上游冒烟属于后续发布操作。
