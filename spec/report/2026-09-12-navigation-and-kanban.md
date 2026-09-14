# 2026-09-12 登录导航修复与团队看板

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（本地及固定公网已更新） |
| 日期 | 2026-09-12 |
| 负责人 | Codex |
| 关联目标 | 复核登录/页面切换问题，优化老板任务及员工看板 |
| 影响范围 | 前后端、依赖、测试、规格；不迁移业务数据 |
| 架构规格 | [安全](../architecture/04-security-and-trust-boundaries.md)、[恢复](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md)、[工作图](../architecture/09-human-work-graph.md) |

## 背景与证据

上一轮只读 review 确认：箭头为真正注销；首屏先画登录表单；网络/503 被当作无会话；退出失败仍跳转；退出未清理私有 UI/订阅；项目列表响应可串位；原始路径/末尾斜杠兜底员工页；内部视图无历史及草稿保护。现有 23 项定向测试未覆盖这些问题。线上前端与 graph 一致。

## 目标与非目标

### 目标

- 身份检查、连接失败、真实失效分开；正常页面切换不注销、不闪登录。
- 明确“任务看板 / 工作台 / 我的记忆 / 团队管理”动线，登录后返回安全的原位置。
- 清理失效身份的 UI、弹窗、异步回调及 SSE；切项目/对话忽略过期响应。
- 任务状态与员工可用性采用紧凑 Trello 风格卡片列；第三方 SortableJS 本地加载，支持同列个人排序与键盘排序。
- 保留 DAG/状态列表/事件及现有编辑、审核、上传能力；长标题可完整阅读。

### 非目标

- 不迁移到 React/Sites/Workers、不改固定域名部署；此项目依赖本机 Codex/Seatbelt。
- 不延长 12 小时会话、不共享跨域 Cookie、不新增 SSO。
- 拖动不变更任务状态、员工权限或指派，不绕过 Git 交付/审核状态机。
- 不提交/push，不使用正式账号或项目做自动化夹具。

## 约束与风险

- PRD-001/003/007、DAT-006、WFG-002：看板只投影已有授权数据；正文不写日志。
- 缓存身份边界、异步响应乱序和旧页 BFCache 需显式处理。浏览器偏好只存用户范围内的排序 ID；私有草稿只在当前页面内存保留，退出时清空。
- 第三方代码固定版本及 lockfile，从本站固定路径提供；不开放整个 node_modules，不放宽 CSP。
- 保留已有未提交的隧道脚本和部署报告修改。

## 实施计划

1. 增加共享导航/会话辅助模块，首屏验证遮罩、明确重试、安全 returnTo、规范路由与视图历史；退出只在成功或明确失效后收敛。
2. 统一注销/失效清理、跨标签页身份复验与在途请求世代；SSE 在退出/过期后停止投递但不取消后台任务。
3. 项目/对话读取绑定选择版本；对话草稿按 chat 内存隔离；文件未保存变更离开前确认。
4. 使用 SortableJS 驱动本地个人排序，制作任务/员工卡片看板、搜索、状态计数、详情动作与响应式滚动；保留原表格及其他工作图投影。
5. 增加行为与 HTTP 回归测试，运行完整 macOS gate、Markdown 链接及 diff 检查；根据无活动运行条件再加载本机修复，验证本地/公网入口。

## 实际改动

