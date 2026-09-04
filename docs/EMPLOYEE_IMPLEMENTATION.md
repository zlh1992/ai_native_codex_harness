# 员工端实施说明

本分支把 `work.md` 中的员工交付链路落实为四道相互独立的边界：

1. `project_access` 决定员工能否看到项目；共享项目始终绑定独立 Git worktree。
2. `chats.project_access_id + chats.tree_path` 固定 Codex thread 的项目树，旧页面不能在撤权后继续使用。
3. `turn_runs` 保存 Portal 所需的运行状态和提交快照；完整对话仍由 Codex thread 持久化，页面通过 `thread/read` 重建历史。
4. `task_submissions` 对最终 `item/completed`、turn diff 和任务版本做不可变快照，Codex goal 完成不会自动把业务任务判为通过。

员工项目数在配置、管理员接口和创建项目入口三层硬限制为 100；老板账号不受该员工上限影响。

## 容量规则

- App Server 全局绝对上限保留为 40。
- Portal 同时运行的 root turn 上限为 11。
- EXECUTE 使用 2 个持久化 lease；第 3 个请求进入可取消队列。
- EDIT 不占 EXECUTE lease，即使 EXECUTE 队列存在也可在 root 容量内继续运行。
- 每个 root thread 的原生子代理并发上限为 3，默认模型固定为 `gpt-5.6-luna`；Portal 用同一份只读配置层覆盖原生 `default`、`worker`、`explorer` 三个角色，避免显式 spawn 改用更贵模型，并检查可见的原生 collab item，发现非 Luna 模型或超额 spawn 时中断该 turn。
- 文件 API 隐藏并拒绝 `.codex`；开始 turn 前还会拒绝项目内的自定义 agent 或 `[agents]` 覆盖，防止员工通过项目配置绕过上述角色策略。

## 模式和批准

- EDIT 可读写项目，但 `workspace_exec` 在服务端强制拒绝。
- EXECUTE 的命令必须先由浏览器批准，再进入项目绑定的 Seatbelt 沙箱。
- 原生 `turn/plan/updated`、`turn/diff/updated`、file/command approval 与 collab item 直接转发到员工浏览器。
- 批准接口按登录用户、chat、turn run 和项目 ACL 四重绑定，不能用其他员工的 approval ID 越权。
- task goal 以原生 goal 持久化，但状态保持 `paused`：它仍会进入 Codex 上下文并可在页面查看，同时避免 App Server 在 Portal 的 root/EXECUTE lease 调度器之外自动续跑。

## 协议锁定

`protocol/generated/` 是由本机 `codex-cli 0.148.0-alpha.9` 直接生成的 TypeScript 协议。App Server 初始化时会核对同一版本，不匹配则拒绝就绪；`test/protocol.test.mjs` 检查本项目依赖的方法、事件和字段。升级 Codex 二进制时应重新生成 schema、同步固定版本并先通过契约测试。
