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
- owner 的已跟踪修改与未跟踪文件进入授权快照。
- 员工一写入的私有 worktree 文件对员工二不可见。

### E2E-002 单 worktree 串行与浏览器写锁

- 同一员工同一 access 的第一个 turn 持有 workspace 后，第二 chat 的 turn 保持 queued。
- active turn 期间浏览器文件 PUT 返回 `WORKSPACE_BUSY`。
- 中断第一个 turn 后，第二个 turn继续并进入 completed。
- 完全排空后浏览器文件写恢复成功。

### E2E-003 活跃项目删除屏障

- owner 项目存在 running turn 时，DELETE project 返回 `PROJECT_BUSY`。
- 中断并进入终态后才允许删除。

### E2E-004 任务、不可变提交、审核与事件 ACL

- 老板创建跨两名员工的线性 roadmap 并激活。
- 员工从 active task 创建 task chat，完成 turn，并以正确 task version、chat、run、final item 提交。
- 含 submission 的 chat 删除返回 `CHAT_HAS_SUBMISSION`。
- 老板审核 passed 后下一名员工任务激活。
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

## 其他自动化强约束

虽然下列用例不是单一 HTTP 流程，它们同样属于 `npm run gate`：

- 真实 macOS Seatbelt：可写当前 tenant，不能读取 Codex credential；共享 worktree `.git` indirection 不可读。
- 路径与文件：CRUD、越界符号链接拒绝、Excel 预览不泄露其他路径。
- 并发：第 3 个 EXECUTE 排队，EDIT 不被全局 EXECUTE 队列阻塞，root 不超过 11，同 access 串行、不同 access 并行。
- 生命周期：queued/starting/running/approval/lease 在 chat/access/project 范围都有 guard。
- 恢复竞态：撤权发生在 thread setup、skill discovery 或 turn startup 时不产生失控 native turn。
- 快速完成竞态：completed 先到时仍保存 native turn id。
- 事件/消息：journal cursor 有序、敏感正文省略、fallback 幂等、超过 5000 条分页恢复。
- 协议：精确 CLI 版本、所需方法/事件/字段和固定 Luna 子代理策略存在。

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
- 每任务 worktree、merge/review、多人共享 transcript、artifact/handoff broker。
- OIDC/MFA、邀请、自助密码、设备会话和持久登录限流。

## 修改这些契约

变更 E2E 前必须在对应报告中记录：旧契约、业务理由、安全/数据影响、新契约、替代测试与回滚方式。仅因测试耗时、实现困难或新代码不通过而删除断言，不是可接受理由。
