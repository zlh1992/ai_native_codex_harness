# 05 执行、并发与生命周期

## 两级容量模型

Portal 在 App Server 最大并发之上再施加业务调度：

| 资源 | 当前硬上限 | 作用 |
| --- | ---: | --- |
| Codex concurrent turns | 40 | 配置与员工并发的绝对上限 |
| Portal active root turns | 11 | 所有 EDIT/EXECUTE root 的实际运行上限 |
| EXECUTE leases | 默认 11 | 默认与 Portal root 上限一致；可由运营配置调低 |
| Native subagents per root | 3 | 单个 root 下的子代理并发上限 |

每用户另有 `maxConcurrentTurns`。上限通过配置可以调低，但不能超过代码硬上限。

## Workspace 并发与空闲屏障

调度键是 `project.accessId`，它与唯一 owner tree 或员工 worktree 对应。

- 同一 chat 的 root turn 串行；同一 workspace 的不同 chat 可并发运行 EDIT 或 EXECUTE。
- 同一用户的不同 access 可以并发，只要用户与全局容量允许。
- 同一项目的不同员工 access/worktree 可以并发。
- 子代理归属于 root，不单独领取 root slot 或 execution lease。
- 当 worktree 存在 queued/starting/running/recovering 操作时，浏览器文件 PUT、DELETE 和 mkdir 必须返回 `WORKSPACE_BUSY`。
- 文件 GET 返回内容 SHA-256 `version`。编辑器保存必须把该值作为 `If-Match` 发送；服务端在实际写入前复核并把 expected version 交给 sandbox helper。两个浏览器写入即使都从同一旧内容开始，只有首个可成功，后一个返回 `FILE_VERSION_CONFLICT`。明确勾选覆盖的上传可以不带版本执行人工 force overwrite。
- 创建 submission Git 快照时原 access/worktree 必须空闲；审核 `passed` 的 owner merge 同时要求 owner access 和 submission 原 access 都空闲。两项 Git 操作在 Portal 事件循环内同步完成，检查通过后不能插入新的 Portal root turn。

Portal 跟踪每个 access 上全部 queued/starting/running/recovering 工作，但该占用只用于浏览器写入、submission、delivery 与生命周期空闲屏障，不阻止不同 chat 启动。多个 root 会共享同一 tree，可能看到彼此未完成的修改；同时写同一文件时当前没有自动冲突解决。需要干净基线或冲突隔离时，应新增 per-chat/task execution environment/worktree。

## Task 代码交付

```text
completed task turn
  -> wait for assignee access/worktree idle
  -> commit complete worktree state
  -> store access id + commit SHA + tree SHA on submission
  -> boss reviews the immutable submission
  -> wait for owner and assignee worktrees idle
  -> snapshot owner dirty state
  -> merge exact submission commit into owner
  -> store delivery commit
  -> mark passed and advance roadmap
```

`rework` 不合并代码并创建新 task version。`passed` 的 merge 冲突必须 abort 且保持 pending；不能先更新数据库状态再尝试交付。若进程在 Git merge 成功后、SQLite 更新前失败，重试检测 submission commit 已进入 owner 历史并继续完成状态更新。

## EDIT 与 EXECUTE

| 模式 | 文件读取/编辑 | `workspace_exec` | EXECUTE lease | 审批 |
| --- | --- | --- | --- | --- |
| EDIT | 允许，受 ACL 与 sandbox 约束 | 服务端拒绝 | 不占用 | 合法项目文件变更自动接受 |
| EXECUTE | 允许 | 项目内自动允许 | 必须持有 | 文件与命令均自动接受，越界仍拒绝 |

新建和迁移后的 chat 默认 EXECUTE；模式选择按 chat 持久化。默认配置下 EXECUTE 可使用全部 11 个 root 席，不再因独立的 2 席上限阻塞；若运营显式调低 EXECUTE 上限，或用户/root 容量已满，请求进入持久可见的 queued 状态。

## Turn 启动顺序

1. 校验 user、chat、task version 与 active project access。
2. 创建 `turn_run`，写入 queued/status 事件。
3. 获取用户、root 和可选 EXECUTE lease，并登记 access 占用；登记不排斥同 access 的其他 chat。
4. 在真正启动前重新校验用户状态、access 和网络策略。
5. 启动或 resume 服务端绑定的 Codex thread。
6. 对 task turn 发现并注入 Portal 管理的 task skill。
7. skill await 后再次校验策略。
8. 发送 `turn/start`，立刻保存 native turn id。
9. 再检查启动窗口内的停用、撤权或网络策略变化；必要时立即 interrupt。
10. 只有边界都有效时进入 running。

## 中断与终止

中断必须覆盖：

