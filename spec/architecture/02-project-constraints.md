# 02 项目强制约束

本文件集中定义项目不得被普通功能修改破坏的边界。约束编号用于实施报告、测试和代码评审引用。

## 产品与权限约束

- **PRD-001**：项目是内容 ACL 边界；chat、task、文件和运行必须落在当前有效的 owner/shared access 上。
- **PRD-002**：平台 `admin` 只提供账号与全局元数据管理能力，不自动获得员工自有项目内容权限；任何文件、chat 或 turn 内容仍须以该会话用户的有效 `project_access` 授权。当前唯一超级管理员可以设置员工新密码并使其既有会话失效；使用员工账号与该新密码重新登录将按员工自身权限访问内容。这是明确接受的账号接管/恢复能力，不是管理员直接绕过内容 ACL，系统不承诺员工内容对超级管理员保密。
- **PRD-003**：chat transcript 默认只属于创建者。共享同一项目、roadmap 或 worktree 不授予读取其他用户原 chat 的能力。唯一例外是 owner 显式新 share：将该项目 owner 已有全部 chat 一次性 fork 为接收者私有副本；后续不自动同步。
- **PRD-004**：跨人员交付经过 task/submission、显式 share 时的一次性 thread fork 或未来 artifact/handoff；禁止裸 `inject_items`、实时全量 transcript 同步或共用原 thread id。
- **PRD-005**：当前仅支持一个超级管理员和多个普通员工；不能从现有角色模型推导组织、多老板或细粒度 viewer/reviewer 权限。
- **PRD-006**：EDIT/EXECUTE 偏好属于 chat，不能由同项目其他 chat 的选择隐式改变；新建和迁移后的 chat 默认 EXECUTE。普通项目采用同一项目内自动放行策略；隐私项目独立 controlMode 默认 manual，不能由其他 chat 改变。
- **PRD-007**：长期记忆以 `user_id` 私有；同一用户仅可跨其当前仍有有效 access 的普通来源项目召回。隐私项目记忆额外以 project_id 隔离，只在本项目多 chat 共享；普通/隐私及不同隐私项目双向隔离。`admin` 无记忆读取旁路；chat 独立控制搜索/管理，planner/reviewer 禁止记忆。
- **PRD-008**：若 owner chat 曾引用可用的跨项目记忆，`files_and_history` 分享必须显式确认并绑定接收者、chat/引用快照；快照变化、重复使用或超时必须拒绝。若引用已因删除或来源撤权而失效，必须先显式重置 chat，不能继续分享其历史。

- **PRD-009**：project_type 创建后不可变。local_private 只由活动老板本人创建、访问；禁止员工授权、分享、工作图/task/规划审核及 Codex thread 绑定。不得转换旧项目或隐式回退 Codex。完整契约见 [本地隐私项目](10-local-private-projects.md)。
- **PRD-010**：老板微信 `weichat-project` 是固定消息归属和只读项目入口。只有该项目内存在 active 微信 binding 的老板 chat 可列出、读取和搜索当前老板本人拥有的 standard 项目；员工自有项目、仅 shared access、local_private、本机未纳管目录以及跨项目写入/命令必须拒绝。

## 运行平台约束

- **RUN-001**：支持平台是 macOS；命令隔离依赖 `sandbox-exec`/Seatbelt。Node.js 必须为 22.13 或更高。
- **RUN-002**：Portal 必须只监听 `127.0.0.1`、`localhost` 或 `::1`；公网访问必须经过 HTTPS 隧道。
- **RUN-003**：Codex app-server 必须通过后端 stdio JSON-RPC 使用，不得把原始 RPC 或非回环 app-server WebSocket 暴露给浏览器。
- **RUN-004**：默认启动成功要求 HTTP、Codex initialize 和 Portal skill 同时 ready。显式启用本地引擎时，HTTP + 本地 ready 可提供隐私项目的部分能力，不等于普通 Codex ready；health 必须分开报告两个引擎。模型目录健康不是推理验收。
- **RUN-005**：服务与隧道默认由独立 launchd job 管理；Documents 后台权限受限时可显式设置 HARNESS_PROCESS_MODE=detached，统一脚本记录并复验 PID、启动时间与完整命令后管理后台进程。detached 不承诺开机自启或崩溃自动拉起。PID 文件只能引用经过身份校验的本项目进程。
- **RUN-006**：Portal 启动的 Codex app-server 必须关闭 `memories` feature，并固定 `memories.generate_memories=false` 与 `memories.use_memories=false`；相同配置必须覆盖 start/resume/fork 与子代理，且 `config/read` 生效值验证通过后才可 ready。浏览器、项目配置和运营开关不得重新开启原生记忆。

## 协议约束

- **PRO-001**：`src/config.mjs`、`protocol/version.json` 和 `protocol/generated/` 必须对应同一个精确 Codex CLI 版本。
- **PRO-002**：升级 CLI 前必须用该二进制重新生成 schema，并验证 Portal 使用的 request、server request、notification 和 `ThreadItem` 字段仍存在。
- **PRO-003**：运行时 `initialize.userAgent` 不匹配精确 pin 时必须拒绝 ready；禁止用宽松 semver 静默接受未验证协议。
- **PRO-004**：协议不匹配必须快速、可诊断地失败，不能表现为无信息的 60 秒卡住。

## 文件与执行约束

