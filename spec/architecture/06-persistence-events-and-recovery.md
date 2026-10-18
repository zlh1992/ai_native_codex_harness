# 06 持久化、事件与恢复

交互浏览器只把 browser_state 元数据写入既有事件，刷新查询当前会话，重启后显示 closed；不恢复 Cookie/profile，也不写工具明细或云端摘要。见 [浏览器生命周期](11-managed-browser.md)。

隐私项目增加 DSH JSONL 与 local_session_id（不向浏览器公开），使用独立 user/project/chat 容器；记录正文仅可经 chat ACL 读取，不进入全局 journal/日志。空白会话须先物化，恢复失败保留映射，显式 reset 记录`engine=qwen` 的 lineage；重启不重放遗留 inbox 或审批。详见 [第 10 章](10-local-private-projects.md)，备份不能只复制 SQLite 而遗漏本地 session。

## 三类事实源

| 数据 | 事实源 | 用途 |
| --- | --- | --- |
| 用户、ACL、项目、task、run、approval、lease、submission、审计 | SQLite | 业务授权与状态机 |
| 用户记忆、来源、版本、提取任务、每轮引用与分享确认 | SQLite | 长期记忆的权威正文、可见性和失效证据 |
| 完整原生 transcript、thread/turn/item | Codex `CODEX_HOME` | 高保真对话历史与原生恢复 |
| 项目文件与 Git 状态 | 主目录/worktree | 共享事实和交付内容 |
| per-user Markdown/Milvus Lite/embedding | `.data/memory-index` 与模型缓存 | 可删除重建的召回加速层 |

Portal 不把 Codex thread 当唯一业务事实，也不复制完整 transcript 到审计表。`messages` 和 `turn_events` 是在原生历史暂时不可用时维持基本可见性和运行恢复的受限投影。

微信 relay 的外部事件先写入 SQLite `channel_events` 唯一键 `(channel, external_event_id)`，再启动 Portal turn。重试命中 `completed` 或 `failed` 只返回已保存的短回复，不重复执行；并发命中 `processing` 返回明确冲突，桥接保留游标，在单次 20 分钟总期限内间隔重试 processing，不将它计入普通网络失败次数。relay 使用仅 loopback 的 HTTP 请求和显式总超时，等待完整 turn 不依赖 fetch 默认响应头超时。事件只记录 scope、状态、错误码和回复结果，不记录 token、完整 prompt 或原始微信载荷。

Portal 也不读取或写入 Codex 原生长期记忆；该能力对 Portal app-server 强制关闭。用户记忆从 SQLite 投影为每用户独立文档和数据库，memsearch 超时或崩溃时退回 SQLite 关键词召回。无论使用哪种召回器，最终候选都重新查询 SQLite 并验证来源 access。

## Turn event journal

`turn_events.id` 是全局单调递增 cursor。事件写入顺序遵循“先持久化，后投递 SSE”。持久化事件包括：

- queued 与 status；
- approval required/resolved；项目内自动接受通常只产生带 `automatic=true` 的 resolved 事件；
- tool started/completed；
- plan 更新、diff 是否存在及字节数；
- subagent/native item 的脱敏状态；
- goal/usage/security warning；
- final item、completed、failed/interrupted。

逐 token assistant/reasoning、命令输出、原始 diff、工具参数和文件正文只记录字节数或省略标记，不进入 journal。

## SSE 重放

### 工具明细业务快照

`tool_details` 独立于 `turn_events/audit_log`，只存当前 chat/run 的工具输入、结果、状态、退出码、起止时间和可选摘要；正文不进入 journal。GET `/api/chats/:id/tool-calls?runId=...&after=revision` 经原 chat owner 与当前 access 授权；默认最新 run，按 revision 增量每页最多 5 条。run 必须属于同 chat/user；无管理员旁路，不随项目分享复制，chat/run 删除级联清理。前端在新 run 重置 cursor，结束后继续读取迟到摘要，切换/注销清除旧投影并废弃旧响应。

明细展示工具实际返回的输入/输出，不代表无限终端录制；每个输入/输出最多 4 Mi 字符，超限显式标注；秘密按字段和常见文本模式脱敏（不承诺完整 DLP）。记忆工具正文不另复制，避免记忆删除/失效后的持久旁路。命令退出码非零、超时、error 均呈现失败；未返回结果不能显示成功。旧运行缺失明细不回填。重启把未完成工具标为 interrupted、待摘要标为 unavailable，不重放工具或云端请求。

