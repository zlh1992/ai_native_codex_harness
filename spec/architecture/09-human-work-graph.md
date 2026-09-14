# 09 多人 Work Graph

本章仅适用于 standard 项目。local_private 永不可分享，也不创建工作图、任务或规划/审核运行；UI 下拉框须排除它，直接 HTTP/业务服务调用仍必须拒绝。见 [隐私项目](10-local-private-projects.md)。

## 业务模型

Work Graph 编排真实员工交付，Codex root 内部的子代理不构成员工节点。保留 `roadmaps.kind=linear` 的旧顺序契约；`dag` 采用不可变 `graph_plan_versions` 与独立 `workflow_runs`。一个项目最多一个 preparing/running/paused 图；一个图内同一员工最多一个 active/rework/submitted 节点，工作树仍按 access 隔离。

图最多 32 节点、96 条边；节点有固定员工、验收标准、清单、成果相对路径、可选截止时间。必须无环、依赖完整，并汇合到唯一 completionGate 最终交付节点。最终节点仍由员工完成并验收。草稿修改创建新版本，活动运行不能在线改拓扑；取消后可修订、重新启动，旧任务和证据保留。

员工资料独立于账号策略：岗位、职责、标签、交付偏好、可用性和说明，管理员用 revision 乐观锁维护。资料不能授予权限。生成输入固定为老板授权的项目 Git 快照、受限文本文件及候选员工资料投影；文件省略原因进入 manifest。

员工工作台须持续同步当前 task 状态和版本，而不只刷新任务卡片。已提交、已通过、暂停、取消或旧版本对话不可继续发送/再次提交；保留历史与未发草稿，提供查看审核、返回看板及进入当前返工版本的明确入口。自动共享产生的新项目须在待办出现时同步可见项目列表，不强制切走当前编辑器。任务公开投影包含冻结策略推导的 `reviewMode` 和当前 `workflowStatus`，列表、详情与 chat 上下文保持一致，不公开 assignedAccessId。自动模式不得笼统标成“等待老板验收”。

员工保持打开的只读审核详情也须跟随后台审核状态刷新；有交付草稿、上传或提交操作时不得用轮询重建表单。迟到响应必须核对原详情身份和打开状态，不能覆盖另一任务或重新打开已关闭的弹窗。

员工任务看板提供按工作图 ID 筛选，选项只从当前用户获准的任务投影推导，标明所属项目；保留全部、已完成图、旧线性图与无图任务。筛选与文本搜索组合，轮询保留仍有效的选择，图不再可见时回退全部，退出清空选项与搜索。筛选只改变展示，不变更任务状态、扩大图/对话 ACL 或切换当前编辑器。

## 共享、交付与审核

启动授权包括员工集合、owner/access 与账号策略 epoch、审核策略和调用预算。自动 share 为 files_only，不复制规划或其他私有对话；原显式 files_and_history 分享保留一次性 fork 行为。批量分享持久化准备身份后建树，全部准备成功才在一个 SQLite 事务发布授权，配额失败不发布半批成员。取消只清理从未发布的干净资源，意外脏资源保留。

员工勾选清单并提交人工成果，或选择本任务版本的 Codex 最终回复。清单全勾不等同验收通过。manual 的原生 thread/turn/item 均为空，codex 必须绑定真实 completed turn；数据库 CHECK 防止两种身份混淆。每个 task/version 仅一个不可变 submission，幂等键防止重复提交。

新界面提供 assisted（AI 给意见，老板决定）、auto（AI 自动通过/打回）两种模式，最终节点可单独选择，草稿节点可设置可选 reviewMode 覆盖默认模式。覆盖由老板编辑并在不可变 plan/start 授权中冻结，模型生成计划的同名字段被剥离。旧 manual 数据/接口继续保留原有不调用 AI 的语义；不自动升级既有运行。AI 意见逐项给出状态、反馈和来自固定提交的证据引用；assisted 由老板决定，auto 才可自动应用。缺少可读产物、需独立验证、无关工作混入、调用预算或返工上限到达时交给老板。模型声明不能代替独立测试。

