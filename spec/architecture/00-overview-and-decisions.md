# 00 架构总览与决策

## 目标

Codex Harness Remote 把一台已登录 Codex 的 Mac 包装成受控 Web 工作台，让一个老板账号管理多个员工账号、项目授权、任务交付和资源配额，同时把浏览器与本机文件、Codex 原生协议和凭据隔开。

当前产品定位是内部互信 Pilot：Portal 提供可靠的业务 ACL、文件边界、运行调度和审计，但所有用户仍共享一个本机 Codex app-server、`CODEX_HOME`、上游身份和配额。它不是面向恶意、多组织租户的硬隔离平台。

## 超级管理员与内容保密边界

老板以自己的超级管理员会话登录时，不会因 `admin` 角色自动获得员工未分享项目的文件、chat 或 turn 内容权限；这些路由仍按当前会话用户的 `project_access` 判断。

同时，当前内部互信模型赋予唯一超级管理员账号管理与恢复权：管理员可设置员工的新密码。该操作会撤销员工既有会话并排空其运行，但不会改变员工的 project access。持有“员工账号 + 管理员设定的新密码”的人重新登录后，Portal 将其识别为该员工，并按该员工原有授权放行。因此，这是一项有意保留的账号接管能力，不是密码破解，也不是超级管理员会话绕过内容 ACL。

本产品不向员工承诺对超级管理员的绝对内容保密，也不向任何 Portal 用户承诺对宿主 macOS 管理者的内容保密：后者可直接读取其管理的磁盘文件，不经过 Portal 登录或 ACL。若业务要求管理员不能接管员工账号，必须另行设计只由员工掌握的身份验证与恢复渠道；即使如此，仍需使用独立 OS 身份、存储或执行环境解决宿主机管理者的读取能力。

## 推荐协作模型

```text
Project       = 内容权限 + 可版本化共享事实
ProjectAccess = 成员访问 + 当前执行环境绑定
Worktree      = 文件副本 + access 级隔离边界
Chat          = 私有 transcript + Codex thread 映射 + 独立执行模式
Task          = 业务目标 + assignee + version + acceptance
Submission    = 不可变回复/diff + project access + Git commit/tree + owner delivery commit
Artifact/Handoff（未来） = 跨对话、跨人员的显式共享协议
```

禁止把“同项目”直接解释为“所有对话可以互读互写”。共享完整 transcript 会同时扩大权限、隐私、提示注入、上下文膨胀、撤权和来源追踪问题，而且不能解决文件并发。当前系统共享项目文件、任务事实和提交快照；owner 显式新 share 时也把其该项目所有已有对话一次性 fork 给员工，fork 后双方历史继续私有且互不跟随。任务提交会把 assignee 当前 worktree 固定为 Git commit/tree；老板审核 `passed` 时将该固定 commit 合入 owner 项目，合并冲突则保持 pending，不把状态通过误当成交付完成。

## 当前物理架构

系统是一个单体 Portal 进程加一个受管 Codex 子进程：

```text
Browser
  -> HTTPS Tunnel
  -> loopback Portal HTTP/SSE
     -> SQLite
     -> Workspace/Worktree/Sandbox services
     -> CodexService
        -> stdio JSON-RPC
        -> codex app-server
           -> shared local Codex login
```

单体形态不是当前主要风险；职责是否被清晰约束才是关键。现阶段不为“微服务化”拆分进程。只有当产品进入敌对租户、独立上游身份或独立故障域阶段，才需要 per-user/per-tenant worker。

## 原架构审计结论的取舍

| 审计项 | 当前结论 | 处理方式 |
| --- | --- | --- |
| R1 submission 随 chat 删除 | 正确，原实现为 P0 | submission 外键改为 `SET NULL`，保留不可变快照；应用层禁止删除含提交证据的 chat；启动修复历史孤儿状态。 |
| R2 resume 失败覆盖 thread | 正确，原实现为 P0 | 保留旧 thread id，进入 `resume_failed`；仅重试成功或用户确认上下文断裂后切换，并记录 lineage。 |
| R3 单 App Server/共享 `CODEX_HOME` | 正确，但不是本轮可局部消除的问题 | 明确内部互信 Pilot；敌对租户需要独立 worker、OS 身份和上游身份。 |
| R4 同 tree 多 chat 并发写 | 风险成立，但试用要求并发优先 | 允许同 `project_access/worktree` 的不同 chat 并发；同 chat 仍串行，浏览器写入、submission 和 delivery 仍等待 access 空闲，并明确同文件并发冲突风险。 |
| R5 单共享员工与多 assignee 冲突 | 正确，原实现为 P1 | 一个项目允许多名员工同时 active，每名员工拥有独立 access、branch 和 worktree。 |
| R6 SSE 不可恢复 | 正确，原实现为 P1 | 引入持久语义事件 journal、游标重放和前端恢复；敏感大正文不持久化。 |
| R7 messages fallback 未接线 | 正确，原实现为 P1 | user 与终态 assistant/error 使用确定性 ID 写本地快照，`thread/read` 失败时回退。 |
| R8 项目删除与运行竞态 | 正确，原实现为 P1 | chat/access/project 生命周期操作检查 turn、approval、lease 和内存恢复态。 |
| R9 工具与子代理审计不完整 | 正确，原实现为 P1 | 增加脱敏语义事件和审计；不记录 prompt、命令正文、文件内容或 raw diff。 |
| R10 企业身份生命周期 | 正确，仍为 P2 | 邀请、首次改密、自助改密、OIDC/MFA、持久限流和设备会话治理尚未实现。 |

## 没有采纳的建议

- 没有直接开放任意顶层 chat-to-chat 消息、`thread/inject_items` 或持续共享 transcript。
- 没有把每个 task/chat 都变成独立 worktree。同 access 的不同 chat 直接在同一 tree 并发，可能相互观察修改或在同文件上冲突；submission/`passed` 仍提供 access worktree 到 owner 的固定快照 merge，任务级独立基线、自动冲突解决和 PR 尚未实现。
- 没有把平台 `admin` 自动映射为所有项目的内容 owner。
- 没有把 app-server WebSocket 暴露到公网，也没有引入 ACP 代理层。
- 没有宣称 Seatbelt 和 Portal ACL 能替代 VM、容器、磁盘 quota 或独立 OS 用户。

## 后续演进顺序

1. 保持当前数据不变量、恢复和发布门控稳定。
2. 若业务需要并发任务的独立基线或无冲突写入，引入 execution environment 实体、任务级 worktree、同步策略和冲突解决/PR；不能退回只保存回复或易变 worktree 的交付模型。
3. 引入 project membership 角色和显式 artifact/handoff，；显式 share 的 owner 历史 fork 是当前支持的一次性操作。
4. 最后处理组织、OIDC/MFA、持久限流、设备会话和 per-tenant worker。
