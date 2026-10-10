# 07 端到端发布契约

## 门控入口

`test/tool-details.test.mjs` 固定明细状态/退出码、输入输出、秘密/记忆省略、异步批量不阻塞、撤权后不发布、隐私不调用云端、重启中断、前端转义/展开与切换竞态；`test/local-search.test.mjs` 额外验证独立无搜索/无工具 Luna-low 摘要协议。隐私 HTTP E2E 验证明细返回、员工及跨 chat run 拒绝。合成上游不代表真实 Luna 可用性。

```bash
npm run gate
```

该命令必须依次运行语法检查、Shell 检查、全部单元/集成测试，以及 `test/e2e/portal-gate.test.mjs`。完整门控需要能够绑定 loopback 端口并运行嵌套 macOS Seatbelt 的宿主或等价 CI；受限代理沙箱中的跳过不构成通过。

HTTP E2E 使用隔离临时数据库、临时项目目录和协议兼容 fake app-server，不接触生产账号或生产项目。它验证 Portal 状态机和网络接口；真实 Codex/公网链路由单独的受控冒烟证据覆盖。

## 固定自动 HTTP E2E

### E2E-LOCAL 隐私项目补充门控

`test/e2e/local-private.test.mjs` 使用真实 DSH 核心、macOS Seatbelt、临时 SQLite 与合成 OpenAI-compatible 回环模型，验证 Codex 不可用时的 HTTP 登录/队列/审批/文件/历史、员工不可见、禁止分享/工作图、不可变类型、项目记忆与普通记忆双向隔离。`test/local-private.test.mjs` 覆盖跨 chat 持久化、恢复/显式 reset lineage、本地串行容量、停止取消审批、manual 编辑搜索词、审批期间文件变化与下一 step steer，以及 EDIT/auto 命令策略；即使用户允许联网，隐私命令访问另一回环服务也必须失败。`test/local-search.test.mjs` 验证独立进程只接收 query、固定 Luna-low、无继承配置或环境秘密。前端测试固定本地引擎的执行、审批后继续和完成标识。

这些合成模型测试不等于真实 Qwen 的 tool-call 质量、上下文长度或吞吐验收；启用生产前须另做真实本机模型推理与工具测试。原有普通项目发布契约不变。

以下契约已经由 `test/e2e/portal-gate.test.mjs` 贯通，修改时不得无替代地删除或弱化。

### E2E-001 老板、多员工与独立工作树

- 老板通过 HTTP 登录并创建两个员工。
- 老板创建项目和 owner 本地快照，然后同时授权两名员工。
- 两名员工获得不同 `project_access` 和不同 worktree。
- owner 的已跟踪修改与未跟踪文件先进入不可变 Git baseline commit，授权记录返回该 `baseSha`，员工 worktree 从该 commit 创建。
- 员工一写入的私有 worktree 文件对员工二不可见。

### E2E-002 同 worktree 多 chat 并发与浏览器写锁

- 同一员工同一 access 的第一个 turn 持续运行时，第二 chat 的 turn 可并发启动并完成。
- 每个 chat 独立保存模式；新 chat 默认 EXECUTE，把第一 chat 改成 EDIT 不会改变第二 chat。
- active turn 期间浏览器文件 PUT 返回 `WORKSPACE_BUSY`。
- 中断第一个 turn 并完全排空后，浏览器文件写恢复成功。
- 编辑器用读取所得 `version` 保存成功后，再使用旧版本保存返回 `FILE_VERSION_CONFLICT`，且不能覆盖首个写入。

### E2E-003 活跃项目删除屏障

- owner 项目存在 running turn 时，DELETE project 返回 `PROJECT_BUSY`。
- 中断并进入终态后才允许删除。

### E2E-004 任务、不可变 Git 提交、owner 交付、审核与事件 ACL

- 老板创建跨两名员工的线性 roadmap 并激活。
- 员工从 active task 创建 task chat，完成 turn，并以正确 task version、chat、run、final item 提交。
- submission 绑定原 access、Git commit/tree；提交后的 owner 尚不可见员工文件。
- 含 submission 的 chat 删除返回 `CHAT_HAS_SUBMISSION`。
- 老板审核 passed 时固定 submission commit 合入 owner，记录 delivery commit，老板目录能读取交付文件，然后下一名员工任务激活。
- 同用户跨 chat、不同用户跨 chat 读取 run event 均返回 403。
- `Last-Event-ID`/`after` 只返回更大的 cursor，顺序严格递增。
- replay 和 admin audit 不包含测试 prompt 或 raw diff secret marker。

