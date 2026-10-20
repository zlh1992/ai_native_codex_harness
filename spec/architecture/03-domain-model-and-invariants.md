# 03 领域模型与不变量

## 实体关系

下图的共享/task 分支仅适用于 standard 项目。`local_private` 项目类型不可变，只保留老板 owner access；chat 绑定 local_session_id 而非 Codex thread，并独立保存 control_mode（manual 默认 / auto）。`user_memories.scope_project_id` 为 null 表示普通用户记忆，否则必须为当前老板的同一隐私项目，不能迁移作用域。恢复 lineage 增加 engine。详见 [本地隐私项目](10-local-private-projects.md)。

```text
User
  1 -> N owned Project
  1 -> N ProjectAccess
  1 -> N private Chat
  1 -> N UserMemory -> N source Project/Chat/Turn

Project
  1 -> 1 owner ProjectAccess
  1 -> N shared ProjectAccess
  1 -> N Roadmap -> ordered Tasks

ProjectAccess
  1 -> 1 treePath / branch / baseSha
  1 -> N Chat

Chat
  0..1 -> native Codex thread
  1 -> preferred EDIT/EXECUTE mode
  1 -> N TurnRun -> N TurnEvent
                    -> N TurnApproval
                    -> 0..1 ExecutionLease
  0..N -> ChatThreadRecovery lineage records
  0..N -> TurnMemoryRef -> UserMemory version

Task + TaskVersion
  0..1 -> task-bound Chat
  0..1 -> immutable Submission per version
             -> project_access + snapshot commit/tree
             -> passed delivery commit in owner history

ChannelBinding
  1 -> 1 external channel + scope
  1 -> 1 owner standard Project + owner Chat
  1 -> N ChannelEvent (unique external event id)

微信 `ChannelBinding` 只能由 Portal 按运营配置解析到老板的 standard `weichat-project`；桥接提交的 scope、sender 和 event id 不是权限凭据。binding 只为对应老板 chat 派生跨项目只读能力，目标集合为该 user 当前本人拥有且 access_kind=`owner` 的 standard 项目；能力不写入客户端、不扩展 chat 的 project/access，也不包含 shared、local_private 或本机目录。`ChannelEvent` 先登记为 `processing`，完成后写入脱敏的回复文本和 `completed|failed` 终态；重复 event id 只能重放已有终态，不能再次启动 turn。

微信渠道命令由 Portal 在事件登记前解析。`/new` 只能在当前 chat 空闲时创建同一固定项目下的新 chat，并原子地把 active binding 指向新 chat；旧 chat、thread 和事件历史保留。`/models` 返回 Portal 白名单目录，`/model <id>` 只能写入当前 chat 的 `preferred_model`，并复用同一模型白名单；这些命令不启动 Codex turn。
```

`thread id`、`tree path`、`access id` 都是资源标识，不是 bearer capability。请求仍必须从已认证用户出发，重新解析 chat 与 active project access。

## 用户与会话

- `users.role` 只有 `admin | user`；`users.status` 只有 `active | disabled`。
- Web 不能创建第二个 admin，也不能把 user 提权为 admin。
- 会话只对 active 用户有效。停用或重置密码必须撤销其全部会话，中断该用户 queued/setup/active 运行，并等待持久终态或返回明确排空超时。
- 超级管理员可为员工设置新密码。改密不转移项目、chat 或 `project_access` 的归属；新密码的持有者重新登录后，获得的是该员工身份已有的有效访问权限。该能力构成受信任管理员的账号接管边界，而不是 `admin` 角色的内容 ACL 例外。
- 数据库保存 session token 的 SHA-256 摘要，不保存浏览器 bearer token 原文。

## 项目与授权

- 项目有且只有一个 owner，由 `projects.user_id` 和 owner `project_access` 表达。
- 一个项目可以同时授权多名 active 员工；每名员工绑定不同的 shared access 与 worktree。
- `(project_id, user_id)` 在 active access 中唯一。撤权记录可以保留，用于同一员工恢复其脏 worktree。
- 新授权先把 owner 当前 Git 可见的已跟踪修改、未跟踪文件和删除状态提交为不可变 baseline commit，再从该 commit 创建 worktree；`project_access.base_sha` 精确绑定该 commit，授权响应与老板 UI 显示其短 SHA。
- 撤权先把 access 标记为 revoked，阻止新请求；排空完成后仅移除干净 tree，脏 tree 原地保留。
- 恢复授权必须复用匹配的 revoked access/tree，并在恢复前重新计算用户存储配额。

## 对话与 thread

