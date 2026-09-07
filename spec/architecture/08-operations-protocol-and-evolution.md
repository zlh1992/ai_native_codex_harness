# 08 运维、协议升级与演进

## 本地生命周期

```bash
./bin/start-local.sh
./bin/start-tunnel.sh
./bin/status.sh
./bin/stop-tunnel.sh
./bin/stop-local.sh
```

`start-local.sh` 只有在 Portal HTTP 与 Codex app-server 都 ready 后才写受管 PID 并返回成功。HTTP 先启动时会显示“等待 Codex”；明确失败时立即打印本次启动日志并退出。`status.sh` 区分 Web 未就绪、Codex 正在启动、Codex 失败和完整运行。

首次安装由 `install-mac.sh` 使用 `package-lock.json` 执行 `npm ci --omit=dev --ignore-scripts`，不能依赖被 Git 忽略的既有 `node_modules`。首次启动必须在读取日志行号前创建权限为 `0600` 的服务日志。

健康响应的稳定字段：

```json
{
  "ok": true,
  "codex": true,
  "codexState": "ready",
  "initialized": true
}
```

`ok` 只表示 Portal HTTP 可响应；发布与隧道前置条件必须检查 `codex=true`。

## Codex 协议升级流程

当前 pin：`codex-cli 0.150.0-alpha.8`。

1. 读取目标二进制版本：`codex --version`。
2. 生成到临时目录，并与 `protocol/generated/` 对比删除、变化和新增类型。
3. 核对 Portal 使用的 `thread/start|resume|fork|read|goal`、`skills/*`、`turn/start|interrupt`、approval、tool call、turn/item/thread notification 和 collab item。
4. 用目标二进制执行：

   ```bash
   codex app-server generate-ts --out protocol/generated
   ```

5. 同步更新 `src/config.mjs`、`protocol/version.json`、fake app-server、协议测试和架构/实施报告。
6. 运行协议失配负向测试与 `npm run gate`。
7. 重启正式服务，确认 `codexState=ready`。
8. 用隔离临时用户/项目进行真实 Codex 冒烟，随后清理并做数据库完整性检查。

官方 schema 生成物与运行 CLI 版本一一对应，因此当前选择精确 pin。未来可以增加“已验证版本矩阵 + 能力协商”，但不能仅按 major/minor 放行。

## 发布检查表

- 当前变更报告的计划、实际改动、验证、结论与遗留项已经填写。
- 架构或契约变化已同步到 `spec/architecture/`。
- `git diff --check` 通过，无秘密或绝对凭据进入 diff。
- `npm run gate` 在符合条件的 macOS 宿主通过。
- 数据库迁移在新库和旧库快照上均幂等。
- 正式服务重启后 health 为 ready，日志没有协议或 migration 错误。
- 公网发布时 Origin、Secure Cookie、可信代理和隧道模式与环境一致。
- 对生产数据进行的临时验证已经撤权、停用和清理，并确认无 active runtime 残留。

## 备份与回滚

- schema 或 ACL 变更前先使用 SQLite backup API，或在停服后复制 DB/WAL/SHM 和相关 tree。
- 回滚计划必须说明新数据能否被旧代码理解。多员工 access、submission retention 和 thread recovery 等迁移不能假设旧二进制安全。
- 协议升级失败时可以恢复原二进制与同版本生成 schema，但不能在当前 ChatGPT App 已替换内置 Codex 二进制后只修改版本字符串伪装兼容。
- 脏 worktree、submission 和 thread lineage 是证据，回滚不得删除。

## 可观测性

- 服务日志位于 `~/Library/Logs/CodexHarnessRemote/`，本地脚本只显示本次启动片段。
- `/api/health` 不返回内部路径或完整 Codex 错误，只返回状态。
- 管理 audit 记录 actor、动作、资源和脱敏 detail；运行过程由 turn event journal 提供 cursor。
- 诊断数据库前先检查 integrity、foreign keys、非终态 run、pending approval、有效 lease 和孤儿 submitted task。

## 演进触发条件

| 触发条件 | 应引入的能力 |
| --- | --- |
| 并发任务需要独立基线、避免同文件冲突或更完整审核 | execution environment 实体、每 task/chat worktree、基线同步、冲突解决与 PR；保留现有 submission/delivery SHA 证据 |
| 多人需要跨 chat 共享稳定结论 | versioned artifact、decision、handoff manifest、来源/hash/ACL |
| 需要定向跨 chat 消息 | Portal broker、send/receive ACL、idempotency key、审计；禁止裸 inject |
| 多组织或恶意租户 | organization membership、per-tenant worker、独立 OS/Codex identity、磁盘 quota |
| 企业账号治理 | 邀请、OIDC/MFA、首次改密、自助改密、设备会话、持久限流 |

架构演进必须从明确业务触发条件出发，不以“协议已经支持某方法”为启用理由。

本地与公网地址输出分别展示 `/boss/login` 与 `/employee`。固定 `PUBLIC_ORIGIN` 仍是无路径的同一 origin；两个角色共用后端、同源 Cookie 与隧道，但登录 API、登录页面和首页分开。

若 App 自动更新替换内置二进制，可使用独立安装的官方同版本 CLI 并通过 `CODEX_BIN` 绑定；这不改变协议 pin。重启前应核对实际二进制版本，运行中的旧进程 ready 不能证明磁盘上的新二进制兼容。

输入队列 API：`GET/POST /api/chats/:chatId/queue`，`PATCH/DELETE /api/chats/:chatId/queue/:inputId`，`POST .../:inputId/steer|resume`。POST 新输入携带幂等 `id`、`prompt`、`mode`、`effort`；后续修改携带 `revision`，steer 额外携带 `expectedRunId`，不确定发送的 resume 额外要求 `acknowledgeUncertain=true`。既有 POST turns SSE 保持可用，但存在待处理输入时拒绝绕过 FIFO。协议升级检查增加 `turn/steer` 的 expectedTurnId、clientUserMessageId 与 response turnId；本次不改变精确 CLI pin。

队列上线后，降级前应停止并排空全部运行、暂停所有输入并备份 SQLite；保留新表及未发正文，旧代码不会消费这些输入。重启不自动续发待处理消息，用户在队列中继续或取消。

## 工作图运行

工作图仍使用精确 CLI pin，无原生协议升级。通过独立开关控制创建入口、后台派发和自动应用审核；降级不得直接使用不认识 manual 提交的旧版本。 详细契约见 [多人 Work Graph](09-human-work-graph.md)，操作见 [工作图指南](../../docs/WORK_GRAPH.md)。
