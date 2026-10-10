# 员工工作台工具明细折叠优化

- 状态：完成（第二轮折叠优化已部署；完整 gate 受环境依赖限制）
- 日期：2026-09-25
- 范围：员工/老板工作台聊天区域的本轮工具明细展示

## Context

工作台把工具明细、Goal、执行计划、任务进度和排队消息连续放在聊天回复与输入框之间。内容较多时，辅助区域会占据较大垂直空间，导致当前 Codex 回复不可见或需要额外滚动。上一轮已经为工具明细增加外层折叠，但辅助信息总区和任务/队列区域仍会展开占位。

## Goals

- 外层工具明细默认收起，只保留一行可识别的标题和条目数量。
- Goal、执行计划、diff、记忆引用、审批和任务进度统一放入可收起的辅助信息区域。
- 待发送输入队列默认收起，避免队列内容挤占回复区域。
- 用户点击标题后可展开面板，并继续逐条展开工具输入/输出。
- 轮询刷新工具状态时保留外层及单条明细的展开状态。
- 保持工具明细接口、脱敏内容和聊天事件语义不变。
- 重启 Portal 后让前端资源立即生效。

## Non-goals

- 不修改工具明细 API、数据库事件或 Codex 执行逻辑。
- 不改变消息、审批、执行计划或输入队列的状态机。
- 不删除工具明细；用户仍可按需查看完整输入和输出。

## Constraints and risks

- 仅修改前端静态资源与规格报告，遵守现有工作台 ACL 和安全边界。
- 外层折叠状态是当前页面 UI 状态，切换聊天或刷新页面后默认收起。
- 需要验证语法、文档链接和现有发布门控；若宿主无法提供 macOS Seatbelt/Codex ready，报告中明确记录门控限制。

## Implementation plan

1. 在 `ToolDetailsPanel` 外层增加可访问的原生 `details/summary` 折叠容器，默认关闭。
2. 将 Goal、计划、diff、记忆、审批放进辅助信息折叠容器；任务提示和输入队列增加独立折叠入口。
3. 将工具条目、辅助内容和队列放入可滚动内容区，刷新时恢复已展开状态。
4. 调整聊天布局 CSS，使收起时只占一行，展开时保留有限高度和内部滚动。
5. 运行静态检查、相关测试、`git diff --check` 与 Markdown 相对链接校验。
6. 在无活动运行的安全屏障下执行 `bin/stop-local.sh` / `bin/start-local.sh`，核对本地健康状态。

## Changed components

- `public/tool-details.js`：工具明细外层改为默认收起的原生 `details`，显示条目数量与运行/失败状态；轮询重绘时保留外层和单条明细展开状态及滚动位置。
- `public/index.html`：辅助信息总区改为默认收起的 `details` 容器。
- `public/app.js`：任务进度、输入队列支持折叠，并在轮询重绘时保留展开状态。
- `public/styles.css`、`public/portal-ui.css`：收起时各区域固定为紧凑标题行，展开时限制最大高度并在内部滚动；移动端沿用较小高度。
- `spec/report/index.md`：登记本报告。

## Validation and evidence

- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check public/tool-details.js`：通过。
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check public/app.js`：通过。
- `/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --check src/server.mjs`：通过。
- `git diff --check`：通过。
- Markdown 相对链接脚本：0 个断链。
- `npm run gate`：未完全通过。当前仓库缺少 `node_modules/linkedom`，导致 7 个前端测试文件无法加载；另有既存的 PDF/DOCX 提取和本地搜索测试失败。此次前端改动的 `test/tool-details.test.mjs` 也因缺少 `linkedom` 未能执行。
- `test/mobile-chat.test.mjs` 的 CSS 断言：通过；`test/task-flow.test.mjs` 与 `test/tool-details.test.mjs` 仍受当前环境缺少 `node_modules/linkedom` 影响，未能加载。
- 以 ChatGPT 内置 Node 执行 `bash bin/stop-local.sh` 后重新执行 `bash bin/start-local.sh`：通过；新 Portal PID 为 `79467`，`GET /api/health` 返回 `ok=true`、`codexState=ready`、`nativeCodexMemory=false`、memory index ready。公网 named tunnel 未重启。

## Migration/API/security impact

无数据库迁移、协议/API 变更或安全边界变化。

## Cleanup and rollback

回滚前端静态资源并重启 Portal 即可；不删除工具调用记录或业务数据。

## Conclusion and remaining work

工具明细、辅助信息、任务进度和输入队列现在默认只占一行，点击标题即可展开完整内容，能为当前 Codex 回复释放可见空间。没有数据库、API、协议或安全边界变化。若需要宣称完整发布门控通过，应先恢复 `linkedom` 等缺失依赖并重跑 `npm run gate`；当前已完成本地重启和健康核对。
