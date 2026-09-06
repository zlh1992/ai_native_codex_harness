# 2026-09-06 HTML 产物内嵌预览

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 老板与员工在文件工作台点击 HTML 文件时，应默认看到渲染结果而不是源码文本 |
| 影响范围 | Portal UI、文件原始响应、安全响应头、架构规格、HTTP E2E 与前端契约测试 |
| 架构规格 | [01 系统上下文与组件](../architecture/01-system-context-and-components.md)、[02 项目强制约束](../architecture/02-project-constraints.md)、[04 安全与信任边界](../architecture/04-security-and-trust-boundaries.md)、[07 端到端发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

当前 `public/app.js` 把 `.html` 明确归入默认“源码”模式；即使用户手动切到“预览”，通用文本分支仍把 HTML 放进 `<pre>`。因此老板访问自己的项目或员工访问获授权 worktree 时，点击 HTML 文件只能看到源码，无法像 Codex 本地产物预览一样看到页面。

已调研 Obscura。它是面向抓取、AI 自动化、CDP、截图和 PDF 的独立无头浏览器；Portal 的预览发生在已经打开的用户浏览器中，不需要再引入一套浏览器二进制或服务进程。当前需求可直接复用浏览器 iframe 渲染能力，并以双重 sandbox 和专用 CSP 约束不可信项目 HTML。

## 目标与非目标

### 目标

- `.html` 和 `.htm` 文件默认进入“预览”，同时保留“源码”、编辑、保存与下载。
- 使用浏览器原生布局与 JavaScript 引擎渲染自包含 HTML。
- 预览中的脚本不能获得 Portal 同源身份、访问父页面、提交表单、使用 connect 网络 API 或导航顶层页面。
- owner 与 shared access 继续复用相同的 `projectFor` ACL，不增加管理员内容旁路。
- 用前端契约与真实 HTTP E2E 固定 MIME、sandbox/CSP 和双角色授权行为。

### 非目标

- 不引入 Obscura、Chromium 或新的常驻渲染服务。
- 本轮不承诺跨文件相对 CSS/JS/图片依赖、外网资源、表单、弹窗或嵌套页面可用。
- 不改变文件编辑、版本冲突、下载或 project access 数据模型。

## 约束与风险

- 遵守 `PRD-001`、`PRD-002`、`FS-001`、`DAT-006`、`DEV-001` 至 `DEV-004`。
- 项目 HTML 属于不可信主动内容；若直接给予同源能力，脚本可尝试读取 Portal API 或操纵父页面。
- 只在 iframe 元素上设置 sandbox 不足以保护直接打开原始 URL 的场景；HTML 响应本身也必须携带 CSP `sandbox`。
- 过宽的 CSP 会把预览变成项目内容的网络外传或导航入口；本轮只允许内联脚本/样式和 `data:`/`blob:` 媒体。
- 回滚必须恢复 HTML 为普通源码/下载行为，不能放宽全站 CSP 或删除现有 ACL。

## 实施计划

1. 让原始文件路由以 `text/html` 返回 HTML，并为 HTML 单独设置 fail-closed 的 CSP sandbox；保留现有 ACL、路径检查和下载能力。
2. 前端为 HTML 创建无同源、无表单、无顶层导航能力的 iframe，默认选择预览，源码标签仍可切换和编辑。
3. 增加 owner/employee HTTP 契约、前端结构测试，并进行实际浏览器视觉验证。
4. 同步长期安全与发布契约，运行 `git diff --check`、相对 Markdown 链接检查和 `npm run gate`。

## 实际改动

- `public/app.js` 新增 `.html`/`.htm` 预览类型和源码优先类型集合。HTML 不再落入通用 `<pre>` 分支，而是默认创建 `sandbox="allow-scripts"`、`referrerpolicy="no-referrer"` 的专用 iframe；源码、保存和下载仍使用原有控件。
- `public/styles.css` 新增填满预览面板的白底 HTML iframe 样式。
- `src/server.mjs` 为 HTML 原始响应补全 `text/html; charset=utf-8`，并增加响应级 CSP sandbox。CSP 允许自包含产物所需的内联脚本/样式和 data/blob 媒体，拒绝 same-origin、connect、form、frame、worker、object 与 base 能力。
- `test/frontend.test.mjs` 固定默认预览、双重 sandbox、不出现 `allow-same-origin` 以及源码页签契约。
- `test/e2e/portal-gate.test.mjs` 用 owner 写入 HTML，并验证 owner 与 shared employee 都能经原有 ACL 读取相同产物，同时检查 MIME 与 CSP。
- `spec/architecture/01-system-context-and-components.md`、`02-project-constraints.md`、`04-security-and-trust-boundaries.md` 和 `07-e2e-release-contracts.md` 固化组件责任、`FS-007`、主动内容信任边界与 `E2E-007`。
- 实现与计划一致；调研后未引入 Obscura，因为客户端浏览器已经提供所需渲染引擎，额外 headless 服务不会改善本需求的交互或安全边界。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：既有 `GET /api/projects/:id/raw` 对 `.html`/`.htm` 改为正确 HTML MIME，并增加 HTML 专用 CSP；URL 与响应正文不变。
- 权限与秘密：沿用 `projectFor`、canonical path 和 Seatbelt 文件读取；预览不记录文件正文。HTML 文档和 iframe 均进入无 `allow-same-origin` 的 sandbox。
- 回滚：移除 HTML iframe 分支和 HTML MIME/CSP 特例，恢复默认源码模式即可；无数据不可逆条件。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/frontend.test.mjs` | 通过 | 9/9；包含 HTML 默认 iframe、无 `allow-same-origin` 和源码保留断言。 |
| `node --test --test-concurrency=1 test/e2e/portal-gate.test.mjs` | 通过 | 10/10；owner/employee 均读取 HTML，MIME 与 sandbox/connect/form CSP 断言通过。 |
| 隔离临时服务 + Codex 内置浏览器 | 通过 | 右侧显示实际布局；内联 CSS 与脚本运行；源码/预览往返成功；预览读取父 Portal DOM 返回失败。 |
| Node 相对 Markdown 链接检查 | 通过 | 检查 26 个 Markdown 文件中的 71 个相对链接，无缺失目标。 |
| `git diff --check` | 通过 | 无 whitespace error。 |
| `npm run gate` | 通过 | 在 macOS、loopback 与 Seatbelt 可用环境执行；60/60 单元/集成测试、10/10 固定 HTTP E2E 通过。 |

浏览器验收使用独立临时数据库、workspace、runtime 和 fake app-server，未接触生产账号或项目；测试服务已停止，临时目录已移入系统废纸篓。未把测试凭据、Cookie 或项目正文写入仓库与报告。

## 结论

目标已达成：老板 owner 项目与员工 shared worktree 现在共用同一套 HTML 默认渲染行为，源码/编辑/下载保持可用；主动脚本能支撑自包含前端产物，但不能获得 Portal 同源或父页面能力。固定 macOS release gate 已在本次验证快照通过，本变更满足自身发布条件；当前工作树中的其他并行目标若继续变化，整体发布前仍应以最终快照重跑 gate。

## 遗留事项

- 当前只承诺自包含 HTML。若后续必须支持多文件前端 bundle，应设计独立 preview origin 或带能力令牌的资源代理，不能加入 `allow-same-origin` 直接复用 Portal 会话。
