# 02 项目强制约束

本文件集中定义项目不得被普通功能修改破坏的边界。约束编号用于实施报告、测试和代码评审引用。

## 产品与权限约束

- **PRD-001**：项目是内容 ACL 边界；chat、task、文件和运行必须落在当前有效的 owner/shared access 上。
- **PRD-002**：平台 `admin` 只提供账号与全局元数据管理能力，不自动获得员工自有项目内容权限。
- **PRD-003**：chat transcript 默认只属于创建者。共享同一项目、roadmap 或 worktree 不授予读取其他用户 chat 的能力。
- **PRD-004**：跨人员交付必须经过 task/submission 或未来显式 artifact/handoff；禁止用裸 `inject_items` 或全量 transcript 同步代替。
- **PRD-005**：当前仅支持一个超级管理员和多个普通员工；不能从现有角色模型推导组织、多老板或细粒度 viewer/reviewer 权限。

## 运行平台约束

- **RUN-001**：支持平台是 macOS；命令隔离依赖 `sandbox-exec`/Seatbelt。Node.js 必须为 22.13 或更高。
- **RUN-002**：Portal 必须只监听 `127.0.0.1`、`localhost` 或 `::1`；公网访问必须经过 HTTPS 隧道。
- **RUN-003**：Codex app-server 必须通过后端 stdio JSON-RPC 使用，不得把原始 RPC 或非回环 app-server WebSocket 暴露给浏览器。
- **RUN-004**：Portal 启动成功的定义是 HTTP、Codex initialize 与 Portal skill 注册同时 ready；`/api/health` 必须区分 `starting`、`failed`、`ready`。
- **RUN-005**：正式服务与隧道由独立 launchd job 管理，PID 文件只能引用经过命令标记校验的本项目进程。

## 协议约束

- **PRO-001**：`src/config.mjs`、`protocol/version.json` 和 `protocol/generated/` 必须对应同一个精确 Codex CLI 版本。
- **PRO-002**：升级 CLI 前必须用该二进制重新生成 schema，并验证 Portal 使用的 request、server request、notification 和 `ThreadItem` 字段仍存在。
- **PRO-003**：运行时 `initialize.userAgent` 不匹配精确 pin 时必须拒绝 ready；禁止用宽松 semver 静默接受未验证协议。
- **PRO-004**：协议不匹配必须快速、可诊断地失败，不能表现为无信息的 60 秒卡住。

## 文件与执行约束

- **FS-001**：浏览器和 dynamic tool 只能使用项目相对路径；绝对路径、`..`、保留目录和越界符号链接必须拒绝。保留目录匹配必须先规范化并忽略大小写，以覆盖默认大小写不敏感的 macOS 文件系统。
- **FS-002**：`.git`、`.codex` 及共享 worktree 的 Git indirection 不得通过文件 API、workspace tool、原生 file-change approval 或 Seatbelt 暴露；原生 approval 无法取得完整目标集合时必须拒绝。
- **FS-003**：共享项目必须为每个 active 员工建立独立 `project_access` 和 worktree；同一项目同一员工最多一个 active access。
- **FS-004**：同一 access/worktree 任一时刻最多一个 active root turn，浏览器文件修改必须等待 worktree 空闲。
- **FS-005**：删除文件或项目默认移动到项目 trash，不能在普通 Web 流程中不可恢复销毁。
- **FS-006**：命令环境不得继承 Portal、隧道、Codex 或其他项目秘密；网络访问默认关闭并按用户授权。

## 数据与生命周期约束

- **DAT-001**：submission 的不可变证据不能因 chat 或 turn 删除而消失；外键允许置空，但快照必须保留。
- **DAT-002**：包含 submission 的 chat 必须拒绝删除，除非未来提供具有等价证据保留语义的归档操作。
- **DAT-003**：resume 失败必须保留旧 thread id；只有成功重试或明确确认历史断裂的 reset 才能切换映射。
- **DAT-004**：撤权、停用、改密、chat/project 删除必须处理中断、审批、子代理和 lease，并等待或拒绝，不能与活跃写入并发清理。用户级中断必须覆盖 capacity queue、thread/skill setup 和 active turn，并在响应前等待持久终态或返回明确 drain timeout。
- **DAT-005**：服务重启必须把遗留的 queued/starting/running run 转为确定的 interrupted 终态，取消 pending approval，清理 lease 并写恢复事件。
- **DAT-006**：事件和审计不得记录 prompt、密码、token、命令正文、文件正文、模型逐 token 输出或 raw diff。

## 容量约束

- **CAP-001**：Codex turn 配置硬上限为 40；Portal active root turn 硬上限为 11。
- **CAP-002**：同时有效的 EXECUTE lease 最多 2；额外 EXECUTE 请求必须可排队、可取消并持久化状态。
- **CAP-003**：每个 root 原生子代理并发最多 3，默认模型固定为 `gpt-5.6-luna`。
- **CAP-004**：员工项目数硬上限为 100；用户并发、存储、命令时间和输出大小仍受各自配置限制。
- **CAP-005**：存储配额对 Portal 文件 API 是写前硬限制，active workspace/worktree 与该用户可恢复 trash 都必须计入；任意 shell 产生文件目前只能执行后观测，不能宣称硬磁盘 quota。

## 开发与发布约束

- **DEV-001**：每次仓库修改必须在 `spec/report/` 留下实施计划和最终结论；同一目标的连续修改可以更新同一报告。
- **DEV-002**：架构、不变量、公开接口、schema、迁移或 E2E 契约变化必须同步更新对应 spec。
- **DEV-003**：合并或发布前必须在具备 loopback bind 与 Seatbelt 的 macOS 主机运行 `npm run gate`；不得用跳过测试替代门控。
- **DEV-004**：不得删除、跳过或弱化固定 E2E 来迁就实现。确需改变契约时，必须先在报告中写明架构理由和替代验证。
- **DEV-005**：迁移必须幂等并优先使用兼容的 `ADD COLUMN`、`CREATE TABLE IF NOT EXISTS`、显式索引迁移；不能假设旧二进制可安全读取新模型。
- **DEV-006**：源码、spec、report、日志示例和测试输出中禁止写真实密码、session token、隧道 token 或 Codex 凭据。

## 明确未承诺

- 敌对互联网多租户、组织级数据隔离或按用户独立上游计费。
- OIDC、MFA、邀请、首次强制改密、用户自助改密、设备会话管理。
- 每 task/chat 独立 worktree、自动 commit、merge、冲突解决、PR 或代码审核工作流。
- 任意顶层 chat 实时互发消息、共享完整 transcript 或跨 chat 共享隐式 memory。
- Linux/Windows 命令沙箱兼容性。