- 每个 chat 固定绑定 `user_id + project_id + project_access_id + tree_path`。
- chat 只能由其创建者读取，即使其他用户拥有同一项目 access 也不能读取。
- `codex_thread_id` 由 Portal 创建或恢复，客户端不能指定。
- `thread_state=resume_failed` 时禁止自动发起新 turn；恢复操作分为 retry 原 thread 和确认历史断裂后的 reset。
- reset 必须原子记录 old/new thread lineage，且不假装旧历史已经注入新 thread。
- task chat 同时绑定 task id 与 task version；任务版本变化后旧 chat 不能继续提交新版本证据。
- `preferred_mode` 由每个 chat 独立持久化，新建和迁移后的 chat 默认 `execute`；切换另一个 chat 必须恢复该 chat 自己的值。
- `use_memory` 与 `save_memory` 由每个 chat 独立持久化并默认开启；planner/reviewer 即使字段为真也不得召回或形成记忆。

## 用户记忆与来源

普通/task root 的四个 memory 工具由模型自行选择调用；`use_memory` 控制 search，`save_memory` 控制 add/update/delete。工具新增绑定当前来源；更新以事务追加来源并递增版本，保留全部来源的 ACL 约束；同正文重复新增只返回原记录元数据，不修改来源。搜索结果带 id/version/body 并记录引用，工具新增只返回元数据。

工具修改/删除后，所有旧引用 chat 标记失效并暂停队列，其他活跃 chat 中断并排空；调用者不自等待中断，可以确认结果，但后续动态工具和原生写入批准拒绝，下一轮必须显式 reset。retry 在异步恢复前后复验引用，不允许恢复已失效记忆的旧线程。已经执行中的操作不能被追溯撤销。

- `user_memories.user_id` 是唯一 owner；没有项目来源的手动记忆可用于该用户的所有当前项目，turn 新增或工具更新必须记录来源 project/chat/run。source_kind 表示最初创建方式，后续工具更新仍追加来源 ACL。
- 跨项目仅表示同一 user 在多个当前有效 access 间召回，不表示另一个用户、老板角色或共享项目成员可读。
- 语义索引只排序候选。注入前以 SQLite active/version 和每个 `user_memory_sources.project_id` 的当前 access 重新过滤，并限制最多 8 条、约 4000 tokens。
- 每轮实际注入持久化 `memory_id + memory_version + source_project_id`。记忆编辑、删除或来源授权失效后，旧 native thread 不得静默继续；对应 chat 进入 `resume_failed`，只能由用户明确 reset 后建立空白线程。
- 手动删除立即清空权威正文并留下 tombstone/version；索引异步重建期间的旧向量命中必须被 SQLite 拒绝。
- `files_and_history` 分享的确认 token 单次使用、10 分钟过期，并绑定 owner、接收者、目标项目、chat 更新时间及引用记忆当前版本。确认不转移记忆本身，历史 fork 也必须剥离 Portal 注入的隐藏 memory context。用户显式 reset 空白 native thread 时记录 `memory_context_reset_at`；该时间之前的引用保留为历史证据，但不再污染新线程或后续分享快照。

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

- approval 必须绑定 turn run、chat、user、item 和 kind。项目内自动 approval 只可在当前 active user/access 复验成功后接受；原生文件 approval 必须保存脱敏的项目相对目标集合，目标缺失、越界或命中保留目录时拒绝。
- EDIT turn 始终拒绝命令执行；EXECUTE 命令通过项目、cwd、用户与网络策略校验后自动记录 accepted approval 并进入 Seatbelt，不等待浏览器逐次确认。老板与员工规则一致。
- pending approval 在中断、撤权、停用、重启或 turn 终止时必须取消。
- execution lease 仅服务 EXECUTE 容量，按 `turn_run_id` 唯一；过期 lease 不应继续计入 active 数量。

## Roadmap、Task 与 Submission

- `kind=linear` roadmap 是有序线性步骤；同一时刻按流程激活当前任务，审核 passed 后推进下一步。
- task 的 assignee 必须拥有该项目当前有效 access；撤权后激活、提交、审核和推进均应停止。passed 审核同时校验当前与下一 task assignee。
- submission 以 `(task_id, task_version)` 唯一；`kind=codex` 必须引用该 assignee、对应 task chat、完成的 turn、final item 和当前版本。
- submission 保存 `codex_thread_id`、`codex_turn_id`、final item、final reply、diff、employee note、原 `project_access_id` 和 Git snapshot commit/tree 的不可变快照。
- 创建 submission 前，原 access/worktree 必须空闲；Portal 将 tracked、untracked 和删除状态提交为固定 commit，并拒绝保留路径、symlink 或 submodule 条目。
- `passed` 审核前，owner workspace 和原 access worktree 都必须空闲；Portal 先快照 owner 当前本地修改，再把 submission commit 以 merge commit 合入 owner。冲突时 abort merge，submission 保持 pending；成功后记录 `delivery_commit_sha` 和 `delivered_at`，然后才推进 task/roadmap。
- Git 与 SQLite 不是同一事务；交付重试以“submission commit 已是 owner HEAD 的 ancestor”为幂等判据，允许在 Git 已成功而数据库状态尚未更新时安全收敛。
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

## 显式 share 的对话快照