### E2E-005 撤权排空、脏树保留和原 access 恢复

- 员工 active turn 存在时撤权会先中断并排空。
- 撤权立即使旧员工请求返回 403。
- 脏 worktree 不删除。
- 如果保留 tree 超过新配额，恢复授权返回 `STORAGE_QUOTA`，且权限保持 revoked。
- 恢复配额后重授权复用同一 access/tree，员工原未完成文件仍存在。

### E2E-006 Thread 故障恢复与 lineage

- 正常 turn 先建立原生 thread id。
- Portal 重启并注入 resume 失败后，新 turn 失败但旧映射保持不变，状态为 `resume_failed`。
- 未确认上下文断裂的 reset 返回 409。
- 明确确认后新建 thread，old/new lineage 可查询，状态回到 ready。

### E2E-007 老板/员工 HTML 产物安全预览

- owner 写入 HTML 后，老板和获授权员工都能经各自 `project_access` 读取同一版本的产物。
- 原始响应使用 `text/html`，并携带允许脚本但不允许 `allow-same-origin`、connect 或 form 的 sandbox CSP。
- 前端把 `.html`/`.htm` 默认放进 iframe 预览而不是源码代码块；iframe 自身也只声明 `sandbox="allow-scripts"`，源码页签继续可用。

## 其他自动化强约束

虽然下列用例不是单一 HTTP 流程，它们同样属于 `npm run gate`：

- 真实 macOS Seatbelt：可写当前 tenant，不能读取 Codex credential；共享 worktree `.git` indirection 不可读。
- 路径与文件：CRUD、越界符号链接拒绝、Excel 预览不泄露其他路径。
- 并发：默认 EXECUTE 可占满全部 11 个 root 席，root 不超过 11，同 chat 串行，同 access 的不同 chat 与不同 access 均可并行。
- 自动放行：合法项目文件变更和 EXECUTE 命令记录 accepted approval 后直接继续；缺失目标、保留路径、越界路径及 EDIT 命令仍拒绝。
- 生命周期：queued/starting/running/approval/lease 在 chat/access/project 范围都有 guard。
- 恢复竞态：撤权发生在 thread setup、skill discovery 或 turn startup 时不产生失控 native turn。
- 文件与撤权竞态：主进程路径预检后替换父目录不能让 CRUD helper 读取或覆盖宿主文件；上传 body 尚未完成时撤权，最终写入必须返回 403 且不能落盘。
- runtime 隔离：同一用户不同 project access 的命令使用不同 HOME/TMPDIR，不能互相读取启动文件、配置或临时缓存。
- 快速完成竞态：completed 先到时仍保存 native turn id。
- 事件/消息：journal cursor 有序、敏感正文省略、fallback 幂等、超过 5000 条分页恢复。
- 协议：精确 CLI 版本、所需方法/事件/字段和固定 Luna 子代理策略存在。
- 原生记忆：启动参数和每个 thread config 都固定关闭，`config/read` 返回任一开启值时 app-server 不得 ready。
- 工作图审核上游证据：真实 Git 快照测试验证同名当前/上游文件分别读取固定字节，后续工作区修改不影响审核；跨项目/缺失 handoff、异步绑定变化、未读取引用均拒绝；预算省略显式标记，本次输出或被引用上游覆盖缺失不能自动应用。

## 已完成的真实公网冒烟

2026-09-05 在当前生产进程与 Cloudflare Quick Tunnel 上完成过一次受控验证，详细证据见 [当前实现报告](../report/2026-09-05-current-implementation-baseline.md)：

- 员工入口与老板入口返回 200；
- 老板和一次性员工凭据分别通过公网登录；
- 老板授权员工独立 worktree；
- 员工经公网完成文件创建、读取和删除；
- 真实 `codex app-server 0.150.0-alpha.8` 读取该文件并返回预期双标记；
- 撤权后员工访问返回 403；
- 临时 project/access/chat 清理，员工停用，管理员原密码哈希恢复；
- 生产库 integrity 为 `ok`，无外键违规、active run、pending approval 或 active lease。

