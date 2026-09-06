# 员工端实施说明

本分支把 `work.md` 中的员工交付链路落实为四道相互独立的边界：

1. `project_access` 决定员工能否看到项目；一个项目可授权多名员工，每个员工始终绑定独立 Git worktree。同一 tree 的不同 chat 可并发运行，浏览器写操作、任务快照和交付仍等待整个 access 空闲。
2. `chats.project_access_id + chats.tree_path` 固定 Codex thread 的项目树，旧页面不能在撤权后继续使用。
3. `turn_runs`、`turn_events` 和确定性 `messages` 保存运行终态、脱敏事件与历史兜底；完整对话优先由 Codex thread 持久化，页面通过 `thread/read` 重建历史。
4. `task_submissions` 对最终 `item/completed`、turn diff 和任务版本做不可变快照，且不随 chat/turn 删除；Codex goal 完成不会自动把业务任务判为通过。

员工项目数在配置、管理员接口和创建项目入口三层硬限制为 100；老板账号不受该员工上限影响。

## 容量规则

- App Server 全局绝对上限保留为 40。
- Portal 同时运行的 root turn 上限为 11。
- EXECUTE 使用持久化 lease，默认可占用全部 11 个 Portal root 席；运营显式调低上限或 root 满员后才进入可取消队列。
- EDIT 不占 EXECUTE lease，仍受用户和 root 容量约束。
- 每个 root thread 的原生子代理并发上限为 3，默认模型固定为 `gpt-5.6-luna`；Portal 用同一份只读配置层覆盖原生 `default`、`worker`、`explorer` 三个角色，避免显式 spawn 改用更贵模型，并检查可见的原生 collab item，发现非 Luna 模型或超额 spawn 时中断该 turn。
- 文件 API 隐藏并拒绝 `.codex`；开始 turn 前还会拒绝项目内的自定义 agent 或 `[agents]` 覆盖，防止员工通过项目配置绕过上述角色策略。
- 同一 chat 的 EDIT/EXECUTE 不能重入；同一 `project_access` 的不同 chat 可并行，排队、停止、自动 approval 和 execution lease 全部进入确定终态后才释放。并发任务修改同一文件时可能产生覆盖或构建冲突。

## 对话恢复

- SSE 帧带持久事件 id；刷新后按 run 与 `Last-Event-ID` 重放 queued/status/approval/tool/plan/diff 元数据/final/terminal 等语义事件。
- 逐 token assistant/reasoning、命令正文、文件内容和 raw diff 不写事件日志；终态 assistant/error 由 `messages` 确定性快照兜底。
- 原 thread 恢复失败不会静默创建新 thread。页面会显示显式恢复卡片；新建空白 thread 必须确认上下文断裂，并保存 old/new lineage。

## 模式和批准

- EDIT 可读写项目，但 `workspace_exec` 在服务端强制拒绝。
- EXECUTE 可读写项目并执行命令；命令通过登录用户、chat、turn run、active access、cwd 和网络策略校验后自动进入项目绑定的 Seatbelt，不要求浏览器逐次批准。
- 每个 chat 独立持久化模式，新建和迁移后的 chat 默认 EXECUTE；切换一个对话不会改变其他对话。
- 原生 `turn/plan/updated`、`turn/diff/updated` 和 collab item 直接转发到浏览器；合法 file/command approval 自动记录 accepted，越界或错误模式继续拒绝。
- task goal 以原生 goal 持久化，但状态保持 `paused`：它仍会进入 Codex 上下文并可在页面查看，同时避免 App Server 在 Portal 的 root/EXECUTE lease 调度器之外自动续跑。

## 协议锁定

`protocol/generated/` 是由本机 `codex-cli 0.150.0-alpha.8` 直接生成的 TypeScript 协议。App Server 初始化时会核对同一版本，不匹配则拒绝就绪；`test/protocol.test.mjs` 检查本项目依赖的方法、事件和字段。升级 Codex 二进制时应重新生成 schema、同步固定版本并先通过契约测试。启动脚本会区分 Web 已监听、Codex 正在启动和 Codex 启动失败，协议不匹配时会立即显示原因，不再无提示等待 60 秒。

## 角色入口与分享历史

老板本地入口为 [老板登录](http://127.0.0.1:4310/boss/login)，员工为 [员工登录](http://127.0.0.1:4310/employee)。公网在同一 HTTPS 域名后分别加 `/boss/login`、`/employee`；`PUBLIC_ORIGIN` 仍只配置 origin，不含这些路径。老板登录后进入 `/boss`，自己的项目工作台位于 `/boss/workbench`。

新 share 会把老板在该项目已有的所有对话与文件一并分享。每名员工获得独立 Git worktree 与独立 Codex 对话副本，可以直接从历史继续；后续员工和老板的聊天相互独立，文件也不会自动写回，任务验收交付仍通过 submission。分享要求老板工作区空闲；任何对话 fork 失败则整次授权失败，可排查后重试。恢复保留的旧授权会继续使用员工原有对话，不重新复制或覆盖；升级前已有的 active 授权不会被自动补发历史。