新授权在 owner access 空闲时冻结其项目 chat 集合，逐个用服务端绑定的 `thread/fork` 创建员工原生线程；空白 chat 复制为空白私有 chat。全部准备成功后，在一个 SQLite 事务中发布 access、chat、消息 fallback 和来源时间。所有副本绑定接收者 access/tree，保留标题与模式，但不复制 task/run/submission 权限。历史里的 run id 只能关联当前副本的运行，不能回指 owner run。

同一分享内文件基线与历史在 owner 写入屏障下取得；员工续聊不得复用 owner native thread。之后 owner 新增的内容不会自动流入员工，员工续聊不会流回 owner 或其他员工。恢复保留的 revoked access 保留其已有对话而不重新复制；既有 active share 不做隐式迁移。对话列表只列出当前 access 下的 chat；来源字段只是 lineage，不授予访问原 chat 的权限。分享失败不发布部分授权；失败创建的上游线程可能成为无 Portal 映射的孤立副本，原线程不删除。

## 对话模型与推理强度偏好

`chats.preferred_model` 与 `chats.preferred_effort` 为 nullable、按对话保存的 root 偏好。老板与员工均可在自己的普通项目/任务对话选择 Portal 模型白名单；该目录由部署策略控制，老板和员工相同；当前仅允许 GPT-6.1 Sol 及 GPT-5.6 Sol/Terra/Luna，不包含 Astra、隐藏 reserve 或内部审核模型。默认模型来自 `CODEX_MODEL`。员工默认强度 medium，老板默认 `CODEX_REASONING_EFFORT`（默认 high）；强度解析依次为本次显式请求、chat 偏好、角色默认，非法值拒绝。已有模型偏好保留；当偏好模型退出当前白名单时，不改写数据库值，运行按当前 `CODEX_MODEL` 执行，新的 API 选择仍拒绝退役 ID。旧 chat 强度为 null，不回写历史运行。分享的新副本不复制模型/强度偏好，采用接收者默认；恢复既有授权保留原 chat 偏好。隐私项目不能设置这些 GPT 偏好，后台 planner/reviewer 不接受浏览器修改。

模型和强度仅在没有运行、恢复或待处理输入时修改；队列保存入队时的强度，run 冻结模型/强度。后续偏好不能改写已经派发或排队的工作；steer 沿用当前 turn 配置。上游不支持模型/强度时显式失败，不静默降级。

## 模型用量事实

`token_usage_calls` 保存独立调用归属、引擎、模型、强度、类别、创建时间及上游数值计量，不引用对话正文。根运行、子代理、独立搜索/摘要及本地每次 HTTP 推理请求分别记录；辅助请求归属发起运行用户。模型/强度是调用快照，禁止从 chat 当前偏好反推。input 包含缓存，output 包含已报告的 reasoning，细项不重复相加。DSH 的未缓存 input + cacheRead/cacheWrite 需转换为含缓存的输入口径；本地原始 SSE prompt_tokens 已含缓存。

账本不随 chat/project 删除，不回填上线前零散 journal，不包含网站外调用。未上报、不确定基线或未完成调用显式标记 incomplete；零值只表示已知上报量，不能宣称未知消耗为零。

## 私有输入队列

`Chat -> N ChatInput` 保存尚未发给模型的用户消息，与已经创建的 `TurnRun` 分开。字段包含客户端幂等 id、正文、模式、推理强度、状态、revision、原因码及关联 run。一个 chat 最多保留 50 条未处理消息、总计 100 万字符，单条仍限 10 万字符。

```text
queued -> sent (atomically create TurnRun + user message)
queued/paused -> steering -> sent (accepted by current native turn)
queued -> paused (stop/failure/restart/policy change)
paused -> queued (explicit resume)
queued/paused -> cancelled
steering -> paused (delivery uncertain; never automatically resend)
```

编辑、取消、继续和 steer 必须携带当前 revision。消息开始发送或版本变化后旧操作返回 `INPUT_CHANGED`，不能覆盖已经提交给模型的内容。成功/取消后清空队列正文，保留幂等标识；正常发送的正文转入 `user:<run>`，steer 使用 `steer:<inputId>`。队列内容不复制到 share 的新 chat；只有已送入对话的历史参加既有 fork。

## 多人图扩展

`kind=dag` 的计划、人工提交、清单、审核及 handoff 遵循 [多人 Work Graph](09-human-work-graph.md)。manual 原生身份为空；不能套用 linear 的下一步推进逻辑。包含 workflow 历史的项目暂不提供普通删除，须保留提交与恢复证据。

## 项目对话归档

归档仅是 chat 所有者的列表组织状态，`archived_at` 为空表示未归档。老板与员工通过同一 PATCH archived 布尔字段操作自己的 chat；仍须当前 access、Origin 和 CSRF。归档要求无运行/恢复/待发输入，不删除消息、原生 thread、提交或任务关系，不等于停止、撤权或禁止后续任务。已归档列表可读取和恢复，内部 listChats 与分享、生命周期检查仍包含归档对话。
