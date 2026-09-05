# 03 领域模型与不变量

## 实体关系

```text
User
  1 -> N owned Project
  1 -> N ProjectAccess
  1 -> N private Chat

Project
  1 -> 1 owner ProjectAccess
  1 -> N shared ProjectAccess
  1 -> N Roadmap -> ordered Tasks

ProjectAccess
  1 -> 1 treePath / branch / baseSha
  1 -> N Chat

Chat
  0..1 -> native Codex thread
  1 -> N TurnRun -> N TurnEvent
                    -> N TurnApproval
                    -> 0..1 ExecutionLease
  0..N -> ChatThreadRecovery lineage records

Task + TaskVersion
  0..1 -> task-bound Chat
  0..1 -> immutable Submission per version
```

`thread id`、`tree path`、`access id` 都是资源标识，不是 bearer capability。请求仍必须从已认证用户出发，重新解析 chat 与 active project access。

## 用户与会话

- `users.role` 只有 `admin | user`；`users.status` 只有 `active | disabled`。
- Web 不能创建第二个 admin，也不能把 user 提权为 admin。
- 会话只对 active 用户有效。停用或重置密码必须撤销其全部会话，中断该用户 queued/setup/active 运行，并等待持久终态或返回明确排空超时。
- 数据库保存 session token 的 SHA-256 摘要，不保存浏览器 bearer token 原文。

## 项目与授权

- 项目有且只有一个 owner，由 `projects.user_id` 和 owner `project_access` 表达。
- 一个项目可以同时授权多名 active 员工；每名员工绑定不同的 shared access 与 worktree。
- `(project_id, user_id)` 在 active access 中唯一。撤权记录可以保留，用于同一员工恢复其脏 worktree。
- 新授权的工作树基线包含 owner 当前 HEAD、已跟踪的本地修改和未跟踪文件快照。
- 撤权先把 access 标记为 revoked，阻止新请求；排空完成后仅移除干净 tree，脏 tree 原地保留。
- 恢复授权必须复用匹配的 revoked access/tree，并在恢复前重新计算用户存储配额。

## 对话与 thread

- 每个 chat 固定绑定 `user_id + project_id + project_access_id + tree_path`。
- chat 只能由其创建者读取，即使其他用户拥有同一项目 access 也不能读取。
- `codex_thread_id` 由 Portal 创建或恢复，客户端不能指定。
- `thread_state=resume_failed` 时禁止自动发起新 turn；恢复操作分为 retry 原 thread 和确认历史断裂后的 reset。
- reset 必须原子记录 old/new thread lineage，且不假装旧历史已经注入新 thread。
- task chat 同时绑定 task id 与 task version；任务版本变化后旧 chat 不能继续提交新版本证据。

## TurnRun 状态机

```text
queued -> starting -> running -> completed
   |         |          |
   +---------+----------+-> cancelled | interrupted | failed
```

- `queued/starting/running` 是非终态；其余为终态。
- 创建 run 后必须先持久化 queued/status 事件，再向浏览器投影。
- native `turn/start` 一旦返回 id，必须立即写入 `codex_turn_id`，即使 completed 通知先到也不能丢失身份。
- 释放 workspace/root/execute 容量前，run、approval、lease 和 chat 状态必须进入一致终态。
- Portal 重启时所有遗留非终态 run 统一转为 `interrupted`，不得在没有原生确认的情况下宣称 completed。

## Approval 与 ExecutionLease

- approval 必须绑定 turn run、chat、user、item 和 kind，且只能由同一当前用户处理。原生文件 approval 必须保存脱敏的项目相对目标集合；目标缺失、越界、命中保留目录或批准前发生变化时拒绝。
- EDIT turn 不能批准命令执行；EXECUTE 命令获得用户批准后才进入 Seatbelt。
- pending approval 在中断、撤权、停用、重启或 turn 终止时必须取消。
- execution lease 仅服务 EXECUTE 容量，按 `turn_run_id` 唯一；过期 lease 不应继续计入 active 数量。

## Roadmap、Task 与 Submission

- roadmap 是有序线性步骤；同一时刻按流程激活当前任务，审核 passed 后推进下一步。
- task 的 assignee 必须拥有该项目当前有效 access；撤权后激活、提交、审核和推进均应停止。passed 审核同时校验当前与下一 task assignee。
- submission 以 `(task_id, task_version)` 唯一，必须引用该 assignee、对应 task chat、完成的 turn、final item 和当前版本。
- submission 保存 `codex_thread_id`、`codex_turn_id`、final item、final reply、diff 和 employee note 的不可变快照。
- 审核只能给出 `passed | rework`。rework 创建新任务版本，不能覆盖旧提交证据。
- 历史上出现 `submitted` 但无 submission 的孤儿任务时，启动迁移只修复一次：升级版本并转入 rework，同时记录系统审计。

## 删除规则

| 对象 | 删除前必须满足 |
| --- | --- |
| 文件/目录 | 当前 access 有效、worktree 空闲、路径合法；移动到 trash |
| Chat | 无非终态运行/审批/lease/恢复；没有 submission 证据 |
| Shared access | 先 revoked，再排空；干净 tree 才移除，脏 tree 保留 |
| Project | 调用者为 owner；无 active shared access；无运行态；无保留的 revoked 脏 tree；项目移入 trash |
| User | 当前 Web 只支持停用，不提供不可恢复删除 |

可恢复 trash 仍属于执行删除动作的用户，并持续计入该用户存储配额，直到离线恢复或按运营流程清理。

## 公开 payload 边界

- Project payload 不公开 `treePath`、内部 branch 等物理绑定。
- Chat payload 不公开 `treePath` 和 `projectAccessId`。
- Approval payload 只提供用户做决定所需的脱敏信息。
- 事件只提供语义状态和安全元数据，不提供原始 prompt、文件、命令或 diff 内容。
