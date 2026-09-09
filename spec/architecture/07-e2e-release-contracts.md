# 07 端到端发布契约

## 门控入口

```bash
npm run gate
```

该命令必须依次运行语法检查、Shell 检查、全部单元/集成测试，以及 `test/e2e/portal-gate.test.mjs`。完整门控需要能够绑定 loopback 端口并运行嵌套 macOS Seatbelt 的宿主或等价 CI；受限代理沙箱中的跳过不构成通过。

HTTP E2E 使用隔离临时数据库、临时项目目录和协议兼容 fake app-server，不接触生产账号或生产项目。它验证 Portal 状态机和网络接口；真实 Codex/公网链路由单独的受控冒烟证据覆盖。

## 固定自动 HTTP E2E

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

`test/e2e/work-graph.test.mjs` 通过真实 HTTP 与 fake 原生业务工具回调验证：三员工资料、生成图、自动 files_only 分享、当前权限裁剪、人工幂等提交、自动打回和版本更新、并行分支、汇合及最终完成。故意调用 workspace 写工具必须失败。旧发布用例全部保留。

`test/work-graph.test.mjs` 补充真实 Git 前序成果同步、固定产物 ACL、配额批量原子性、脏树保留、计划/任务历史、暂停围栏、策略 epoch、租约恢复、模型工作串行与容量等待、取消清理。真实模型质量单独记录于实施报告，不能用 fake 判断代替。

`test/frontend.test.mjs` 固定三种工作图投影的选中态与用途说明、仅依赖图可缩放、长标题不做行数截断，以及依赖图节点和任务列表的纵向滚动契约；布局步长必须容纳固定高度节点，避免同层任务重叠。

## E2E-016 按用户记忆与分享确认

- `/api/me` 明示 Codex 原生记忆关闭；用户可创建、编辑、删除自己的 Portal 记忆并独立设置 chat 召回/形成开关。
- 普通 turn 通过实际动态工具回调执行 memory_add/update/delete，记录 project/chat/run 来源和版本；关键词本身不触发保存。同一用户在另一个当前授权项目通过 memory_search 召回并查询本轮引用。
- 另一用户的记忆列表为空，也不能用原 chat id 读取对方历史。
- owner chat 引用了跨项目记忆后，`files_and_history` 首次分享返回确认挑战；携带绑定当前接收者和快照的单次 token 后才发布 access/history。
- 单元测试补充来源撤权后的 fail-closed、失效引用正文隐藏、编辑后分享确认失效、token 接收者绑定与单次使用、秘密写入拒绝、工具身份覆盖拒绝、开关与 planner 限制、搜索异步权限复验、旧版本更新/删除拒绝。

本机单元/集成与 HTTP 测试均按文件顺序执行（`--test-concurrency=1`），避免多个真实 Git/Seatbelt 夹具争抢宿主资源影响短时生命周期断言；不修改、跳过或延长既有测试断言。
