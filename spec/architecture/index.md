# 架构规格索引

- 状态：当前有效
- 基线日期：2026-09-05
- 适用范围：当前工作树中的 Portal、SQLite、文件系统、Codex app-server、浏览器工作台与公网隧道

## 阅读顺序

| 文档 | 回答的问题 |
| --- | --- |
| [00 架构总览与决策](00-overview-and-decisions.md) | 系统的目标模型是什么，原审计结论如何取舍？ |
| [01 系统上下文与组件](01-system-context-and-components.md) | 请求经过哪些组件，每个组件负责什么？ |
| [02 项目强制约束](02-project-constraints.md) | 开发、运行、部署和发布时哪些条件不得破坏？ |
| [03 领域模型与不变量](03-domain-model-and-invariants.md) | 用户、项目、授权、对话、运行和任务之间是什么关系？ |
| [04 安全与信任边界](04-security-and-trust-boundaries.md) | 认证、ACL、路径、沙箱、秘密和共享上游账号的边界在哪里？ |
| [05 执行、并发与生命周期](05-execution-concurrency-and-lifecycle.md) | turn 如何排队、加锁、审批、中断和排空？ |
| [06 持久化、事件与恢复](06-persistence-events-and-recovery.md) | 刷新、断线、重启和 thread 恢复时哪些事实能够保留？ |
| [07 端到端发布契约](07-e2e-release-contracts.md) | 哪些行为已经被自动 E2E 或真实公网链路验证？ |
| [08 运维、协议升级与演进](08-operations-protocol-and-evolution.md) | 如何启动、升级 Codex 协议、发布和继续演进？ |

| [09 多人 Work Graph](09-human-work-graph.md) | 真实员工 DAG、自动共享、交付审核与持久调度如何闭环？ |
| [10 老板隐私项目与本地引擎](10-local-private-projects.md) | 不可分享项目、本地 DSH、项目记忆及审批/搜索例外如何隔离？ |
| [11 Portal 交互浏览器与命令环境](11-managed-browser.md) | 独立 Chrome、人工接管、会话清理与通用执行如何受控？ |
| [12 微信渠道与带资料派发](12-weixin-task-dispatch.md) | 多用户微信、不可变资料、工作图派发与接单如何贯通？ |

## 已接受的核心决策

1. 项目是内容 ACL 与共享事实边界。
2. `project_access` 对应的主目录或 Git worktree 是当前写入隔离边界；同一 access 的不同 chat 可并发，但同文件并发修改可能产生业务冲突。
3. 对话是用户私有的推理与交互记录；同项目不意味着原 transcript 互相可读；显式新 share 将 owner 既有历史一次性 fork 为员工私有副本。
4. roadmap、task、绑定 Git commit/tree 的不可变 submission、审核通过后的 owner merge，以及工作图的 artifact/handoff 才是跨对话协作协议。
5. 浏览器只访问 Portal HTTP/SSE，禁止直接访问或选择 Codex JSON-RPC、thread、cwd、tree 或 sandbox policy。
6. 不同 chat 的 root turn 可在同一 access/worktree 并行，默认 EXECUTE 容量与 11 个 Portal root 席一致；浏览器写入、task submission 和 owner delivery 仍要求 access 空闲。系统尚未实现每任务 worktree、自动冲突解决或 PR 工作流。
7. EDIT 只允许项目文件读写，EXECUTE 额外允许项目内命令；chat 独立持久化模式且默认 EXECUTE。通过 ACL、路径和保留目录校验的项目内文件变更与 EXECUTE 命令由 Portal 自动接受，不要求老板或员工逐次点击。
8. 单 App Server、单 `CODEX_HOME`、单上游 Codex 登录只适用于内部互信 Pilot，不宣称敌对租户级隔离。
9. App Server 协议使用精确 CLI 版本 pin，并用该版本重新生成 schema；不能靠模糊版本匹配掩盖协议漂移。
10. Portal 启动的 Codex app-server 原生长期记忆永久关闭并在 ready 前验证；普通项目记忆以 user_id 和当前 access 为边界；隐私项目使用独立 user_id + project_id 作用域，双向禁止跨域召回。
11. 上述共享、Codex 执行及项目内自动放行默认描述普通项目。不可变 local_private 项目只走本地 DSH 适配的回环 OpenAI-compatible 模型（当前为 Qwen）、永不分享，默认人工确认；唯一云端例外为按策略提交的独立搜索词，详见第 10 章。
12. 微信是 transport relay，身份、当前普通项目和消息由 Portal 绑定。旧固定老板 HMAC 入口兼容保留；新增每用户私有 IPC relay、资料和派发均按 [第 12 章](12-weixin-task-dispatch.md) 校验，不开放宿主目录、员工私有内容或隐私项目。
13. 新账号默认联网且可单独关闭，既有网络位保持；系统 VPN 自动适配只服务当前获准联网的普通项目，不绕过禁网或隐私边界。详见第 11 章。

## 变更规则

- 修改代码、测试、协议、脚本、配置或文档前，先阅读本索引和相关专题。
- 每个修改必须在 `spec/report/` 新建或更新一份报告，先写实施计划，结束后补实际结论和验证证据。
- 改变任何“必须”不变量时，必须同时更新架构文件、报告和对应门控测试；不得只改文档或只删测试。
- `07-e2e-release-contracts.md` 中标为自动 E2E 的行为是发布契约。删除、跳过或弱化用例等同于架构变更。
- point-in-time 事实写进 report；长期有效的约束写进 architecture。不要把临时 PID、公网 quick URL 或一次运行日志写成长期架构事实。
