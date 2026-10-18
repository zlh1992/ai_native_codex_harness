# 2026-10-18 VPN 自动适配与项目工具环境

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署） |
| 日期 | 2026-10-18 |
| 负责人 | Codex |
| 关联目标 | 系统 VPN 自动跟随、项目工具发现和新账号默认联网 |
| 影响范围 | 命令环境、浏览器、管理 API/UI、配置、测试、文档和域名 1/2 发布 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[浏览器](../architecture/11-managed-browser.md) |

## 背景与证据

变更前命令仅注入最小环境，没有系统代理；系统 VPN 提供 HTTP/HTTPS 本地代理，直接网络曾超时而显式代理下载成功。Python 入口已正常；项目虚拟环境和工具目录没有自动加入 PATH。系统 Git 启动器在沙箱内可能触发开发工具缓存拒绝。

当前生产为浏览器修复分支的独立工作树，原始仓库与其他工作树不修改。已有老板联网；现有禁网员工必须原样保留。用户最终确认新增员工默认联网，可在创建或之后关闭。权限变更沿用排空旧运行，同一 chat 下一轮读取新策略。

## 目标与非目标

### 目标

- 每条命令出队后读取当前系统 HTTP/HTTPS 代理，支持显式代理及 direct；浏览器使用系统原生动态代理。
- 项目 .venv/bin、.tools/bin 和 access 工具目录跨命令可用，绑定真实 Git。
- 新账号默认值在配置、API 和表单一致，旧账号权限不回写。
- 全门控、真实双角色下载和权限切换验收后发布域名 1/2。

### 非目标

- 不安装 gh/Agent-Reach，不补跑旧任务，不导入宿主账号或代理秘密。
- 不新增转发代理、业务表，不改变模型目录、隐私模式或项目管理目录保护。
- 不承诺 VPN 断线中的连接无损续传，不自动重放副作用命令。

## 约束与风险

- FS-006、DAT-004、DAT-006、DEV-001 至 DEV-006：保留禁网与 access 隔离，日志不记录代理凭据或业务正文。
- 默认网络策略只影响未来创建；部署不得批量启用旧员工。
- Chrome 系统代理依赖 Seatbelt 下 SystemConfiguration 通知；必须验证真实浏览器及会话连续性。
- 网络变化对已启动命令只影响其下一次启动；错误需明确提示手动确认后重试。

## 实施计划

1. 实现代理解析/白名单环境、真实 Git 与项目 PATH，补错误分类与 Agent 指引。
2. 浏览器使用原生系统代理，显式代理/direct 与命令一致；对系统读取和权限失败保持拒绝。
3. 更新新用户配置、看板 defaults.networkAccess、表单；增加隔离代理/安装/切换和权限回归。
4. 同步架构/操作文档，完整 macOS gate、diff 与 Markdown 链接验证。
5. 排空、备份、配置与部署，真实双角色 HTTPS/Git/权限开关验收并清理。

## 实际改动

- 新增系统代理解析与有限环境注入；每条命令出队读取并复验，system 浏览器不固定代理；支持显式/direct。
- 项目 venv/tools PATH、真实 Git 与 HTTP helper/模板绑定。受控测试发现仅 symlink Git 会导致 remote-http 缺失，已补对应路径。
- 新用户默认 true 和管理表单一致，旧账号位不迁移；已加载 thread 网络策略变化时 resume 原 thread，刷新 Agent 指引而保留身份与历史。
- 增加真实代理 HTTPS/Git/wheel/跨命令 CLI、权限切换、Chrome 节点切换与断线登录态测试。原 gate 不删除或减弱。
- Chrome 断线测试须等错误页实际提交后再模拟人工重试；不自动重放动作。管理表单新增断言移到原接管验收结束后，不消耗既有等待窗口。
- 系统 PAC/WPAD 或仅 SOCKS 配置未实现命令侧解释，明确返回配置错误，需运维提供 HTTP(S) 入口；无代理配置时保留系统路由/TUN。未引入隐式直连回退。

## 数据、接口与安全影响

