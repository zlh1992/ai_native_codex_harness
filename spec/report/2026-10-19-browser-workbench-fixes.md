# 2026-10-19 浏览器与工作台交互修复

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署） |
| 日期 | 2026-10-19 |
| 负责人 | Codex |
| 关联目标 | 浏览器打开/接管、目录折叠、空名称取消 |
| 影响范围 | 浏览器服务/API、工作台 UI、测试、域名 1/2 发布 |
| 架构规格 | [浏览器](../architecture/11-managed-browser.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

截图显示 BROWSER_UNAVAILABLE 和接管控制权错误。代码把首次导航、快照失败都包装成启动失败并销毁会话；前端缺少直接打开地址入口，控制权请求和轮询可交错。目录目前只绘制向下箭头，没有折叠事件。取消按钮默认提交，必填校验在 submit 处理器之前阻止取消。

## 目标与非目标

### 目标

- 区分浏览器启动与页面加载失败，保留可操作画面；提供直接打开网页入口。
- 接管有明确步骤和当前状态，序列化输入/归还，消除过期轮询和遗留错误提示。
- 目录可折叠并在刷新文件列表时保留状态；空名称直接取消。
- 保持隔离及权限规则，完整门控后上线双域名。

### 非目标

- 不安装业务工具，不改变模型、既有账号联网位、宿主 VPN 或现有项目内容。
- 不绕过网站验证，不开放宿主浏览器、CDP 或文件访问。

## 约束与风险

遵守 FS-001/006、DAT-004/006、DEV-001 至 DEV-006。直接打开仍绑定用户、chat、access、EXECUTE 和联网权限，使用现有双浏览器容量。人工会话需覆盖注销、撤权、删除、停止和超时清理；页面失败不得自动重放。

## 实施计划

1. 分离启动与导航故障，复现目标网页并检查真实 Chrome。
2. 增加受认证的直接打开入口及人工会话生命周期；优化接管引导和请求顺序。
3. 修复文件树折叠和取消按钮，增加真实浏览器回归。
4. 同步规格，运行 gate、diff 和链接检查；空闲备份、上线、双角色验证及清理。

## 实际改动

- `browser-service` 分离启动、导航、快照错误；导航失败保留会话，控制权与页面输入串行。通用浏览器无需安装 Agent-Reach。
- 新增 POST browser 入口；空闲普通 EXECUTE chat 可直接打开，后续 Agent 复用页面；停止、删除、撤权、注销和超时清理覆盖人工会话。
- 前端加入网址栏、三步提示、明确控制状态、固定可见操作栏；控制请求排在已有输入之后，迟到轮询不覆盖新状态，成功后清理旧错误。
- 文件树按目录路径折叠，父级展开保留子级状态，刷新列表保持；切换项目/退出清空状态。取消按钮使用 formnovalidate，不触发必填校验，创建时校验仍在。
- 原导航测试需加载拆出的 renderFiles，已补齐夹具并保留、加强旧请求丢弃断言。导航错误测试改为新明确错误码，不删除原错误/恢复/登录态断言。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：增加 POST browser 打开入口；不接收客户端运行或 profile 身份。
- 权限与秘密：沿用 Origin/CSRF/session/access；不记录网页、输入或认证秘密。
- 回滚：恢复旧代码，保留数据库和业务文件。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate > .tools/browser-workbench-gate.log 2>&1` | 通过，退出 0 | 218 单元/集成 + 22 E2E，失败、跳过、取消均 0；首轮夹具引用错误已修复，原门控保留 |
| `node --test test/e2e/browser-gate.test.mjs` | 通过 | 真实 Chrome 2 个测试，包含直接打开、错误保留、接管、嵌套折叠和取消 |
| `node --test test/browser-service.test.mjs` | 通过 | 8 项授权、控制权、生命周期、人工会话接入 |
| `node --test test/navigation.test.mjs` | 通过 | 16 项，原请求乱序隔离保持 |
| `node .tools/browser-target-probe.mjs` | 通过 | 使用同等生产路径及 Seatbelt 打开币安；取得实际标题、1642 字符正文及 54610 字节 JPEG；无登录或交易操作 |
| `git diff --check` | 通过 | 无空白错误 |
| `python3 .tools/check-vpn-links.py` | 通过 | 70 个相对链接，0 断链 |
| `node .tools/public-workbench-fixes-smoke.mjs > .tools/public-workbench-fixes-smoke.log 2>&1` | 通过，退出 0 | 老板 GPT-6.1 Sol、员工 GPT-5.6 Sol；直接打开、原浏览器被 Agent 接入、JPEG、接管后核实实际正文、跨角色拒绝、停止清理；确认两域名提供新版资源 |
| `node .tools/run-with-system-proxy.mjs .tools/workbench-health.mjs` | 通过，退出 0 | 本地、域名 1/2 均 ready |
| `python3 .tools/verify-workbench-fixes-retention.py > .tools/workbench-fixes-retention-result.json` | 通过，退出 0 | 原有 17 用户、29 项目、77 对话、15 交付行哈希均一致；quick_check=ok、外键违规 0、无活动运行/输入/审批/租约/leased jobs，browser profile 为 0 |

## 发布、清理与回滚

- 从已核验的线上工作树发布，不修改原始 checkout；私有运行配置保持。
- 上线前复验运行、队列、审批及租约空闲，停止 Portal 后一致性备份数据库、业务文件树、配置和旧代码；隧道保持。
- 公网验收仅使用临时项目、临时员工及短期会话。结束后删除临时项目（平台回收机制）、停用临时员工、撤销测试会话；核对原有行哈希、完整性、活动资源和浏览器 profile。
- 回滚恢复此前代码与配置后重启，保留当前数据库及业务文件；不覆盖上线后新增业务数据。
- 已空闲停服、一致性备份并运行 `./bin/start-local.sh` 上线；备份目录 `~/Library/Application Support/CodexHarnessRemote/backups/2026-10-19-workbench-o_w2xw_5/`（700），含旧提交 `751067f07845a3e8411665bdc90680c78fc7ed27`、私有配置、SQLite 和 workspaces/trees/trash 克隆，备份 quick_check=ok。
- 本地及两个公网域名 health 均 HTTP 200、ok/codex/initialized=true、codexState=ready。首次员工域名直连检查遭遇外部连接超时，通过当前系统代理复核成功；应用未改写 VPN 配置。
- 公网老板 GPT-6.1 Sol、员工 GPT-5.6 Sol 均验证人工直接打开、接入原浏览器、接管继续后实际正文验证与关闭。临时员工禁网后直接打开被拒绝；重新授权后可打开，空闲停止立即关闭。
- 临时项目已按平台回收机制清理，临时员工停用，测试会话撤销；原始行哈希全部一致，无活动运行和浏览器 profile。既有账号联网位、四模型目录、Astra 禁用和 Qwen 关闭保持。
- `.tools/` 本地忽略目录中的验证脚本/日志仅保存测试材料和结果元数据；未把真实凭据、Cookie、人工输入或业务正文写入源码、报告或服务日志。公开币安探测仅浏览，无登录和交易操作。

## 结论

四处问题已修复并上线域名 1/2。通用浏览器可直接输入地址打开，接管/交还步骤和控制状态明确；页面加载错误不再误报启动故障，目录折叠和空名称取消正常。完整门控及双角色公网实测通过，业务数据保留。

## 遗留事项

无本次范围内未完成项。外部网站仍可能受网络或验证限制，平台按真实结果提示；不会自动重放网页动作。
