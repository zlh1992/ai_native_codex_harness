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

## 已接受的核心决策

1. 项目是内容 ACL 与共享事实边界。
2. `project_access` 对应的主目录或 Git worktree 是当前写入隔离和单写者边界。
3. 对话是用户私有的推理与交互记录；同项目不意味着 transcript 互相可读。
4. roadmap、task、不可变 submission、版本化项目文档，以及未来的 artifact/handoff 才是跨对话协作协议。
5. 浏览器只访问 Portal HTTP/SSE，禁止直接访问或选择 Codex JSON-RPC、thread、cwd、tree 或 sandbox policy。
6. 当前采用“同一 access/worktree 全部 root turn 串行，不同 access 并行”的最小方案；尚未实现每任务 worktree、自动 merge 或 PR 工作流。
7. 单 App Server、单 `CODEX_HOME`、单上游 Codex 登录只适用于内部互信 Pilot，不宣称敌对租户级隔离。
8. App Server 协议使用精确 CLI 版本 pin，并用该版本重新生成 schema；不能靠模糊版本匹配掩盖协议漂移。

## 变更规则

- 修改代码、测试、协议、脚本、配置或文档前，先阅读本索引和相关专题。
- 每个修改必须在 `spec/report/` 新建或更新一份报告，先写实施计划，结束后补实际结论和验证证据。
- 改变任何“必须”不变量时，必须同时更新架构文件、报告和对应门控测试；不得只改文档或只删测试。
- `07-e2e-release-contracts.md` 中标为自动 E2E 的行为是发布契约。删除、跳过或弱化用例等同于架构变更。
- point-in-time 事实写进 report；长期有效的约束写进 architecture。不要把临时 PID、公网 quick URL 或一次运行日志写成长期架构事实。
