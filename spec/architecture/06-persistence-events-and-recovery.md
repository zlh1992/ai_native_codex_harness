# 06 持久化、事件与恢复

## 三类事实源

| 数据 | 事实源 | 用途 |
| --- | --- | --- |
| 用户、ACL、项目、task、run、approval、lease、submission、审计 | SQLite | 业务授权与状态机 |
| 完整原生 transcript、thread/turn/item | Codex `CODEX_HOME` | 高保真对话历史与原生恢复 |
| 项目文件与 Git 状态 | 主目录/worktree | 共享事实和交付内容 |

Portal 不把 Codex thread 当唯一业务事实，也不复制完整 transcript 到审计表。`messages` 和 `turn_events` 是在原生历史暂时不可用时维持基本可见性和运行恢复的受限投影。

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

- POST turn 的 SSE frame 带 `id:`。
- GET run events 同时校验当前 user、chat、run 和 active project access。
- 客户端可用 `Last-Event-ID`，或用 `after` 查询参数回退。
- 服务端先注册 live subscriber，再读取确定的历史水位线，并按 id 去重，避免订阅与查询之间的丢事件窗口。
- 历史按最多 5000 条分页；前端循环读取到 `latestEventId`，不能只拉最后一页。
- 收到终态事件后关闭；401/403 不重试，暂时网络错误按 1、2、5 秒退避。
- 用户被停用或 access 被撤销后，即使已有 SSE 连接也必须终止或拒绝继续重放。

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

Portal 不尝试在没有可靠 native turn 身份和订阅的情况下把崩溃前 turn 当作继续运行。

## Submission 保留与代码快照

submission 的 chat/run 外键使用 `ON DELETE SET NULL`，同时保存不可变原生 id、final reply、diff、note、版本、原 project access、Git snapshot commit/tree，以及通过审核后的 owner delivery commit/time。当前应用仍禁止删除其来源 chat，以保持完整证据链；`SET NULL` 是数据库最后防线，不是普通删除入口。

迁移为历史 submission 增加 nullable Git 字段以保持旧数据可读。历史 pending submission 没有可验证 Git 快照时不能直接 `passed`，只能 `rework` 后从当前有效 access 重新提交。新 submission 的 snapshot 字段由应用层强制非空和合法 SHA 格式。

## 备份与恢复

- 停服备份必须包含 SQLite 主文件、`-wal`、`-shm`，以及 `workspaces/`、`trees/`、`trash/`。
- 在线备份应使用 SQLite backup API，不能只复制主文件。
- 恢复 tree 或 trash 文件前必须核对 owner、access、branch 和 ACL，不得按路径猜测归属。
- `CODEX_HOME` 保存 native thread 与登录，不在 Portal SQLite 备份内；灾难恢复计划必须单独考虑它。
- 新 schema 一旦允许多员工授权，旧二进制可能重建旧单席索引，不能把降级旧代码当作无风险回滚。

显式 share 复制受 ACL 保护的消息 fallback，并在 chat 保存来源 chat id 与分享时间；完整模型上下文由独立 native fork 保存。副本不引用原 run/task 权限，不在 audit/event 保存 transcript。新增字段幂等迁移，既有 chat 保持无来源字段。

## 输入队列恢复与实时投影

`chat_inputs` 用 `CREATE TABLE/INDEX IF NOT EXISTS` 幂等迁移；迁移本身不改变运行状态，只有 Portal 启动恢复会把遗留 queued 输入暂停。遗留 steering 标记 `DELIVERY_UNCERTAIN`，不能自动重发；用户核对历史并显式确认后才能继续。正常 dispatch 在一个 SQLite 事务中创建 run、确定性用户消息并把输入标记 sent，避免崩溃后重复出队。历史水合需保留同一 native turn 的多个 userMessage，steer 的客户端标识用于与本地 fallback 去重。

队列 HTTP GET 返回正文，只允许当前 chat owner 在有效 access 内读取；列表和状态由前端定期恢复。待发队列发生变化和新 run 出现后，前端继续复用 run SSE/journal 和消息历史恢复，停止后保留暂停卡片。POST 确认丢失时保留输入框草稿并复用客户端 id 重试。

`input_steered` journal 仅含 input/run 标识，不含正文。GET run SSE 还可向已授权在线订阅者传递不持久化的 assistant/reasoning/command delta 与实时 diff；实时帧不推进 journal cursor，重放仍只返回脱敏语义事件。每次投递继续复验用户状态与 access，断线后正文由受 ACL 的消息/run 快照补齐。