- 数据迁移：无结构迁移；现有账号联网位不改写。
- API/协议：管理看板增加 defaults.networkAccess；创建接口保留显式 false。
- 权限与秘密：仅已授权普通项目注入无凭据代理；宿主环境不整体继承。
- 回滚：恢复发布前代码及私有配置，保留业务数据库与权限记录。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate > .tools/vpn-gate.log 2>&1` | 通过，退出 0 | macOS，216 单元/集成 + 22 E2E，失败、取消、跳过均 0；包含原 Portal 发布契约 |
| gate 内命令运行测试 | 通过 | 受控 CONNECT/TLS 正文、公开式 Git fixture clone、wheel 安装、跨命令 venv/工具 CLI、真实 Git helper；节点和端口变更、断线与人工重试；禁网无法接入本地代理 |
| gate 内账号/线程/UI 测试 | 通过 | 默认 true、显式 false、旧权限重启保留；同一 chat/session 开关与排空；原 thread resume 更新指引；创建默认勾选、旧禁网编辑不勾选 |
| gate 内真实 Chrome | 通过 | 受控代理上游 A/B 切换和临时断线；人工重试后会话 ID 与登录 cookie 保留；保留既有接管及隔离验收 |
| `node .tools/system-browser-proxy-probe.mjs > .tools/system-browser-proxy-result.log 2>&1` | 通过，退出 0 | 外层 Seatbelt、隔离 profile、未固定代理的真实 Chrome 取得公开正文 HTTP 200；临时 NetLog 验证原生代理配置及解析与当前系统一致 |
| `node .tools/public-vpn-smoke.mjs > .tools/public-vpn-smoke.log 2>&1` | 通过，退出 0 | 域名 1 老板 GPT-6.1 Sol、域名 2 新员工 GPT-5.6 Sol 实际执行 curl 正文与 GitHub clone；员工禁网拒绝代理、开启后原 chat/session/thread 下一轮下载成功 |
| `node .tools/public-vpn-policy-cycle.mjs > .tools/public-vpn-policy-cycle.log 2>&1` | 通过，退出 0 | 独立临时员工，同一 chat/session/native thread 完整禁网 → 开启下载 → 再关闭，最后显式本地代理仍被拒绝 |
| `python3 .tools/verify-vpn-retention.py > .tools/vpn-retention-result.json` | 通过，退出 0 | 原始 users 15/15、projects 26/26、chats 72/72、task_submissions 15/15 行哈希一致；quick_check=ok、外键违规 0、活动/审批/租约/leased jobs/浏览器 profile 均 0 |
| `git diff --check` | 通过 | 最终文档复验无空白错误 |
| `python3 .tools/check-vpn-links.py` | 通过 | 93 个变更文档相对链接，断链 0 |

`.tools/` 为忽略的本机验证脚本及证据目录，不随源码发布。受控安装只使用临时 wheel/CLI；公网下载只写临时项目，未执行下载文档中的安装指令，未安装 gh/Agent-Reach。真实验证未保留密码、会话 token、业务正文或完整模型提示到报告；日志仅保留结果元数据。

## 发布、清理与回滚

- 发布前确认 active runs、queued/steering inputs、pending approvals、leases、leased workflow jobs 均 0，执行 `./bin/stop-local.sh` 后备份，再执行 `./bin/start-local.sh`；隧道保留。
- 备份位于本机 `~/Library/Application Support/CodexHarnessRemote/backups/2026-10-18-vpn-hpn33b2c/`，目录权限 700：旧私有配置、SQLite 一致性备份、workspaces/trees/trash 文件树克隆、旧提交 `48a8a79f2996eb5f42ce6461ac7f555cfc4c3071` 的代码归档；备份数据库 quick_check 通过。
- 生产私有配置仅新增/对齐 `DEFAULT_NETWORK_ACCESS=true`、`OUTBOUND_PROXY=system`、`COMMAND_GIT_BIN` 真实二进制路径。未修改 VPN 或任何已有账号联网位。域名 1/2 和本地 health 发布后及收尾均确认 HTTP 200、`ok/codex/initialized=true`、`codexState=ready`。
- 公网验收临时项目经既有删除接口清理，文件按平台回收机制进入 trash；两个临时员工停用、临时登录会话撤销，保留停用账号及审计。原始 15 用户、26 项目、72 对话、15 交付均哈希一致；现有 6 个活动禁网员工仍禁网，老板仍联网。没有活动运行、输入、审批、租约、leased workflow jobs、残留浏览器 profile 或关联 Chrome。
- 回滚时先排空并停止服务，在独立目录从上述旧提交或归档恢复代码与依赖，恢复备份中的私有配置，再用既有启动脚本切回，复验双域名 health、权限和下载。**保留当前业务数据库和文件树**，不以旧数据库覆盖上线后的新业务；一致性备份只供明确的数据故障恢复。未执行回滚演练。

## 结论

目标已达成并已部署域名 1/2：默认使用当前系统 VPN，项目工具跨命令发现正常；新员工默认联网，旧禁网权限保持；老板开启/关闭后同一员工对话下一轮立即采用新策略。双角色真实 HTTPS/Git 下载、完整权限开关链路、门控与数据保留核对通过。四模型目录、Astra 禁用及 Qwen 关闭保持有效。

## 遗留事项

- 未切换宿主实际 VPN 节点/端口，避免干扰当前服务。已验证受控代理节点/端口变化、系统配置重新解析、原生 Chrome 实际使用当前系统代理；**尚未现场证明宿主系统端口变更通知和真实 VPN 全链路切换**，不能把模拟配置测试表述为该项实测。
- 第三方网站是否放行、VPN 切换期间已有连接是否中断由外部环境决定；失败明确返回，不自动重放。PAC/WPAD、仅 SOCKS 命令代理不在此次支持范围。
