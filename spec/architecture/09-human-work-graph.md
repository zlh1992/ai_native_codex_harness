# 09 多人 Work Graph

## 业务模型

Work Graph 编排真实员工交付，Codex root 内部的子代理不构成员工节点。保留 `roadmaps.kind=linear` 的旧顺序契约；`dag` 采用不可变 `graph_plan_versions` 与独立 `workflow_runs`。一个项目最多一个 preparing/running/paused 图；一个图内同一员工最多一个 active/rework/submitted 节点，工作树仍按 access 隔离。

图最多 32 节点、96 条边；节点有固定员工、验收标准、清单、成果相对路径、可选截止时间。必须无环、依赖完整，并汇合到唯一 completionGate 最终交付节点。最终节点仍由员工完成并验收。草稿修改创建新版本，活动运行不能在线改拓扑；取消后可修订、重新启动，旧任务和证据保留。

员工资料独立于账号策略：岗位、职责、标签、交付偏好、可用性和说明，管理员用 revision 乐观锁维护。资料不能授予权限。生成输入固定为老板授权的项目 Git 快照、受限文本文件及候选员工资料投影；文件省略原因进入 manifest。

## 共享、交付与审核

启动授权包括员工集合、owner/access 与账号策略 epoch、审核策略和调用预算。自动 share 为 files_only，不复制规划或其他私有对话；原显式 files_and_history 分享保留一次性 fork 行为。批量分享持久化准备身份后建树，全部准备成功才在一个 SQLite 事务发布授权，配额失败不发布半批成员。取消只清理从未发布的干净资源，意外脏资源保留。

员工勾选清单并提交人工成果，或选择本任务版本的 Codex 最终回复。清单全勾不等同验收通过。manual 的原生 thread/turn/item 均为空，codex 必须绑定真实 completed turn；数据库 CHECK 防止两种身份混淆。每个 task/version 仅一个不可变 submission，幂等键防止重复提交。

新界面提供 assisted（AI 给意见，老板决定）、auto（AI 自动通过/打回）两种模式，最终节点可单独选择，草稿节点可设置可选 reviewMode 覆盖默认模式。覆盖由老板编辑并在不可变 plan/start 授权中冻结，模型生成计划的同名字段被剥离。旧 manual 数据/接口继续保留原有不调用 AI 的语义；不自动升级既有运行。AI 意见逐项给出状态、反馈和来自固定提交的证据引用；assisted 由老板决定，auto 才可自动应用。缺少可读产物、需独立验证、无关工作混入、调用预算或返工上限到达时交给老板。模型声明不能代替独立测试。

员工可多选/拖拽文件，提交时经原有文件 PUT、配额与工作区空闲屏障写入独立 deliveries/task/version/随机目录，或在卡片中选定的必交文件位置；禁止静默覆盖已有不同内容，相同内容只复用。再与必交文件、逐行工作区路径一起校验、去重，最多 30 个文件和 32 MiB。一般文件 API 保持相对路径，交付校验入口额外接受当前 task access 根内绝对路径并立即转为相对路径。部分上传失败保留成功文件以便重试；移除本次确认新建的上传项使用既有可恢复删除，复用的既有文件不删除。关闭页面不自动删除文件。上传目录不是秘密目录；提交仍固定整个 worktree，manifest 决定展示和审核范围，不改变既有 Git merge 范围。

reviewer 在本轮先获取固定内容，read proof 绑定 job/turn 并只存覆盖元数据。文件内容不写入 job/audit/event。文本和 PDF 文本层、DOCX 正文共享 64 KiB 文本预算；PDF 最多 100 页，文档子进程最多 10 秒、JS 堆 256 MiB，单次上下文约 30 秒提取预算（在当前文件结束后检查）。扫描页、图片/嵌入内容、空文本、解析失败或预算截断记为不完整并转人工；不能把文本提取当作版式、法律正确性或执行结果验证。有附件的 AI 通过意见必须引用本轮读取的文件。覆盖记录进入审核业务详情，自动应用时再次检查完整性。

passed 必须先完成既有 Git owner delivery，再原子写 verdict、handoff、事件与推进意图。rework 增加任务版本，保留旧提交、审核意见，失败清单项复位。下游只有在全部前序 passed 且 handoff 齐全、工作区空闲、员工工作树可从 owner HEAD 干净 fast-forward 后才 active；禁止强制 reset、自动覆盖脏文件或消除分叉。

成果读取绑定 submission 的 commit/hash/manifest，不读取提交者当前文件。owner、提交者及实际收到该 handoff 的下游员工可读；仍要求当前项目访问权。提交后老板无需等待通过即可查看附件，只有通过才合入工作区。文本预览转义显示，下载为 attachment + octet-stream + nosniff + sandbox CSP，不执行 HTML。preview=1 仅按文件签名字节识别 PNG/JPEG/GIF/WebP 并以 nosniff + sandbox CSP 输出，SVG/HTML 不进入图片预览面。无同项目私有 transcript 广播。

## 后台执行与恢复

`workflow_jobs` 承担 plan.generate、share.prepare、submission.review、review.apply、workflow.reconcile、task.overdue。租约 token、generation、task/version、submission 和账号 epoch 在调用/应用边界复验。暂停、取消改变 generation 并排空相关运行；停用、改密、网络策略变化使旧授权失效，撤权也排空针对该员工的后台审核。

调度每秒领取工作，每 30 秒做数据库补偿和到期检查。无业务变化不调用模型。最多四个后台工作同时执行，其中模型工作最多一个，模型仍使用既有 root 配额和 Codex runTurn；容量等待不消耗失败次数，普通错误指数退避，不确定原生投递进入 needs_attention。

只有 Portal 启动恢复租约，维护 CLI 打开数据库不修改活跃 job。已持久化 completed 原生运行及结构化结果可恢复后续步骤；其余不确定 native 调用不得盲目重发，老板核对后台私有对话并明确确认后才重试。输入队列原有“不确定输入不得自动续发”契约不变。后台对话保留，不能从普通 chat 删除入口移除。

planner/reviewer purpose 仅提供固定上下文和结构化提交工具；无 workspace 写入/命令工具，原生写入与命令 approval 也拒绝。结果须由当前 root 提交。employee task purpose 可读取当前任务简报、审核反馈与允许的 handoff，实际勾选/提交由员工发起。

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

老板端把同一张图投影为依赖图、状态列表和事件记录：依赖图保留 DAG 连线、双向滚动与缩放，状态列表强调任务负责人和当前状态，事件记录按时间展示推进变化。依赖图和状态列表中的节点必须打开同一份任务详情。当前视图必须可辨识，缩放只在依赖图启用；长标题不得静默截断，固定尺寸节点和多任务看板必须提供可见内容的纵向滚动能力。

运行开关与回滚见 [操作说明](../../docs/WORK_GRAPH.md)。新增契约见 [发布要求](07-e2e-release-contracts.md)。
