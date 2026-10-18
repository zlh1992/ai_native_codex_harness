# 2026-10-18 通用命令环境与交互浏览器

| 字段 | 内容 |
| --- | --- |
| 状态 | 门控通过，待发布 |
| 日期 | 2026-10-18 |
| 负责人 | Codex |
| 关联目标 | 修复普通项目运行环境，并提供当前对话的浏览器人工接管 |
| 影响范围 | 执行器、动态工具、HTTP、UI、运维、测试、规格 |
| 架构规格 | [安全](../architecture/04-security-and-trust-boundaries.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

两角色均遇到固定 RLIMIT_NPROC=96 导致 fork 失败、macOS Python 启动器访问受限、curl 无法读取系统 TLS 配置。已在同一宿主受控复现。直接运行 Python 3.13 和补充只读 TLS 配置的探测成功。现有通用命令 profile 不足以启动 Chrome，需要专用最小系统服务规则和独立临时目录。

## 目标与非目标

### 目标

- 修复通用运行环境、可取消命令排队和可解释错误。
- 普通 EXECUTE 项目通过 Portal 管理独立浏览器，支持显示、交互、人工接管及继续。
- 保留既有账号、历史、工作树、模型白名单及全部发布门控。

### 非目标

- 不补做既有两项任务，不全局安装 Agent-Reach，不承诺第三方验证放行。
- 不启用 Codex 原生浏览器，不连接日常浏览器，不启用隐私引擎。

## 约束与风险

- 遵守 FS-001/002/006/007、DAT-004/005/006、CAP-001/002、DEV-001 至 DEV-006。
- Chrome 使用独立 Seatbelt 与临时 profile；输入、Cookie、画面不进入日志或工具明细。只有受当前 chat ACL 保护的页面文本可按工具请求送入模型。
- 系统进程限制是 OS 用户级，不能误称为每任务进程 quota。浏览器控制权与关闭必须处理异步竞态。

## 实施计划

1. 修复命令限制、Python/TLS、隔离缓存、取消排队与错误分类。
2. 增加独立 BrowserService、受 ACL 保护的工具/HTTP、用户接管与有界清理。
3. 在现有前端增加画面抽屉与人工控制，复用认证和事件。
4. 补自动测试和 spec，完整 gate 后备份、排空并部署域名 1/2，双角色真实验收。

## 实际改动

- 命令队列按 run 串行、全局受 EXECUTE 容量限制，排队取消不启动；出队复验授权。移除用户级进程限制，绑定真实 Python，隔离 venv/HOME/缓存并只读开放 TLS/解析配置。
- 新增 BrowserService、四个 root-only browser 工具、chat 下状态/画面/操作/控制接口和前端 JPEG 抽屉；不新增业务表，工具明细和摘要跳过浏览器正文。
- Chrome 使用独立临时 profile、精确 PID rendezvous 和外层 Seatbelt。真实探测证实内层 Chrome 沙箱触发 forbidden-sandbox-reinit，关闭内层但从不移除外层；所有 helper 继承同一文件边界。
- 人工接管绑定 Web session；继续后重新读取页面，阻止旧动作重放。结束前关闭浏览器和清理 profile，TERM/KILL 仅作用于匹配会话路径的进程。
- 补充受控验证页、真实 UI 中文输入、角色隔离、越权/CSRF/Origin、恢复/清理、队列和命令环境测试。原始固定门控未修改。
- 新命令测试初次受 25 秒总预算影响，扩大为 60 秒后进一步确认 GitHub 直连在沙箱内外均超时（curl 28，DNS 已解析、连接未建立）。新增 HTTPS 回归改为临时证书的受控 TLS 服务，并检查系统 TLS/CA 文件可读；公网 HTTPS 另行验收，不让第三方路由决定发布门控。既有测试未删除、跳过或削弱。
- 原审批安全 fixture 用 100 次 1ms 轮询等待真实命令，在宿主负载下偶发超时；单独重跑通过。改为有界 10 秒 deadline，原有自动接受、EDIT 禁止、文件与审批数量断言全部保留，不改变产品或安全契约。
- 发布前只读基线：14 个用户、25 个项目、70 个 chat、15 份 submission；非终态运行、待发输入、pending approval 和 lease 均为 0。

## 数据、接口与安全影响

- 数据迁移：无新增业务表；事件只记录浏览器生命周期元数据。
- API/协议：新增 Portal 管理的 browser 工具和 chat 下 browser HTTP；精确 CLI pin 不变。
- 权限与秘密：沿用 session/Origin/CSRF/chat/access/网络校验；浏览器仅有独立 profile。
- 回滚：排空、关闭浏览器后恢复上一代码与私有配置；保留业务库及新产生历史。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/command-runtime.test.mjs` | 3/3 通过 | 真实 Python venv、子进程、受控 HTTPS、取消和分类 |
| `node --test test/browser-service.test.mjs` | 6/6 通过 | 接管、拒绝、超时、授权、清理中容量及断线 |
| `node --test test/e2e/browser-gate.test.mjs` | 1/1 通过 | 真实 Chrome、实际前端、中文/密码输入、拖动/滚动/标签、角色隔离、继续正反例与清理 |
| `git diff --check` | 通过 | 无空白错误 |
| 相对 Markdown 链接检查 | 通过 | Python 扫描本次修改和新增 Markdown：96 链接、0 错误 |
| `npm run gate` | 通过 | macOS + Seatbelt + 本机 Chrome；210 单元/集成 + 20 E2E，0 失败、0 跳过 |
| 公网老板/员工冒烟及清理 | 待执行 | 隔离临时项目和账号，不保存认证内容 |

## 结论

实现与完整发布门控已完成；公网发布及双角色真实模型验收尚未完成。完整门控日志位于本工作树忽略的私有文件 `.tools/validated-gate.log`，不包含生产认证信息。

## 遗留事项

- 排空、备份、部署域名 1/2 并完成双角色真实验证和保留性检查。