员工可多选/拖拽文件，提交时经原有文件 PUT、配额与工作区空闲屏障写入独立 deliveries/task/version/随机目录，或在卡片中选定的必交文件位置；禁止静默覆盖已有不同内容，相同内容只复用。再与必交文件、逐行工作区路径一起校验、去重，最多 30 个文件和 32 MiB。一般文件 API 保持相对路径，交付校验入口额外接受当前 task access 根内绝对路径并立即转为相对路径。部分上传失败保留成功文件以便重试；移除本次确认新建的上传项使用既有可恢复删除，复用的既有文件不删除。关闭页面不自动删除文件。上传目录不是秘密目录；提交仍固定整个 worktree，manifest 决定展示和审核范围，不改变既有 Git merge 范围。

reviewer 在本轮先获取固定内容，read proof 绑定 job/turn 并只存覆盖元数据。文件内容不写入 job/audit/event。文本和 PDF 文本层、DOCX 正文共享 64 KiB 文本预算；PDF 最多 100 页，文档子进程最多 10 秒、JS 堆 256 MiB，单次上下文约 30 秒提取预算（在当前文件结束后检查）。扫描页、图片/嵌入内容、空文本、解析失败或预算截断记为不完整并转人工；不能把文本提取当作版式、法律正确性或执行结果验证。有附件的 AI 通过意见必须引用本轮读取的文件。覆盖记录进入审核业务详情，自动应用时再次检查完整性。

审核上下文还须包含当前任务激活时 `inputManifest` 冻结的上游成果正文，而不只提供摘要。读取前校验同项目、同运行、依赖、task/version、已通过 submission 和 handoff/delivery 绑定，从各自 submission commit/hash 读取，绝不读取 owner 或员工当前工作区。上游与当前成果共用上述总预算，解析后重新验证当前授权、任务版本、提交待审与上游绑定。上游引用使用 `upstream:<submissionId>:<path>`，由 `files[].evidenceRef` 提供，避免同名路径混淆；root read proof、proposal 与 auto apply 均验证获准引用/覆盖。所有本次输出和被引用上游必须完整读取；清单需要但不可读的上游证据由模型标记 needs_human，不相关上游附件不自动增加验收要求。不能据此读取私有对话或扩大到项目其他文件。

passed 必须先完成既有 Git owner delivery，再原子写 verdict、handoff、事件与推进意图。rework 增加任务版本，保留旧提交、审核意见，失败清单项复位。下游只有在全部前序 passed 且 handoff 齐全、工作区空闲、员工工作树可从 owner HEAD 干净 fast-forward 后才 active；禁止强制 reset、自动覆盖脏文件或消除分叉。

成果读取绑定 submission 的 commit/hash/manifest，不读取提交者当前文件。owner、提交者及实际收到该 handoff 的下游员工可读；仍要求当前项目访问权。提交后老板无需等待通过即可查看附件，只有通过才合入工作区。文本预览转义显示，下载为 attachment + octet-stream + nosniff + sandbox CSP，不执行 HTML。preview=1 仅按文件签名字节识别 PNG/JPEG/GIF/WebP 并以 nosniff + sandbox CSP 输出，SVG/HTML 不进入图片预览面。无同项目私有 transcript 广播。

## 后台执行与恢复

`workflow_jobs` 承担 plan.generate、share.prepare、submission.review、review.apply、workflow.reconcile、task.overdue。租约 token、generation、task/version、submission 和账号 epoch 在调用/应用边界复验。暂停、取消改变 generation 并排空相关运行；停用、改密、网络策略变化使旧授权失效，撤权也排空针对该员工的后台审核。

调度每秒领取工作，每 30 秒做数据库补偿和到期检查。无业务变化不调用模型。最多四个后台工作同时执行，其中模型工作最多一个，模型仍使用既有 root 配额和 Codex runTurn；容量等待不消耗失败次数，普通错误指数退避，不确定原生投递进入 needs_attention。

只有 Portal 启动恢复租约，维护 CLI 打开数据库不修改活跃 job。已持久化 completed 原生运行及结构化结果可恢复后续步骤；其余不确定 native 调用不得盲目重发，老板核对后台私有对话并明确确认后才重试。输入队列原有“不确定输入不得自动续发”契约不变。后台对话保留，不能从普通 chat 删除入口移除。

planner/reviewer purpose 仅提供固定上下文和结构化提交工具；无 workspace 写入/命令工具，原生写入与命令 approval 也拒绝。结果须由当前 root 提交。employee task purpose 可读取当前任务简报、审核反馈与允许的 handoff，实际勾选/提交由员工发起。