这是带日期的验证证据，不代表每次 `npm run gate` 都访问公网或真实 Codex。

## 尚未由固定 E2E 承诺

- Cloudflare/Tailscale 第三方服务在任何时间的可用性、DNS 或固定域名配置。
- 真实 Codex 上游模型质量、配额、延迟和账号政策。
- 共享 app-server 对恶意跨 root collab 的进程级隔离证明。
- 每任务 worktree、自动冲突解决/PR、完整代码审核 UI、实时多人共享 transcript、artifact/handoff broker。
- OIDC/MFA、邀请、自助密码、设备会话和持久登录限流。

## 修改这些契约

固定域名 HTTP 用例 `test/e2e/public-ingress.test.mjs` 验证两个 hostname 的角色跳转与登录、host-only Secure Cookie、错误角色和未登录拒绝、未知 Host 与无效 Cloudflare 头拒绝、跨 origin 写入拒绝，以及本机 HTTP 登录兼容。云端 DNS、证书与真实隧道仍须单独验证，不能用本机模拟 Host 的测试代替公网验收。

变更 E2E 前必须在对应报告中记录：旧契约、业务理由、安全/数据影响、新契约、替代测试与回滚方式。仅因测试耗时、实现困难或新代码不通过而删除断言，不是可接受理由。

### E2E-008 角色入口与一次性对话 fork

- 老板/员工独立登录页面和 API，错误角色登录失败。
- 新 share 复制分享前 owner 历史，多员工得到不同 thread/chat/worktree。
- 员工续聊与 owner 后续新增历史相互不可见，原 chat/run ACL 不放宽。
- 空闲屏障与 fork 失败不发布部分共享，恢复 retained access 不重复复制历史。

### E2E-009 运行中输入队列与调整方向

- 通过 HTTP 入队启动持续运行，运行中可继续加入多条消息。
- 修改待发正文、取消指定消息、旧 revision 拒绝、已出队消息拒绝修改。
- steer 使用当前 run 前置条件并保持原 run 运行，其余消息仍按顺序等待；完成后自动执行下一条且采用编辑后的内容。
- 重复客户端 id 不重复发送；steer 历史与原生历史水合后只出现一次。
- 另一用户的队列读取、修改、取消、继续和 steer 全部拒绝；错误 CSRF 拒绝。
- 在线 run SSE 可收到实时 assistant delta；journal 重放与 audit 不含队列正文或 raw diff。
- 停止后余下消息暂停；显式继续后自动完成。
- 配套单元测试覆盖单并发账号、生命周期写锁、模式不匹配、发送结果不确定时的暂停/确认、停止与重启恢复；前端测试覆盖运行中可输入与网络失败保留草稿/幂等重试。

## E2E-015 多人 Work Graph

`test/task-graph-filter.test.mjs` 覆盖员工工作图 ID 分组、跨项目同名图、已完成/旧线性/无图任务、选择保留与失效回退、文本搜索组合和标题转义；身份退出清理由导航测试覆盖。选项仅使用已有获准任务，不新增内容接口。

`test/workflow-recovery.test.mjs` 与 `test/work-graph.test.mjs` 固定规划网络失败窄分类、有界调度重试、历史保留、失租约拒绝、回执复用、owner retry API 的授权/活跃拒绝/确认规则，以及状态卡片转义和恢复分类。真实上游网络故障率不由合成测试保证。

`test/task-flow.test.mjs` 覆盖提交后撤下重复提交、禁用失效对话输入、保留草稿、返工新版本入口、暂停/完成提示、自动共享项目同步及旧轮询不能回滚新状态。工作图 HTTP 用例核对列表和 chat 的有效审核方式/运行状态投影，浏览器实测证据独立记录。

`test/e2e/work-graph.test.mjs` 通过真实 HTTP 与 fake 原生业务工具回调验证：三员工资料、生成图、自动 files_only 分享、当前权限裁剪、人工幂等提交、自动打回和版本更新、并行分支、汇合及最终完成。故意调用 workspace 写工具必须失败。旧发布用例全部保留。

