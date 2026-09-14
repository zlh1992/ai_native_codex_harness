# 2026-09-14 员工多账号标签页会话

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署） |
| 日期 | 2026-09-14 |
| 负责人 | Codex |
| 关联目标 | 同一 Chrome 并发不同员工，登录/退出互不替换身份 |
| 影响范围 | 认证、前端请求/资源/SSE、测试、规格 |
| 架构规格 | [安全](../architecture/04-security-and-trust-boundaries.md)、[发布](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

旧实现每次登录产生随机 session，退出仅删除本次 session；独立 Cookie 容器的既有 HTTP E2E 16/16 通过，公网未登录 me 返回 401/no-store/CF DYNAMIC。未证实跨设备全局串号。现有同域名 Cookie 和 BroadcastChannel 会使同一 Chrome profile 多标签同步为最后登录账号。用户明确要求同一 Chrome 可并发不同员工；同账号多设备访问同一数据，老板入口保持现状。

## 目标与非目标

### 目标

- 员工标签页独立选择 session，身份凭据仍是 HttpOnly、host-only Cookie。
- fetch、SSE、附件下载/预览均选择该标签页会话，不回退其他账号。
- 不同账号和不同设备保持原 user/project/chat ACL；退出仅撤销选中 session。

### 非目标

- 不按 IP 绑定身份，不改变老板多设备会话，不把同源标签页当敌对租户安全边界。
- 不把 bearer token 写进 sessionStorage/URL，不改 Codex 工作树或共享业务规则。

## 约束与风险

- 遵守 PRD-001/003、DAT-004/006；保留 CSRF、Origin、Secure Cookie 和会话流关闭契约。
- sessionStorage 只存随机公开 selector；访问仍必须同时携带对应 HttpOnly token。选择缺失或错误不能回退默认 Cookie。
- 新员工页面要求重新登录；旧默认会话兼容旧 API，不批量撤销其他设备。新建标签页默认未登录；复制标签页可能继承同一会话，新登录始终创建新 selector。

## 实施计划

1. 登录支持员工专用 selector-cookie，认证及退出按 selector 精确处理。
2. 前端封装 employee sessionStorage 选择与请求/URL装饰，保持老板默认行为。
3. 新增同一 Cookie jar 的多账号/多 IP HTTP 测试及前端测试，运行完整 gate，尝试 Chrome 独立标签验收。

## 实际改动

- 新 `src/session-selection.mjs` 验证 header/query，选择独立 Cookie；显式无效选择拒绝且绝不回退。员工登录新增可选 sessionSelector，boss/旧 API 保持兼容；logout 精确删除所选 token hash 与 Cookie。
- 新 `public/employee-session.js` 只在员工页面启用，sessionStorage 保存公开 selector；新登录随机新建，刷新保留。凭据不进入 JS/URL。session-ui 默认请求、原生 fetch 流、EventSource、下载、附件、iframe/图片统一携带选择。
- 登录页明确多标签独立账号；退出失败保持选择，成功/401 清理本标签选择。原 BroadcastChannel 仅触发各自身份复验，不复制身份。
- HTTP 固定域名测试补同 Cookie jar 两员工、多 IP 同账号、项目/对话/文件/事件隔离、CSRF 和 selector 缺失/冲突，以及员工退出不影响另一员工/同账号其他 session/老板。新增前端存储/请求测试，原退出测试只补依赖与更强清理断言，未削弱发布门控。

## 数据、接口与安全影响

- 数据迁移：无；session 表继续保存 token hash。
- API：员工登录可选 selector；请求 header/只读资源 query 指定 selector。旧 API 兼容。
- 权限：selector 单独无授权能力，全部原 ACL/CSRF 不变。不得保存生产密码或正文。
- 回滚：恢复旧前端/认证模块后重启；员工重新登录默认会话，不删除项目或历史。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/e2e/portal-gate.test.mjs`（修改前） | 16/16 通过 | 独立会话原基线 |
| `node --test test/employee-session.test.mjs test/navigation.test.mjs test/e2e/public-ingress.test.mjs` | 20/20 通过 | 同 jar 身份/内容/退出隔离 |
| `npm run gate` | 通过 | 165 单元/集成 + 19 HTTP E2E；零跳过，退出码 0 |
| Chrome 同 profile 两标签实测 | 通过 | Alice/Bob 各自项目和私有 chat；B 登录后 A 刷新不变；A 退出后 B 刷新仍可打开自己的 chat |
| `git diff --check`、相对链接检查 | 通过 | 4 份文档共 37 条相对链接，结束前复核 |

Chrome 使用仅回环的独立临时 Portal、fake app-server、临时账号和项目，不接触生产员工数据。两个测试账号已通过 UI 退出，两个测试标签关闭；临时 Portal 及父控制进程正常停止，临时数据库/项目目录自动清除。没有保存浏览器密码，没有调用真实模型。

## 结论

实现与完整门控、实际 Chrome 多标签验收通过。独立设备会话原本已隔离，本次补齐同一浏览器 profile 不同账号的标签页选择；同账号仍访问同一业务数据。

## 遗留事项

- 最初 Chrome 连接超时，随后在新建测试标签正常完成实测。
- 旧员工页面需刷新并在各标签重新登录才能使用新机制；旧 API 继续兼容，不批量注销其他设备。

## 发布计划

完整门控已通过，线上 active turn/leased job/queued input/pending approval 均为 0。再次复核后做 SQLite 在线备份，使用 graph 正式脚本重启，让现有员工公网入口应用修复；不改 DNS、隧道、账号、密码、项目或历史任务。不重试任何业务任务。重启后核对本地与双公网 health、新版本员工资源及数据库完整性。

## 发布结果

已完成在线备份（生产 backups 下 `pre-employee-tab-sessions-tLACVd/harness.sqlite`，目录 0700 / 文件 0600）及正式 stop-local/start-local 重启；确认新进程运行 graph/src/server.mjs。双公网与回环入口均 200、Codex/索引 ready、原生记忆关闭；缺失标签会话请求 me 返回 401。版本 `3d1bf94bdc0136b8a6ec` 在本地与双公网一致，employee-session/session-ui/app/work-graph 模块与磁盘字节一致。生产库 integrity=ok、foreign keys=0。没有修改生产账号、密码、项目或业务任务；域名/隧道不变，员工刷新后分别重新登录即可使用。
