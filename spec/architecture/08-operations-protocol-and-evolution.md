# 08 运维、协议升级与演进

## 本地生命周期

项目根目录 start/stop/restart/status/health/reset-wechat-qr.command 统一管理 Portal、公网隧道及同级 wx_codex_self 微信服务（可由 WECHAT_BRIDGE_DIR 指定）。启动依次检查本地引擎、公网健康、微信运行/待扫码；关闭按相反顺序执行。reset-wechat-qr 先确保整套服务就绪，再备份旧微信绑定并打开新二维码。

HARNESS_PROCESS_MODE 默认为 launchd；可显式选 detached 处理 Documents 后台访问受限。两种模式共用 start/stop/status 和健康判断。detached 状态记录放在私有 DATA_DIR，操作用文件锁串行化，并复验 UID、PID 的启动时间与完整命令，PID 被复用时拒绝停止。退出启动终端不结束服务，注销/重启系统后须重新执行 start.command。

```bash
./bin/start-local.sh
./bin/start-tunnel.sh
./bin/status.sh
./bin/stop-tunnel.sh
./bin/stop-local.sh
```

默认 `start-local.sh` 只有在 HTTP 与 Codex app-server ready 后返回成功，Codex ready 仍须验证原生记忆三项关闭。显式启用本机 Qwen 时，HTTP + localQwen.ready 也可启动部分能力，普通 Codex 是否可用仍单独显示；不得把本地 ready 当作普通模型可用。`status.sh` 显示两个引擎状态。本地配置、真实模型验收及安全回滚见 [操作指南](../../docs/LOCAL_PRIVATE_PROJECTS.md)。

首次安装由 `install-mac.sh` 使用 `package-lock.json` 执行 `npm ci --omit=dev --ignore-scripts`，不能依赖被 Git 忽略的既有 `node_modules`。首次启动必须在读取日志行号前创建权限为 `0600` 的服务日志。

看板拖拽使用固定版本的生产依赖 SortableJS，经 `/vendor/sortable.js` 单一路径提供；不依赖外部 CDN，不开放整个 node_modules。组件未安装返回 404，前端保留键盘排序和卡片详情作为降级。测试专用 DOM 库不进入生产安装。规范页面为 `/boss/login`、`/boss/workbench`、`/boss`、`/employee`；末尾斜杠重定向到规范路径，未知无扩展路径不再兜底员工页。

Portal 启动时冻结 public HTML/JS/CSS 与固定 Sortable 模块的内存快照，按全包内容生成 `/assets/<hash>/...` 版本路径。HTML 使用 no-store 并指向同一版本；ESM 相对依赖及 Sortable 动态导入保持版本一致。版本资源可长期 immutable 缓存，未知旧版本或非白名单资源返回 404，不能把新字节伪装为旧版本。发布前端改动也需安全重启 Portal；不能依赖 CDN 保留源站 cache-control、操作员手动清缓存或原文件名重新请求。未版本化的开发/兼容路径保留，不开放其他 node_modules 文件。

普通项目和微信固定渠道的上游固定为本机 ChatGPT 官方 Codex 登录（`openai_http`，`https://chatgpt.com/backend-api/codex`）；运行配置和启动脚本必须拒绝第三方 provider/endpoint。`local_private` 才能在显式开启且服务可用时使用回环 Qwen OpenAI-compatible 服务，普通项目与微信不会 fallback 到它。配置统一使用 `LOCAL_QWEN_*`。

安装脚本同时建立 Python 3.10+ 的 `.tools/memory-venv`，安装固定的 `memsearch[onnx]==0.4.19`，默认预热固定 revision 的 `gpahal/bge-m3-onnx-int8`。可用 `MEMORY_MODEL_WARMUP=0` 跳过预热；索引进程不可用不会打开 Codex 原生记忆，而是显示 degraded 并退回 SQLite 关键词召回。

健康响应的稳定字段：

```json
{
  "ok": true,
  "codex": true,
  "codexState": "ready",
  "initialized": true
}
```

`ok` 只表示 Portal HTTP 可响应；默认发布/隧道前置条件检查 codex=true。显式启用本地引擎时允许 localQwen.enabled && state=ready 作为部分服务条件，但完整业务验收必须测试将使用的实际引擎。

Codex initialize/ready 不证明上游模型认证可用。使用本机 ChatGPT 登录时，模型请求地址应与该认证方式匹配；恢复默认官方地址后必须执行真实模型请求验证。模型 401 不属于微信扫码故障，不应通过重置微信绑定处理。

`/api/me` 和 health 的 memory 状态用于诊断索引进程启动/降级，不等于每用户向量就绪；`nativeCodexMemory` 必须始终为 `false`。`PORTAL_MEMORY_ENABLED=false` 只停用 Portal 记忆 CRUD，不能解除 Codex 原生记忆关闭不变量。四个 memory 动态工具在 thread start/resume 注册，升级应排空运行后重启 Portal；已取消关键词提取及其配置，不重放历史提取任务。

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
- 记忆诊断只记录状态、job error code、memory id/version 和引用数量，不打印正文或 query；`.data/memory-index` 可停服后删除并从 SQLite 重建。

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

