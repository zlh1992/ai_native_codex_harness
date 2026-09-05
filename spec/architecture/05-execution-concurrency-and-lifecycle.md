# 05 执行、并发与生命周期

## 两级容量模型

Portal 在 App Server 最大并发之上再施加业务调度：

| 资源 | 当前硬上限 | 作用 |
| --- | ---: | --- |
| Codex concurrent turns | 40 | 配置与员工并发的绝对上限 |
| Portal active root turns | 11 | 所有 EDIT/EXECUTE root 的实际运行上限 |
| EXECUTE leases | 2 | 同时可运行的命令型 root 上限 |
| Native subagents per root | 3 | 单个 root 下的子代理并发上限 |

每用户另有 `maxConcurrentTurns`。上限通过配置可以调低，但不能超过代码硬上限。

## Workspace 单写者

调度键是 `project.accessId`，它与唯一 owner tree 或员工 worktree 对应。

- 同一 workspace 的 EDIT 与 EXECUTE root 全部串行。
- 同一用户的不同 access 可以并发，只要用户与全局容量允许。
- 同一项目的不同员工 access/worktree 可以并发。
- 子代理共享其 root 的 workspace 锁，不单独领取 root slot 或 execution lease。
- 当 worktree 存在 queued/starting/running/recovering 操作时，浏览器文件 PUT、DELETE 和 mkdir 必须返回 `WORKSPACE_BUSY`。

该锁保证没有两个 Portal root 同时写一个 tree，但不消除串行任务之间看到前序未提交修改的事实。需要任务级干净基线时，应新增 execution environment/worktree，而不是绕过锁。

## EDIT 与 EXECUTE

| 模式 | 文件读取/编辑 | `workspace_exec` | EXECUTE lease | 审批 |
| --- | --- | --- | --- | --- |
| EDIT | 允许，受 ACL 与 sandbox 约束 | 服务端拒绝 | 不占用 | 原生文件变更仍按策略审批 |
| EXECUTE | 允许 | 用户批准后允许 | 必须持有 | 命令审批绑定当前 run/chat/user |

EXECUTE 队列存在时，EDIT 仍可在 root 和 workspace 容量允许时运行。第 3 个 EXECUTE 请求必须进入持久可见的 queued 状态，而不是隐式失败或越过限制。

## Turn 启动顺序

1. 校验 user、chat、task version 与 active project access。
2. 创建 `turn_run`，写入 queued/status 事件。
3. 获取用户、root、workspace 和可选 EXECUTE lease。
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