- 新增 `navigation.js` / `session-ui.js`：安全 returnTo、角色首页、视图 history、四态认证、瞬时连接错误重试、同源身份变更复验、BFCache 遮罩与异步请求世代。
- 三个 HTML 入口首次渲染统一验证遮罩；“返回首页/任务看板”与“退出登录”分离。老板登录后默认任务看板，团队管理独立入口，规划表单可折叠，大标题压缩。
- `app.js` 清理失效身份的私有内存、表单、弹窗、SSE 和旧回调；项目/对话/文件/历史切换有竞态保护，草稿与重试 ID 按 chat 保留，未保存文件离开确认。
- `page-routes.mjs` 规范角色域名根入口、原始 HTML 路径及末尾斜杠，未知页面返回 404；会话注销与过期停止 turn SSE 投递，但不误中断后台 Codex 运行。
- `kanban.js` + `portal-ui.css`：本地 SortableJS 1.15.7（MIT）依赖，任务状态列、员工可用性列、搜索/计数/详情、长标题完整显示、列内纵向/看板横向滚动、同列拖动及键盘排序。保留原 DAG/列表/事件和员工表格。
- 新增 Node DOM 测试依赖 Linkedom 0.18.13（ISC）；测试使用合成身份、卡片与临时数据库，无正式账号登录或业务数据写入。
- 选用 vanilla JS 第三方库，避免为一个看板替换应用框架；依据官方 [SortableJS 文档](https://github.com/SortableJS/Sortable) 核对分组、手柄和触控能力，组件仅通过本站固定路径提供，不使用 Trello 云服务或插件。
- 延续紧凑工作界面的设计原则，不使用营销型首屏；不将本机 Codex/Seatbelt 项目迁移到 Sites。
- 首次完整 gate 暴露旧 POST turn SSE 的终态兼容性：会话撤销时原实现需要结束事件。现改为只发送固定 `AUTH_REQUIRED`，随后关闭，既满足旧客户端收尾又不泄露任务内容；原发布测试未修改。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：管理员 dashboard 的 users 增加已有员工 `profile` 元数据；业务写接口与 Codex 协议不变。页面路径规范化、受限第三方资源路径、会话事件生命周期收紧。
- 权限与秘密：Host/Origin/CSRF、host-only Cookie、原生记忆关闭保持不变。
- 回滚：撤回本报告对应代码/依赖变更并重启 Portal；不回滚业务库、不改 DNS/隧道令牌。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/navigation.test.mjs test/frontend.test.mjs` | 32/32 通过 | 17 项既有前端 + 15 项新导航/DOM 测试 |
| `node --test test/e2e/public-ingress.test.mjs` | 1/1 通过 | 角色入口、隔离登录及退出双 SSE 回归 |
| `npm run gate` | 通过 | 最终 125/125 单元/集成 + 18/18 HTTP E2E，0 skip；保留所有既有发布契约 |
| `git diff --check` | 通过 | 无空白错误 |
| `node --input-type=module` 相对 Markdown 链接检查 | 通过 | 遍历 spec 下 Markdown 的本地链接，163 个有效，0 个失效 |
| `npm audit --omit=dev` | 通过 | 0 vulnerabilities |
| 只读 SQLite `quick_check` / `foreign_key_check` 与运行状态聚合 | 通过 | 完整性 ok、外键错误 0；重启前无非终态 turn、待办 job、未发输入、执行 lease 或 pending approval |
| `bash -c 'source bin/_common.sh; "$CODEX_BIN" --version'` | 通过 | 精确版本 `0.150.0-alpha.8` |
| `./bin/stop-local.sh && ./bin/start-local.sh` | 通过 | 在零运行屏障后执行，Portal 与 Codex ready；Named Tunnel PID 未变 |
| `curl --silent --show-error --max-time 20` 三个 origin 的 HTTP 矩阵 | 30/30 通过 | 本地、老板域名、员工域名：health 200/ready、无凭据 me 401、未知页面 404、斜杠 308；页面/JS/CSS/Sortable 正文 SHA-256 与当前文件一致 |
| 公网 `curl --write-out '%{http_code} %{ssl_verify_result} %{remote_ip}'` | 通过 | 两个角色入口均 200，TLS 校验均为 0，连接 Cloudflare 地址而非原源站 IP |
| 重启后只读 SQLite 复验 | 通过 | 完整性 ok、外键错误 0、非终态 turn/lease 均 0；既有 running 工作图仍保留，未执行取消或审核 |

验证环境为本机 macOS（darwin/x64），Git、loopback 与 Seatbelt 均真实执行。DOM 测试使用 Linkedom；没有用正式身份登录浏览器做截图/拖拽视觉验收，也没有启动真实模型业务任务。Node 的 SQLite 实验性提示及 DOM 夹具的 localStorage 提示不是测试失败。

## 结论

Review、计划、实现和发布门控完成，graph 工作树已提供本地及固定公网新版；未 commit/push。返回任务首页不再注销，连接失败不再冒充未登录；原生记忆关闭、会话 TTL、双域名 host-only Cookie 与内容 ACL 保持不变。

地址保持：老板 [固定公网登录](https://workbench1.winy.cc/boss/login)、员工 [固定公网登录](https://workbench2.winy.cc/employee)；本地分别为 `http://127.0.0.1:4310/boss/login`、`http://127.0.0.1:4310/employee`。重启只涉及 Portal，未改 DNS、隧道 token 或共享材料。

清理：测试临时目录由各夹具回收，未创建正式用户/项目/会话或遗留执行任务。保留用户原有隧道脚本与部署报告的未提交修改；没有删除业务数据。若回滚，只撤回本报告对应前端/后端/依赖变更并重启，不使用覆盖整个脏树的 Git 命令。

## 遗留事项

- 未用正式账号进行真实浏览器视觉验收；用户刷新后仍需确认实际字体、触控拖拽与长内容体验。自动化已经覆盖 DOM 行为、HTTP 登录/注销、权限及部署资源，不把它们声称为截图验收。
- 对话草稿仅在当前页面内存跨切换保留，不承诺跨刷新持久化。12 小时会话过期、主动退出或切换 hostname 仍可能要求重新登录。
- 看板仅支持同列个人排序；跨列拖动修改任务状态、跨设备同步顺序、企业 SSO 均不在本次范围。