`test/work-graph.test.mjs` 补充真实 Git 前序成果同步、固定产物 ACL、配额批量原子性、脏树保留、计划/任务历史、暂停围栏、策略 epoch、租约恢复、模型工作串行与容量等待、取消清理。真实模型质量单独记录于实施报告，不能用 fake 判断代替。

附件扩展契约：真实 PUT 上传与工作区绝对路径混合提交、去重、跨员工/越界拒绝；老板通过前可读固定附件但 owner 工作区尚未合入；原文件变化不改变下载/位图预览。assisted 节点保持 submitted 等待老板，auto 节点对可读成果自动打回/重提/通过并推进；不完整文件转人工。原有全自动 fan-out/join 用例不移除。文档提取单测使用合成 PDF/DOCX 在真实 Seatbelt 下验证正文、嵌入内容覆盖与损坏文件失败闭合，异步提取后复验撤权/停用。

`test/frontend.test.mjs` 固定三种工作图投影的选中态与用途说明、仅依赖图可缩放、长标题不做行数截断，以及依赖图节点和任务列表的纵向滚动契约；布局步长必须容纳固定高度节点，避免同层任务重叠。

默认新增任务看板投影，不移除上述三种视图。`test/navigation.test.mjs` 通过 Node DOM 测试固定卡片转义、同列排序、用户命名空间、员工可用性、原详情/管理入口及四种工作图视图；这些行为测试不代替真实浏览器视觉验收。

## 登录与导航回归契约

员工标签页会话：`test/e2e/public-ingress.test.mjs` 在同一 Cookie jar 同时携带两名员工 Cookie，以各自 selector 验证 me、项目/对话隔离、原始文件和项目事件 query、跨账号拒绝、CSRF 不可互换、单独 selector 无授权、退出一方另一方及老板不退出；不同模拟公网 IP 的同账号新会话可访问同一 chat，其他会话退出不撤销它。`test/employee-session.test.mjs` 固定标签页存储/刷新、老板兼容、请求及非 fetch 资源携带选择，`test/navigation.test.mjs` 保留退出失败不清理状态并补选择清理断言。独立 HTTP Cookie 测试不能代替同一浏览器 Cookie jar 测试。

老板/员工共用工作台的 820px 以下聊天布局保持至少 360px 可滚动消息区、96px 多行输入区和 48px 发送目标；辅助进度、审批、待发队列独立限高滚动，不隐藏其操作。聊天保持普通页面流，项目和文件仍可访问。`test/mobile-chat.test.mjs` 固定静态样式约束，不替代手机软键盘实测。

原始文件预览的单 byte-range 请求支持后缀、开放结束和超出文件长度的终点裁剪；不可满足范围返回 416 与 `Content-Range: bytes */length`。多范围暂不支持。范围处理不得绕过 session、项目 ACL 或路径校验；由 `test/http-utils.test.mjs` 与固定域名 HTTP 夹具共同覆盖。

工作台控件按整组换行，不得将短标签逐字挤成竖排；对话列表不按剩余栏高拉伸单一卡片。820px 以下文件面板必须可通过正常页面滚动到达，不能隐藏全部文件功能或固定遮挡对话；静态布局回归与实际桌面/窄屏截图分别记录，不相互替代。

前端入口使用全包内容版本 URL，相对模块与动态 vendor 导入保持同一版本。`test/static-assets.test.mjs` 固定快照不可变性与任一依赖变更后的版本更新，固定域名 HTTP 用例遍历入口和依赖资源，并验证未知版本/非公开文件拒绝。

`test/navigation.test.mjs` 覆盖安全 returnTo、角色规范路径、连接错误不注销、旧身份响应废弃、退出清理、项目 A→B→A、历史恢复竞态和按对话草稿。页面必须初始遮罩并明确区分首页导航和退出。

`test/work-graph-navigation.test.mjs` 覆盖项目切换立即清理规划进度、迟到规划回执原项目归属、按项目隔离不确定请求的幂等重试、旧 job 不覆盖新 job，以及注销后迟到回执不得恢复状态。DOM 用例不能代替真实双员工浏览器闭环。