微信渠道运维：设置 `WECHAT_CHANNEL_ENABLED=true`、老板 standard `weichat-project` 的 `WECHAT_CHANNEL_PROJECT_ID`，并把 32 字节以上的 secret 保存到 `WECHAT_CHANNEL_SECRET_FILE`（权限 `0600`）。微信桥接只运行 transport relay，调用 `POST /api/internal/channels/wechat/events`；该接口仅接受 loopback、HMAC、时间窗和 nonce。macOS launchd 的 relay 密钥应放在 Application Support 的私有运行目录（0600），避免依赖 Documents 访问权限；若 Portal 和 relay 分别保存副本，轮换须同步更新。固定项目删除或撤权时，渠道请求必须 fail closed。每个微信私聊在固定项目内拥有独立 chat，所有消息和运行记录由 Portal SQLite 保存；新建 active binding chat 在 thread/start 时注册老板 standard 项目只读工具，不需要把其他 project id 写入桥接配置。既有原生 thread 的动态工具不能假设经 resume 更新；Portal 以 chat 的 `channel_tools_version` 做一次性迁移，创建新 thread、记录旧/新 lineage 后才继续微信 turn；旧历史保留为事实，不注入新 thread。升级须验证实际工具集合，不能仅以新建测试会话成功作为旧微信会话验收。

微信消息中的 `/new`、`/models` 和 `/model <id>` 由 Portal 事件入口处理，relay 不实现这些业务语义。`/new` 要求当前 chat 无运行、恢复或排队输入，在 SQLite 事务中创建新 chat 并更新 active binding；旧 chat 保留且下一条普通消息才启动新 thread。`/models` 展示 Portal 白名单而不是让上游模型自行猜测；`/model <id>` 仅修改当前 chat 的 nullable 偏好，非法模型或忙碌 chat 拒绝。模型目录显示资格不等于当前上游账号必然可用，实际 turn 仍以 Codex 上游能力为准。

固定双域名部署可以设置 `BOSS_PUBLIC_ORIGIN` 与 `EMPLOYEE_PUBLIC_ORIGIN`，自动纳入 Host 白名单；`PUBLIC_ORIGINS` 可补充其他固定 HTTPS origin，旧 `PUBLIC_ORIGIN` 保留单域名兼容。两个 hostname 映射同一 Portal，根路径按角色跳转，Cookie 不共享到父域名。named PUBLIC_URL 必须属于已配置 origin；运行中模式/主域名不一致则拒绝伪报成功并保留旧隧道。健康检查覆盖主域名及两个角色域名，使用本章引擎 ready 条件，不能只检查 HTTP 200；仅本地 ready 时员工 Codex 任务仍不可用。

若 App 自动更新替换内置二进制，可使用独立安装的官方同版本 CLI 并通过 `CODEX_BIN` 绑定；这不改变协议 pin。重启前应核对实际二进制版本，运行中的旧进程 ready 不能证明磁盘上的新二进制兼容。

输入队列 API：`GET/POST /api/chats/:chatId/queue`，`PATCH/DELETE /api/chats/:chatId/queue/:inputId`，`POST .../:inputId/steer|resume`。POST 新输入携带幂等 `id`、`prompt`、`mode`、`effort`；后续修改携带 `revision`，steer 额外携带 `expectedRunId`，不确定发送的 resume 额外要求 `acknowledgeUncertain=true`。既有 POST turns SSE 保持可用，但存在待处理输入时拒绝绕过 FIFO。协议升级检查增加 `turn/steer` 的 expectedTurnId、clientUserMessageId 与 response turnId；本次不改变精确 CLI pin。

队列上线后，降级前应停止并排空全部运行、暂停所有输入并备份 SQLite；保留新表及未发正文，旧代码不会消费这些输入。重启不自动续发待处理消息，用户在队列中继续或取消。

## 工作图运行

工作图仍使用精确 CLI pin，无原生协议升级。通过独立开关控制创建入口、后台派发和自动应用审核；降级不得直接使用不认识 manual 提交的旧版本。 详细契约见 [多人 Work Graph](09-human-work-graph.md)，操作见 [工作图指南](../../docs/WORK_GRAPH.md)。

## 模型偏好与用量运维

/api/me 返回同一 GPT 模型目录及角色默认强度；模型目录只列 Codex 客户端标记为可见的根模型，不含隐藏/内部模型，更新目录须同步修改白名单契约；PATCH chat 支持 preferredModel/preferredEffort（null 恢复默认）。GET /api/admin/token-usage 使用 from/to（北京时间 YYYY-MM-DD，包含终止日）、userId、engine（gpt/qwen）、model 筛选，缺省近 7 天；返回 totals/days/employees/models/kinds、startedAt、updatedAt 与本地引擎状态。前端可见时每 30 秒刷新，支持手动刷新；统计为本网站调用上报量，不是共享账号账单或费用。

发布先排空运行并一致性备份 SQLite；新增账本不删除既有数据。回退本次代码可以保留 nullable 列与计量表，但回退期间不会继续采集，统计完整性须注明该空窗；不能回退到不支持隐私项目的版本。本地 Qwen disabled 与未上报用量分别显示，真实本机推理未验收前不因看板上线而启用模型。