普通项目完成工具的摘要是尽力而为的后台工作：固定 Luna-low、250ms 合并同一 run 最多 6 条、全局单并发、待处理最多 64 条、每条输入1200/输出1800字符、25秒超时、不重试，不占 EXECUTE lease，不阻塞下一工具或 turn 结束。失败/队满仍保留原始明细；摘要不能改变执行成功状态。隐私项目和记忆工具硬跳过云端摘要。

- POST turn 的 SSE frame 带 `id:`。
- GET run events 同时校验当前 user、chat、run 和 active project access。
- 客户端可用 `Last-Event-ID`，或用 `after` 查询参数回退。
- 服务端先注册 live subscriber，再读取确定的历史水位线，并按 id 去重，避免订阅与查询之间的丢事件窗口。
- 历史按最多 5000 条分页；前端循环读取到 `latestEventId`，不能只拉最后一页。
- 收到终态事件后关闭；401/403 不重试，暂时网络错误按 1、2、5 秒退避。
- 用户被停用或 access 被撤销后，即使已有 SSE 连接也必须终止或拒绝继续重放。
- GET run SSE 与旧 POST turn SSE 每次投递及心跳复验原 Web session；注销立即关闭该 session 的 turn 流。旧 POST 流保留固定 `AUTH_REQUIRED` 结束事件，不向失效会话释放后台错误或任务正文。断开 Web 流不等于取消 Codex 运行，其他有效 session 仍可恢复该任务；真正中断走现有 interrupt API。

## 浏览器导航与临时状态

- 视图、当前项目及对话写入受限 URL 参数，浏览器前进/后退恢复对应位置。项目、对话、文件和历史恢复使用选择世代，避免 A→B→A 的旧响应覆盖新选择。
- 输入草稿及发送重试 ID 按 chat 保存于当前页面内存；切换后恢复，注销清空，不把正文写入 localStorage。离开整个页面时对未发草稿提供浏览器提示，不承诺刷新后的持久草稿。
- 文件编辑以已保存内容为基线；切项目、换文件或离开页面时保护未保存修改，确认放弃后才丢弃。
- 看板个人排序仅存当前用户命名空间的卡片 ID，不保存正文或令牌，不修改服务器状态与其他用户顺序。

## 确定性消息 fallback

每个 run 使用确定性 ID 写入：

- `user:<turnRunId>`：去除 Portal mode/skill 控制前缀后的用户消息；
- `assistant:<turnRunId>`：终态 final reply；
- `error:<turnRunId>`：失败、取消、中断或重启终态。

写入采用幂等语义。`historyForChat` 优先调用 native `thread/read`；失败时返回本地 messages。native 历史成功时仍需补入只存在于 Portal 的失败/中断消息，且不能重复或打乱顺序。

前端恢复 queued/starting/running turn 时，用户输入以 `messages` 中的确定性记录为准。event journal 不保存 prompt，因此恢复 entry 缺少 prompt 时不得据此合成空白用户消息；只有客户端仍持有非空 prompt 且历史中尚无同内容用户消息时才可补绘。

## Thread 恢复

```text
ready --resume failed--> resume_failed
resume_failed --retry success--> ready, same thread id
resume_failed --reset + explicit acknowledgement--> ready, new thread id + lineage
```

- resume 的错误先脱敏、截断，再写 `thread_error`。
- retry 只恢复原 thread，不得回退到 start 新 thread。
- reset 明确表示原生上下文断裂；必须由用户确认，并在 `chat_thread_recoveries` 保存 old/new/reason/time。
- 恢复操作是 chat/workspace 生命周期的一部分。停用、撤权、删除或并发恢复发生时，提交结果前必须重新验证并拒绝 stale result。

## Portal 重启恢复

启动时在事务内：

1. 将遗留 `queued/starting/running` run 转为 `interrupted`；
2. 为每个 run 写 `PORTAL_RESTARTED` 事件和确定性 error message；
3. 取消所有 pending approval；
4. 删除 execution lease；
5. 把 chat 运行展示状态恢复为 idle；
6. 幂等修复历史孤儿 submission/task 状态。

随后把遗留 queued/running memory extraction job 标为 failed（`REPLACED_BY_MEMORY_TOOLS`），保留历史但不重放。只由四个记忆工具或人工界面触发 CRUD，工具成功的写入不随 turn 失败回滚。每次 search 返回前记录引用；没有 tool call 就没有自动注入或提取。同一时刻按现有 active 记忆重建每用户派生索引，索引失败不阻止 Portal/Codex ready。

Portal 不尝试在没有可靠 native turn 身份和订阅的情况下把崩溃前 turn 当作继续运行。

## Submission 保留与代码快照