- 尚在 capacity 队列中的请求；
- thread/skill/turn 启动窗口中的 pending chat；
- 已运行的 native turn；
- 正在执行的命令 AbortController；
- pending approvals；
- execution lease；
- 终态 run、chat 状态、事件和确定性 error message。

终止顺序是：取消 approval/命令，持久化 chat 与 run 终态及终态事件，再删除 execution lease、释放 workspace/root 容量并唤醒队列。持久化失败时不能先释放容量让后续写入进入同一 workspace。

如果用户在 native `turn/start` 返回 id 之前点击停止，Portal 必须记住 interrupt intent；收到 id 后立即中断，不能让该 turn 脱离管理继续运行。

## 生命周期屏障

| 操作 | 先阻止新工作 | 中断/等待对象 | 超时结果 |
| --- | --- | --- | --- |
| 停用用户/重置密码/改变网络策略 | user/session 或策略先失效 | 该用户所有 queued/setup/active work、approval、subagent、lease | `USER_DRAIN_TIMEOUT`；策略已生效、保留数据，不静默清理活跃 tree |
| 撤销 shared access | 先标记 revoked | access 下所有 chat、approval、lease | `SHARE_DRAIN_TIMEOUT`，access 仍 revoked、tree 保留 |
| 删除 chat | chat 当前仍需可校验 | run、approval、lease、thread recovery | `CHAT_RUNNING/CHAT_BUSY`，不删除 |
| 删除 project | owner 权限且无 active share | 项目全部 runtime 与 owner workspace | `PROJECT_BUSY`，不移入 trash |
| 恢复 thread | recovery 标记占用 chat/workspace | 与新 turn/删除/撤权互斥 | 状态变化则拒绝提交恢复结果 |

生命周期判断同时使用内存中的 pending/recovering map 与 SQLite 的 run/approval/lease。不能只依赖 `chats.status`，因为崩溃或异步窗口可能使单字段暂时落后。

## 子代理策略

- App Server 配置 `agents.enabled=true`，max concurrent threads per session 固定为 3。
- `default`、`worker`、`explorer` 角色均指向 Portal 管理的只读配置，默认模型为 `gpt-5.6-luna`、medium effort。
- 项目文件不得提供 agent 或 `[agents]` 覆盖。
- Portal 根据原生 `thread/started`、`thread/settings/updated` 和 `collabAgentToolCall` 追踪 parent/root、数量与模型；发现越界时中断 root。
- 子代理结果属于一个 root 内部协作，不自动成为其他顶层 chat 可见消息。

新 share 在 owner access 空闲后持有分享屏障，阻止该 access 的 turn、恢复、浏览器修改与 chat 集合修改，直至文件与全部对话 fork 提交或回滚；异步步骤后复验会话、owner access、接收者状态与有效授权唯一性。

## Root 模型选择

老板模型偏好在 run 创建前解析、校验并冻结到本次 context；thread/start、thread/resume 和 turn/start 使用同一模型。已有 loaded thread 的下一 turn 仍显式传 model，无需重建 thread 或丢失历史。运行/恢复或存在待发输入时拒绝修改模型，防止队列配置漂移。该选择不改变 provider、沙箱、容量或固定 Luna 子代理策略；上游拒绝模型时沿用失败与恢复流程，不静默降级。

## 运行中输入与队列调度

浏览器输入框在当前 chat 运行时继续接受输入和发送。所有新消息先进入服务端私有输入队列；页面关闭不撤销发送意图。每个 chat 按插入顺序自动消费，队首暂停时后续消息也等待；排队消息本身不领取 root/EXECUTE lease。调度器在用户与全局容量允许时复验 user/access/task/恢复/分享状态，再调用既有 runTurn 和 capacity 调度。当前 turn 完全释放后才创建下一轮；并发复查只统计其他 chat，避免单并发用户把自身误判为超额。

queued/steering 输入加入 chat/access/project 的持久生命周期与文件写入屏障；paused 是未执行草稿，不占运行资源。停止会暂停待发消息并中断当前 turn；失败、中断、停用、改密、撤权与 app-server 退出同样阻止队列继续自动执行。继续排队需重新通过执行策略校验。启动错误或运行异常不能自动反复重试同一消息。

“打断插队”通过固定版本原生 `turn/steer` 把选定消息送入当前 turn，不创建第二个 root。Portal 同时校验客户端看到的 Portal run id，以及服务端持有的 native `expectedTurnId`，并把 queue id 作为 `clientUserMessageId`；不接受客户端 thread/cwd。只允许同一运行模式，当前模型、模式、沙箱、lease 和其余待发顺序均保持原执行语义。starting、已经结束、停止中或另一次 steer 尚未确认时返回冲突，不能误投下一轮。steer RPC 期间即使原 turn 完成，也须等待 RPC 确认后才允许下个输入启动。