- **FS-001**：一般浏览器文件接口和 dynamic tool 只能使用项目相对路径；绝对路径、`..`、保留目录和越界符号链接必须拒绝。唯一输入兼容例外是任务交付入口：允许当前任务员工 access 内的绝对文件路径，服务端转换为项目相对路径后继续走普通文件/快照校验，不扩大可访问根。保留目录匹配必须先规范化并忽略大小写，以覆盖默认大小写不敏感的 macOS 文件系统。实际文件 CRUD 必须在只允许当前项目及本次回收站目标的 Seatbelt helper 中完成，不能依赖主进程“先检查路径、后裸打开”的竞态窗口。
- **FS-002**：`.git`、`.codex` 及共享 worktree 的 Git indirection 不得通过文件 API、workspace tool、原生 file-change approval 或 Seatbelt 暴露；原生 approval 无法取得完整目标集合时必须拒绝。
- **FS-003**：共享项目必须为每个 active 员工建立独立 `project_access` 和 worktree；同一项目同一员工最多一个 active access。新授权必须先把 owner 当前 Git 可见的 tracked/untracked/删除状态提交为不可变基线，并将 `base_sha` 返回和持久化；不能从旧 HEAD 建树后留下一个未绑定的易变 patch。
- **FS-004**：同一 chat 任一时刻最多一个 active root turn；同一 access/worktree 的不同 chat 可以并发。浏览器文件修改、submission 快照与 owner delivery 必须等待整个 access/worktree 空闲。浏览器编辑器覆盖既有文件时必须携带读取所得 SHA-256 `If-Match` 版本；stale save 返回 `FILE_VERSION_CONFLICT`，不能静默覆盖另一标签页或先前写入。并发 turn/命令若修改同一文件可能相互观察或覆盖，当前不承诺自动冲突解决。
- **FS-005**：删除文件或项目默认移动到项目 trash，不能在普通 Web 流程中不可恢复销毁。
- **FS-006**：命令环境不得继承 Portal、隧道、Codex 或其他项目秘密；新普通账号默认联网，可在创建或之后按用户关闭，既有账号的联网位不随默认值改变。隐私项目命令一律禁网。仅获准联网的普通项目使用当前系统 HTTP/HTTPS 代理或显式无凭据代理；禁网也禁止连接本地代理。命令 `HOME`/`TMPDIR` 按 user.id + project_access.id 隔离，不能跨项目复用。
- **FS-007**：项目 HTML 必须默认以可切回源码的受限 iframe 渲染。iframe 与 HTML HTTP 响应都必须 sandbox，禁止 `allow-same-origin`、表单、弹窗、顶层导航、嵌套 frame、worker 和网络 API；不得为了预览把项目脚本提升为 Portal 同源脚本，或绕过 `project_access`、canonical path 与文件读取边界。

## 数据与生命周期约束

- **DAT-001**：submission 的不可变证据不能因 chat 或 turn 删除而消失；外键允许置空，但快照必须保留。
- **DAT-002**：包含 submission 的 chat 必须拒绝删除，除非未来提供具有等价证据保留语义的归档操作。
- **DAT-003**：resume 失败必须保留旧 thread id；只有成功重试或明确确认历史断裂的 reset 才能切换映射。
- **DAT-004**：撤权、停用、改密、chat/project 删除必须处理中断、审批、子代理和 lease，并等待或拒绝，不能与活跃写入并发清理。用户级中断必须覆盖 capacity queue、thread/skill setup 和 active turn，并在响应前等待持久终态或返回明确 drain timeout。
- **DAT-005**：服务重启必须把遗留的 queued/starting/running run 转为确定的 interrupted 终态，取消 pending approval，清理 lease 并写恢复事件。
- **DAT-006**：事件和审计不得记录 prompt、密码、token、命令正文、文件正文、模型逐 token 输出或 raw diff。
- **DAT-007**：新 task submission 必须绑定原 `project_access.id`、不可变 Git commit 和 tree；`passed` 审核必须先把该快照合入 owner 并记录 delivery commit。merge 失败时 submission 保持 pending，不能只推进任务状态。
- **DAT-008**：SQLite 是用户记忆、来源与每轮引用的唯一事实源；Markdown、Milvus Lite 和 embedding 都是可重建派生物。每次注入前必须按 owner、active 状态和全部来源项目的当前 access 复验；删除、编辑、撤权或项目删除必须立即阻止旧候选使用，并把已引用旧值的 native chat 标为需要显式 reset。
- **DAT-009**：普通/task root 由模型自主调用 `memory_search/add/update/delete`；Portal 不再每轮自动注入或按关键词后置提取。身份及来源由服务端绑定；搜索与写入分别受 chat 开关控制，planner/reviewer 与子代理不得调用。写入工具成功即持久化，不依赖最终 turn 成功；更新/删除必须校验版本，秘密模式命中不得保存，不得回填旧历史，正文不得进入 audit、turn event 或服务日志。

## 容量约束

- **CAP-001**：Codex turn 配置硬上限为 40；Portal active root turn 硬上限为 11。
- **CAP-002**：EXECUTE lease 上限默认等于 Portal active root 上限 11，且绝不能超过 root 上限；运营配置可以调低。超出用户、root 或配置上限的请求必须可排队、可取消并持久化状态。
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
- 每 task/chat 独立 worktree、同文件并发冲突自动解决、PR 或完整代码审核 UI；当前只承诺 access worktree 的提交快照与 `passed` owner merge。
- 任意顶层 chat 实时互发消息或持续 transcript 同步；同一用户的 Portal 记忆召回和显式 share 的一次性完整历史 fork 已纳入支持，但不构成跨用户记忆共享。
- Linux/Windows 命令沙箱兼容性。

## 多人工作图约束

- **WFG-001**：DAG 的员工节点与 root 内部子代理不同；自动分享仅 files_only，不能广播私有 transcript。
- **WFG-002**：自动验收仅可在明确策略、当前权限、任务版本和有效租约下应用；必须先完成 Git delivery 再下发依赖任务。
- **WFG-003**：人工提交不能伪造原生身份，不确定原生调用不得自动重复；详见 [工作图契约](09-human-work-graph.md)。