submission 的 chat/run 外键使用 `ON DELETE SET NULL`，同时保存不可变原生 id、final reply、diff、note、版本、原 project access、Git snapshot commit/tree，以及通过审核后的 owner delivery commit/time。当前应用仍禁止删除其来源 chat，以保持完整证据链；`SET NULL` 是数据库最后防线，不是普通删除入口。

迁移为历史 submission 增加 nullable Git 字段以保持旧数据可读。历史 pending submission 没有可验证 Git 快照时不能直接 `passed`，只能 `rework` 后从当前有效 access 重新提交。新 submission 的 snapshot 字段由应用层强制非空和合法 SHA 格式。

## 备份与恢复

- 停服备份必须包含 SQLite 主文件、`-wal`、`-shm`，以及 `workspaces/`、`trees/`、`trash/`。`.data/memory-index` 可选，因为能从 SQLite 重建；模型缓存无需备份。
- 在线备份应使用 SQLite backup API，不能只复制主文件。
- 恢复 tree 或 trash 文件前必须核对 owner、access、branch 和 ACL，不得按路径猜测归属。
- `CODEX_HOME` 保存 native thread 与登录，不在 Portal SQLite 备份内；灾难恢复计划必须单独考虑它。
- 新 schema 一旦允许多员工授权，旧二进制可能重建旧单席索引，不能把降级旧代码当作无风险回滚。

显式 share 复制受 ACL 保护的消息 fallback，并在 chat 保存来源 chat id 与分享时间；完整模型上下文由独立 native fork 保存。副本不引用原 run/task 权限，不在 audit/event 保存 transcript。新增字段幂等迁移，既有 chat 保持无来源字段。

## 输入队列恢复与实时投影

`chat_inputs` 用 `CREATE TABLE/INDEX IF NOT EXISTS` 幂等迁移；迁移本身不改变运行状态，只有 Portal 启动恢复会把遗留 queued 输入暂停。遗留 steering 标记 `DELIVERY_UNCERTAIN`，不能自动重发；用户核对历史并显式确认后才能继续。正常 dispatch 在一个 SQLite 事务中创建 run、确定性用户消息并把输入标记 sent，避免崩溃后重复出队。历史水合需保留同一 native turn 的多个 userMessage，steer 的客户端标识用于与本地 fallback 去重。

队列 HTTP GET 返回正文，只允许当前 chat owner 在有效 access 内读取；列表和状态由前端定期恢复。待发队列发生变化和新 run 出现后，前端继续复用 run SSE/journal 和消息历史恢复，停止后保留暂停卡片。POST 确认丢失时保留输入框草稿并复用客户端 id 重试。

`input_steered` journal 仅含 input/run 标识，不含正文。GET run SSE 还可向已授权在线订阅者传递不持久化的 assistant/reasoning/command delta 与实时 diff；实时帧不推进 journal cursor，重放仍只返回脱敏语义事件。每次投递继续复验用户状态与 access，断线后正文由受 ACL 的消息/run 快照补齐。

## 工作图恢复

项目事件以 SQLite 为历史源；新页面从零重放当前授权历史，不能只恢复游标而丢弃正文。前端按事件 id 去重、倒序展示，不按最近条数删除历史；项目切换后忽略旧连接回调。连接重试使用 Last-Event-ID 继续接收。

工作图 submission 支持 manual 空原生身份，业务事件采用接收者 ACL。Portal 启动恢复 job；completed 原生运行与持久结构化回执可收敛，其他不确定原生投递需人工确认重试。 详细契约见 [多人 Work Graph](09-human-work-graph.md)，操作见 [工作图指南](../../docs/WORK_GRAPH.md)。

在线规划的明确终态网络失败可按第 09 章的窄条件恢复，不改变进程重启/失租约时的保守策略；手动重试不能丢弃已持久回执。旧 turn 留存用于计数与核对，不重置原生 thread 映射。

## Token 用量账本

新增 token_usage_calls、token_usage_streams、数值样本去重表 token_usage_samples 和 token_usage_meta，使用幂等 CREATE TABLE/INDEX；chats.preferred_effort 为 nullable 幂等迁移。账本与内容表无级联外键，保留删除后的历史消费归属。计量更新和累计水位在同一 SQLite savepoint 提交；相同 native thread/turn 绑定唯一，迟到通知仍可定位原调用。Portal 启动将未结束计量标记 incomplete/finished，不推断未知消耗、不重新发送模型请求；普通 CLI 打开数据库不做运行恢复。

看板按 Asia/Shanghai 的调用开始日期分桶，支持最多 366 天范围，当前请求的累计消费归于其开始日。返回采集起点、更新时间、未上报/不完整/进行中数量；没有真实 usage 的调用不能显示已完整计量。历史 journal 不回填；用量数据库本身保留上游数值而非模型正文。