规划恢复例外限于：身份匹配、具有 native turn id、明确 failed、错误匹配响应流 Transport/network failure 且无业务回执。该受管 planner 唯一写操作与回执原子提交，因此可在有效租约下 CAS 解绑旧 turn，保留原 chat/turn 历史，按既有指数退避和 max_attempts 有界重试。attempt 是调度次数，不等于模型调用次数。审核、未知错误、active、重启中断或租约丢失不扩大自动重放权限。completed 但未提交业务结果直接进入人工处理，不能假装已成功。

completed + 回执继续恢复；planner 的 failed + 已提交计划回执也直接恢复后续步骤，不重建图。手动 retry 不得清空任何回执；仍活跃、身份缺失或无法安全复用的回执拒绝重调，即使勾选确认也不旁路。无回执的其他明确终态仍需显式确认。运行权限与账号 epoch 在恢复边界复验。

owner job API 返回恢复分类、当前配置模型/强度、实际调用次数、运行状态、起止时间、最近工具活动时间、回执标记及私有 chat id；不返回原始错误正文或 native thread id。配置模型不冒充历史模型记录。页面顶部显示摘要状态，下方只在待处理时展示原因与恢复操作；只有不确定重调需要确认，轮询保留勾选，后台记录通过原 chat ACL 只读查看。记录不等于结构化结果成功，不向员工广播。

## 持久化与接口

新增 employee_profiles、graph_plan_versions、workflow_runs、workflow_jobs、task_reviews、task_handoffs、project_events；对 roadmap/task/chat/user/submission 做幂等扩展。submission 重建保持原有记录、唯一性和 SET NULL 外键，并执行 foreign_key_check。历史 linear 数据不转换成可执行 DAG。

主要 Portal 接口：

| 接口 | 用途 |
| --- | --- |
| `/api/admin/users/:id/profile` GET/PATCH | 资料与 revision |
| `/api/projects/:id/work-graphs` GET/POST | 项目图列表/结构化草稿 |
| `/api/projects/:id/work-graphs/generate` POST | 持久规划请求 |
| `/api/projects/:id/work-graphs/candidates` GET | owner 候选人员投影 |
| `/api/work-graphs/:id` GET | 按角色裁剪的图及后台状态 |
| `/api/work-graphs/:id/plan` GET/PATCH | 草稿版本 |
| `/api/work-graphs/:id/start\|pause\|resume\|cancel` POST | 显式运行状态变化 |
| `/api/tasks/:id/checklist` PATCH | 任务版本 + 清单 revision |
| `/api/tasks/:id/submissions` POST | 人工/Codex 幂等提交 |
| `/api/tasks/:id/delivery-files` POST | 当前 taskVersion 的必交/额外文件校验、绝对转相对、大小与数量检查 |
| `/api/tasks/:id/handoffs` GET | 当前任务获准上游成果 |
| `/api/task-submissions/:id/artifact` GET | 固定文件预览/下载 |
| `/api/admin/task-submissions/:id/review` POST | 老板验收，要求 expectedVersion |
| `/api/work-graph-jobs/:id` GET、`/retry` POST | owner 状态/明确重试 |
| `/api/projects/:id/events` GET | 按接收者 ACL 的游标 SSE/JSON |

所有 mutation 保留 session、CSRF、Origin 与异步复验。事件只记录安全标识、状态、版本、错误码；内容保存在受 ACL 保护的业务记录，不能进入 audit/journal。SSE 每次投递复验 session 与原 access，附带心跳。

老板端默认把同一张图投影为任务看板，并保留依赖图、状态列表和事件记录：看板按待开始、进行中、待验收、返工/阻塞、已通过分列；依赖图保留 DAG 连线、双向滚动与缩放；状态列表强调任务负责人和当前状态；事件记录倒序展示推进变化。三种任务投影的节点必须打开同一份任务详情。当前视图必须可辨识，缩放只在依赖图启用；长标题不得静默截断，固定尺寸节点和多任务看板必须提供可见内容的纵向滚动能力。

任务状态以服务端工作图为准，拖动/键盘仅调整同列个人显示顺序，禁止通过跨列拖动绕开交付、审核、版本和依赖状态机。老板团队管理中的员工看板按资料中可用性与账号停用状态分列，不把“可安排”误称为实时空闲；点击卡片复用原账号/资料编辑流程。该页 API 可返回员工 profile 元数据，不新增老板读取员工私有内容的权限。

运行开关与回滚见 [操作说明](../../docs/WORK_GRAPH.md)。新增契约见 [发布要求](07-e2e-release-contracts.md)。