`test/e2e/public-ingress.test.mjs` 使用真实 HTTP 和隔离夹具，覆盖角色域名根路径与查询参数、末尾斜杠规范化、未知页面 404、固定本站 SortableJS 资源、Host/Origin/Secure Cookie、错误角色登录，以及注销后两个 turn SSE 关闭而另一有效会话仍可读取并中断原运行。

## E2E-016 按用户记忆与分享确认

- `/api/me` 明示 Codex 原生记忆关闭；用户可创建、编辑、删除自己的 Portal 记忆并独立设置 chat 召回/形成开关。
- 普通 turn 通过实际动态工具回调执行 memory_add/update/delete，记录 project/chat/run 来源和版本；关键词本身不触发保存。同一用户在另一个当前授权项目通过 memory_search 召回并查询本轮引用。
- 另一用户的记忆列表为空，也不能用原 chat id 读取对方历史。
- owner chat 引用了跨项目记忆后，`files_and_history` 首次分享返回确认挑战；携带绑定当前接收者和快照的单次 token 后才发布 access/history。
- 单元测试补充来源撤权后的 fail-closed、失效引用正文隐藏、编辑后分享确认失效、token 接收者绑定与单次使用、秘密写入拒绝、工具身份覆盖拒绝、开关与 planner 限制、搜索异步权限复验、旧版本更新/删除拒绝。

本机单元/集成与 HTTP 测试均按文件顺序执行（`--test-concurrency=1`），避免多个真实 Git/Seatbelt 夹具争抢宿主资源影响短时生命周期断言；不修改、跳过或延长既有测试断言。

## E2E-017 模型权限与用量

原员工禁止选择 root 模型的断言由同一发布门控中的新权限契约替换：活动员工可在自己的普通 chat 使用全部七种 GPT、保存强度，默认 medium；老板默认 high，分享副本使用接收者默认。越权 chat、非法模型/强度、运行/排队时修改和员工读取 admin 用量仍拒绝。

计量测试覆盖多步累计去重、root/child/辅助归属、resume/fork 未知基线、迟到/乱序样本、取消失败及重启、删除后保留、北京时间边界和筛选。真实 DSH 核心搭配合成回环 SSE 验证多步/续聊采集；独立搜索夹具固定只有 query/摘要输入且 Luna-low 计量正确。DOM 测试验证缺失值、筛选、身份失效清理和旧请求不覆盖新结果。

`test/work-graph-drawer.test.mjs` 固定最新任务读取、视图离开/退出、附件跨任务与同任务乱序、关闭重开、提交失效及登录冷启动保护；真实 Chrome 延迟响应复验独立记录于报告。

## E2E-018 微信固定渠道

微信 relay 只能通过 loopback 的 HMAC 请求进入 Portal；过期时间戳、错误签名、错误发送者和群聊必须拒绝。Portal 按配置固定老板的 standard `weichat-project`，每个私聊 scope 复用独立老板 chat，桥接不能提交 project/cwd/thread。只有 active binding chat 可发现跨项目工具；项目列表和每次读/搜索必须只接受当前老板本人拥有的 standard owner access，并拒绝员工自有/仅共享项目、local_private 与本机未纳管目录；跨项目写入和命令不可注册。相同外部 event id 的重试必须返回已保存结果且不新增 turn；真实 Codex 回复和 Portal SQLite 消息必须可在老板工作台读取。Portal 必须在普通 turn 前处理 `/new`、`/models` 和 `/model <id>`：空闲 `/new` 原子切换到新 chat 并保留旧历史，`/models` 返回完整 Portal 模型白名单（包括 `gpt-6-astra`），`/model <id>` 复用模型白名单并持久化当前 chat 偏好。部署验收至少执行一次真实签名事件、一次重复投递、一次 owner/employee/private 隔离测试、一次命令路由和一次 health/status 检查；敏感凭据不得进入日志或报告。

## 运维进程控制回归

`test/background-process.test.mjs` 验证重复启动复用同一进程、停止后不再运行、PID 指向另一进程时拒绝操作；真实整套 stop/start/restart、双域名与角色登录验证记录在实施报告。此测试不替代既有 HTTP/Seatbelt E2E。
