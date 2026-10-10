# 2026-09-24 微信渠道接入老板固定项目

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中（最小修复已验证；完整 gate 仍阻塞） |
| 日期 | 2026-09-26 |
| 负责人 | Codex |
| 关联目标 | 微信扫码绑定后，消息固定落入老板 `weichat-project`；该入口可只读发现老板本人拥有的全部 standard 项目，同时隔离员工项目、本机未纳管目录和 local_private 项目 |
| 影响范围 | Portal API、SQLite、微信桥接、认证、运维、架构、测试、二维码登录 |
| 架构规格 | [01 系统上下文与组件](../architecture/01-system-context-and-components.md)、[03 领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[04 安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[06 持久化与恢复](../architecture/06-persistence-events-and-recovery.md)、[07 发布契约](../architecture/07-e2e-release-contracts.md)、[08 运维与协议演进](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

现有微信桥接已能扫码绑定并收发消息，但它启动独立 Codex App Server，默认工作目录是 `wx_codex_self`，并支持通过 `/new` 切换绝对路径。该链路绕过 `codex-harness-remote` 的项目 ACL、SQLite 对话记录、Seatbelt 与老板工作台。当前 Harness 数据库尚未创建 `weichat-project`。

## 目标与非目标

### 目标

- 增加仅监听回环地址的微信渠道入口，复用 Portal 的 `CodexService`、项目 ACL、运行状态和消息持久化。
- 将微信通道固定绑定到老板用户、老板所有的标准项目 `weichat-project`。
- 每个微信私聊映射为该项目中的独立 chat；从该 chat 提供老板本人所拥有 standard 项目的服务端枚举、只读目录、文件读取和文本搜索。
- 禁止群聊、客户端项目切换、任意 cwd、本机 Codex 任务列表、员工自有/共享项目和 local_private 项目。
- 使用 HMAC、时间窗、nonce 和事件 ID 去重，避免把老板浏览器 session 或密码交给桥接。
- 重新生成二维码，并让桥接只承担微信 transport 与 Portal relay。

### 非目标

- 不实现微信员工入口、微信群协作、跨项目写入或跨项目命令执行。
- 不把微信绑定到 `local_private` 项目。
- 不复用桌面 Codex 当前任务，不暴露原始 App Server RPC。
- 本次不承诺媒体附件、语音转写和微信侧完整审批交互。

## 约束与风险

- 遵守 `PRD-001`、`PRD-003`、`RUN-002`、`RUN-003`、`FS-001`、`DAT-004`、`DAT-006`、`DEV-002`。
- 渠道入口必须固定服务端 hub 项目和 access，客户端不能提交 owner、project、chat、cwd 或 thread；跨项目只读工具中的 target project id 由模型选择后仍须由 Portal 复验为当前老板本人拥有的 active standard owner access。
- HMAC secret 只保存在本机权限为 0600 的 secret 文件；日志不得记录 prompt、token 或完整回复。
- 微信轮询游标只有在 Portal 接收并完成事件登记后提交；Portal 重启后依赖 SQLite 事件记录去重。
- 现有微信绑定被清除后需要重新扫码；旧桥接运行中的本地独立 Codex 会话不迁移。

## 实施计划

1. 扩展 Portal 配置和 SQLite，增加固定微信 channel binding / event 记录。
2. 增加回环 HMAC 微信事件入口，固定解析老板和 `weichat-project`，调用现有 `CodexService.runTurn`。
3. 改造微信控制器，移除独立 Codex 运行，改为轮询微信并调用 Portal relay。
4. 更新架构文档、操作文档、报告索引和测试。
5. 为微信 hub chat 增加老板项目只读发现工具并覆盖 owner/employee/local_private 隔离测试。
6. 清理旧二维码绑定并重新生成二维码，验证状态、去重、跨项目只读和老板工作台可见性。
7. 将 relay 的现有共享密钥复制至 Application Support 私有运行目录，保持原密钥字节不变，避免 launchd 读取 Documents 的权限依赖；原 EPERM 的具体来源尚未证实，扫码后仍须验证。

## 实际改动

- `src/config.mjs` 增加微信渠道开关、固定项目、发送者和 secret 文件配置；`.env` 仅在本机把上游 Codex 地址切换到当前登录配置使用的 HTTPS endpoint，未写入报告或源码凭据。
- `src/db.mjs` 增加幂等的 `channel_bindings` 与 `channel_events` 表、索引和访问方法。重复 binding/event 使用 `INSERT OR IGNORE`，保留原 chat/event 事实；撤销 binding 会 fail closed。
- `src/server.mjs` 增加仅 loopback 的 HMAC 事件入口：校验时间窗、nonce、签名、发送者和私聊类型；服务端固定活动老板及 `weichat-project`，每个微信 scope 映射一个老板 chat，完成/失败结果写回 SQLite。
- `tools/wechat-codex/bridge-harness.mjs` 将上游微信插件限制为 transport relay，只轮询私聊、提交签名事件并回传 Portal 文本；不再由 relay 接收项目目录、thread 或启动独立 Codex。
- `tools/wechat-codex/control.mjs`、安装脚本、配置示例和运维文档改为 relay 配置；此前绑定曾确认；2026-09-26 按用户要求再次清除绑定并生成新二维码，当前为 `waiting_for_wechat_scan`，尚未确认新的微信收发。目标项目为 `weichat-project`。
- `bin/_common.sh`、`bin/status.sh`、`bin/start-tunnel.sh` 和 `bin/start-local.sh` 统一使用 ChatGPT App 内置 Node，修复当前终端无 `node` 时的健康检查误报。
- `test/channel.test.mjs` 覆盖 binding/event 重复登记和终态回放；架构文档补充渠道实体、持久化和 E2E-018 契约。

## 数据、接口与安全影响

- 数据迁移：新增幂等的微信 channel binding 与事件去重表，不修改既有项目/chat 数据。
- API/协议：新增仅回环可用的 HMAC 事件接口；浏览器 API 保持兼容。
- 权限与秘密：微信 transport 不再持有 Codex 登录执行权；Portal 服务端固定老板用户和项目 ACL。
- 回滚：停止微信 LaunchAgent，恢复旧控制器和旧配置即可；新增事件表可保留，旧版本忽略。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/channel.test.mjs test/config.test.mjs` | 通过 | 2/2 tests passed |
| `git diff --check` | 通过 | 主仓库无空白错误 |
| `git -C ../wx_codex_self diff --check` | 通过 | relay 仓库无空白错误 |
| `bash bin/stop-local.sh; bash bin/start-local.sh` | 受宿主环境阻塞 | 前台/脱离终端 daemon 启动后 health 为 `codexState=ready`；launchd 从 `Documents` 启动未在脚本窗口内就绪 |
| `curl http://127.0.0.1:4310/api/health` | 通过 | `ok=true`、Codex ready、memory index ready、native Codex memory false |
| `bash bin/status.sh` | 脚本通过/当前状态受限 | Node 解析修复已验证；当前 daemon 未由 launchd 纳管，因此脚本如实显示本地服务未启动，named tunnel 与地址仍可见 |
| 公网 `workbench3.winy.cc` / `workbench4.winy.cc` | 通过 | 两个 `/api/health`、老板登录页和员工入口均返回 HTTP 200 |
| 真实 HMAC 微信事件 | 通过 | 返回 `WECHAT_CHANNEL_OK`，SQLite 写入老板固定 chat |
| 同一 event id 重复投递 | 通过 | 第二次返回 `duplicate=true`，未新增 turn，返回原结果 `CHANNEL_DEDUPE_OK` |
| 错误签名 / 群聊请求 | 通过 | 分别返回 `401 CHANNEL_AUTH_INVALID` 与 `403 CHANNEL_GROUP_DISABLED` |
| `control.mjs status` | 历史通过，重新绑定待验收 | 上一次绑定正常；本次重新生成二维码后尚待用户扫码 |
| `npm run gate` | 未通过 | 2026-09-26 已可运行：153 项中 144 通过、9 失败；7 个文件缺少 linkedom，另有 EXTRACTION_FAILED 和 LOCAL_SEARCH_UNAVAILABLE，未进入 E2E 阶段 |

初次真实事件曾因本机 Portal 使用 `chatgpt.com/backend-api/codex` 而收到 401 `api_key_not_supported`；已按当前 Codex 登录配置切换本机 `.env` endpoint，重启后真实 turn 成功。该运行时修复未把 API key 或响应凭据写入仓库。

## 结论

老板 standard 项目只读入口已实现并通过真实 Portal 工具调用验证；二维码已重新生成。微信重新绑定和完整收发仍待扫码验收，完整 gate 未通过，因此不能宣称发布验收完成。

## 清理、回滚与遗留事项

- 本次真实验证使用固定合成消息文本和 `wechat-smoke-scope`/`channel-*` 测试事件；未保存 secret、Cookie 或完整敏感载荷。测试记录保留在本机 SQLite 作为可审计证据，未创建员工授权或新项目。
- 回滚：停止当前 Portal daemon 和 `local.wechat-codex` LaunchAgent 并恢复旧 relay 代码；保留新增 SQLite 表和事件记录，旧版本可忽略这些表。若撤销绑定，设置 binding 为 revoked 后渠道请求 fail closed。
- 遗留：微信媒体、语音、审批按钮、stale `processing` 事件的人工恢复和跨联系人共享上下文需要后续单独验收。

## 2026-09-26 扩展验证与运行状态

- 新增 `src/wechat-owner-project-tools.mjs` 的列表、目录、文件读取、文本搜索四个只读工具；`src/codex-service.mjs` 仅为 active 微信 binding chat 注册并分发；`src/db.mjs` 增加 binding 查询。
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/channel.test.mjs test/config.test.mjs test/http-utils.test.mjs`：6 项通过；覆盖老板 standard、员工/shared、local_private 列表隔离和普通 chat 无工具。
- 本机真实 DB + WorkspaceService 验证：4 个工具，列出 2 个符合条件的项目，与授权查询一致，目录读取成功。
- 合成 HMAC 事件：HTTP 200、completed，审计确认实际调用 `owner_projects_list`；不记录项目正文或完整回复。
- 旧 relay 曾报告 EPERM；尚不能确认唯一原因。运行时将相同共享密钥迁至 Application Support 私有目录，权限 0600；Portal 原密钥文件保留，未轮换密钥。回滚可将 relay 配置恢复原路径，密钥轮换时须同步两份文件。
- 新二维码由本机设置页动态展示；当前等待扫码。合成 scope 记录保留在本机数据库用于审计。

## 2026-09-26 微信无回复排查与修复计划

- 实际消息在 12:43:03（北京时间）进入 Portal，12:48:29 完成，12:48:34 relay 确认回复发送成功。处理期间没有进度回复。
- 首次 relay 请求在约 300 秒后失败，随后重复事件返回 processing，三次重试耗尽使 relay 重启。300 秒与 Node fetch 的默认响应头超时一致；现有 AbortSignal 的 20 分钟并未避免这次断连。
- 计划：使用仅 loopback 的原生 HTTP transport 明确管理 20 分钟请求超时；processing 作为可等待状态，在总期限内间隔重试，保留事件 ID 幂等和完成后才提交微信 cursor。日志仅保留错误码。新增本机 HTTP fixture 验证响应解析、超时和错误码，不发送测试微信消息。

## 2026-09-26 实际微信会话逻辑复核

- 用户截图及 relay 完成日志确认文字收发成功；不能把运行状态 running 等同于低延迟或项目工具验收。
- 新合成测试 thread 的 session metadata 包含 4 个 owner 工具；两个既有 channel thread 只有 12 个原有工具，未包含 owner 工具。此前“真实工具已验证”只证明新会话，不证明实际旧微信会话；当前跨项目目标尚未完整达成。thread/resume 的已生成协议没有 dynamicTools 字段，不能依赖其注入新工具。保留旧 thread/history，尚未执行会导致历史断裂的 reset。
- relay 串行 await 每条完整 turn，前一条慢会阻塞后续消息；无进度回执。尚未增加并发或降低模型推理强度。
- cursor 只在批次全部回复后提交：Portal 事件可避免模型重复执行，但若部分微信回复已发送、随后进程退出，重放该批次仍可能重复发送微信回复；尚无逐条持久投递账本。
- Portal 中 processing 与 turn 生命周期缺少完整恢复关联；重启导致 turn interrupted 时，channel event 可能仍 processing。此次不猜测并改写历史事件，恢复机制待补。
- 新增 relay portal-http.mjs：仅 loopback HTTP、显式 20 分钟总超时、4 MiB 响应上限；processing 在期限内等待，不消耗普通失败次数；部署前确认无 processing 事件，已复制运行文件并重启 relay，绑定保留。
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test ../wx_codex_self/tools/wechat-codex/portal-http.test.mjs`：3/3 通过（409 结构、无响应头超时、拒绝非回环与 URL 凭据）。两个修改模块 node --check 通过。未主动向微信发送测试消息。
- 剩余验收：processing 恢复、逐条回复投递语义与完整发布 gate；旧微信会话工具迁移已完成并验证。

本轮复跑 `npm run gate`：ℹ tests 153；ℹ pass 144；ℹ fail 9；ℹ duration_ms 13873.482917。仍未通过，E2E 阶段未执行。`git diff --check`（两仓库）及架构/报告相对 Markdown 链接检查通过。


## 2026-09-26 最小修复：旧微信 thread 工具迁移

- 根因：当前生成的 `thread/resume` 参数没有 `dynamicTools`，旧微信原生 thread 无法在 resume 时获得新增的老板项目工具。
- 实现：`chats.channel_tools_version` 幂等迁移；active 微信 binding chat 在下一次 turn 前若版本低于 1，则只创建一次新 thread，调用现有 `recoverChatThread` 记录旧/新 lineage，再标记版本 1。普通 chat 和非微信 chat 不变。
- 约束：不删除旧 Codex transcript，不把旧历史伪装成新 thread 上下文；微信项目 ACL 仍由每次工具调用复验。


## 2026-09-26 最小修复验证结果

- 在 Portal 重启后，当前微信绑定 chat 的 `channel_tools_version` 从 0 迁移到 1；旧 thread `01a0d3f8…` 与新 thread `01a0dd2c…` 已写入 `chat_thread_recoveries`，旧 transcript 保留。
- 合成内部事件返回 completed；turn event 审计确认实际调用 `owner_projects_list`，当前新 thread session metadata 包含 `owner_projects_list`、`owner_project_list`、`owner_project_read_file`、`owner_project_search` 四个工具。
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --test test/channel.test.mjs test/config.test.mjs test/http-utils.test.mjs`：6/6 通过；`git diff --check` 通过。
- 该验证使用已绑定微信 scope 的本机合成事件，不向微信发送额外测试消息；未修改项目文件。

## 结论更新

当前微信会话已经可以使用老板本人拥有的 standard 项目只读工具；员工项目、shared-only、local_private 和未纳管目录仍由 Portal ACL 排除。完整发布门控仍未通过，原因见上方 `npm run gate` 记录。
