# 2026-10-18 远端 graph 本机适配与域名 1/2 部署

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署） |
| 日期 | 2026-10-18 |
| 负责人 | Codex |
| 关联目标 | 远端最新版最小改动适配本机，替换域名 1/2，双角色开放指定模型并禁用 Astra/Qwen 隐私执行 |
| 影响范围 | 模型策略、配置、测试、运维、文档；沿用上游数据库迁移 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[模型](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[发布](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[隐私](../architecture/10-local-private-projects.md) |

## 背景与证据

远端 origin/graph 已取回至 060b52b。旧线上进程来自另一 graph 工作树，该树含未提交修改；域名 1/2 和本机 4310 健康响应 ready，域名 3/4 返回 Cloudflare 1033，不能证明其部署版本。本次采用独立工作树保留旧源码及修改。远端精确 CLI pin 与本机独立二进制均为 0.150.0-alpha.8。最新远端模型目录缺少需求中的 GPT-5.6 Sol 与 GPT-6.1 Sol。

## 目标与非目标

### 目标

- 从固定远端 SHA 部署全部非隐私网页能力；复用本机官方 Codex 登录、已有数据库和项目路径。
- 老板/员工统一允许 gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-6.1-sol；默认 5.6 Sol，禁止 Astra 经 API、默认配置或旧偏好启动。
- LOCAL_QWEN_ENABLED=false；保留历史隐私记录和 ACL，禁止回退云端。
- 验证 macOS 完整 gate、双方公网目录及真实模型请求，并保留可回滚备份。

### 非目标

- 不改域名 3/4、不覆盖远端机器配置或导入其数据，不修改桌面 Codex 全局设置。
- 不新增微信绑定，不启动独立于本项目的微信服务，不删除隐私实现或弱化门控。

## 约束与风险

遵守 PRO-001/003、DAT-001/003/005/006、DEV-001 至 DEV-006。先校验默认模型，避免环境变量绕过模型禁用；旧偏好保留、按已允许默认运行。远端迁移含本地引擎命名与渠道字段，需要在旧库副本运行、验证幂等及完整性。切换前检查运行和队列，备份业务数据及配置；回滚必须使用匹配的数据库，不假设旧代码兼容新 schema。生产内容、认证信息及 raw diff 不进入报告。

## 实施计划

1. 固定上游 SHA、独立工作树、私有备份与兼容性盘点。
2. 最小调整共享模型名单及默认配置校验，强化双角色/Astra 负向测试；同步长期规格与操作文档。
3. 安装锁定依赖，验证本机 app-server initialize/model list、旧库迁移及完整 gate。
4. 复用本机私有配置、索引运行时与隧道；排空后备份并切换服务至新工作树，保留域名 1/2 及数据根。
5. 双角色公网模型/权限/历史及真实推理验证，清理临时资源，记录结果、回滚和遗留项。

## 实际改动

- 仅修改两个生产源码文件：`src/models.mjs` 统一四模型目录并校验历史偏好的默认回退；`src/config.mjs` 将默认设为 GPT-5.6 Sol 并拒绝目录外 CODEX_MODEL。
- 保留上游隐私实现，私有环境配置关闭 Qwen 和未绑定微信渠道，开启工作图、自动调度/审核与 Portal 记忆；复用本机独立 CLI、官方认证、已有 memory Python、数据根和 Named Tunnel。
- 更新模型契约测试、运行/恢复测试的默认模型 fixture、渠道目录测试及操作/架构说明；没有删减测试、放宽 CLI pin、变更桌面全局模型或推送远端。
- 新运行目录是本聊天附加的 `portal-local-deploy/codex-harness-remote` 工作树，分支 `codex/local-domain12-20261018`。旧 graph 工作树及其未提交修改保留。
- 原始数据库 13 个用户、25 个项目、68 个 chat，无非终态 turn/待发消息/待审操作/执行 lease；2 个 running workflow 没有在途模型 job，保留原状态。
- 初次 gate 因恢复/审批 fixture 使用 `test-model` 被默认模型校验拒绝；修正 fixture 为允许模型后，定向 23 项与完整门控均通过。旧失败 runner 已终止，未将失败结果计为通过。
- 切换前停止旧服务，使用文件系统克隆备份完整数据目录，并用 SQLite backup API 另存停服时数据库。私有备份位于 `~/Library/Application Support/CodexHarnessRemote/backups/2026-10-18-domain12/`，凭据仅存在私有配置中。


## 数据、接口与安全影响

- 数据迁移：沿用远端迁移，副本重复迁移与完整性检查已通过；不新增应用数据迁移。
- API/协议：既有 API 形状和 CLI pin 不变；双方目录调整，默认模型必须属于允许目录。
- 权限与秘密：保留 ACL、官方 provider 限制、隐私 fail-closed、原生记忆禁用；仅本机私有配置保存部署路径。
- 回滚：保留旧工作树，停新服务后恢复一致性数据库/相关状态和旧启动入口；上线后若产生新业务数据，不以旧快照覆盖，先评估兼容并保留增量。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| git fetch origin（本机系统代理） | 通过 | origin/graph=060b52b |
| 固定 Codex CLI --version | 通过 | 0.150.0-alpha.8 |
| 新代码 CodexAppServerClient initialize / model/list / GPT-6.1 Sol ephemeral turn | 通过 | 列表返回 GPT-5.6 三模型；6.1 Sol 虽未列出，显式真实调用 completed 并有回复，不以列表判断失败 |
| `git diff --check` | 通过 | 无空白错误 |
| `python3 .tools/check-markdown-links.py` | 通过 | 67 个相对链接均存在 |
| `npm run gate` | 通过 | macOS Node 25.6.0、真实 Seatbelt；201 单元/集成 + 19 E2E，0 fail / 0 skip |
| `HarnessDatabase(loadConfig({DATABASE_PATH: ...}))` 对私有旧库副本连续打开两次 | 通过 | 每次 quick_check=ok，foreign_key_check=0，用户/项目/chat/turn/input 数量不变 |
| `node .tools/public-deployment-smoke.mjs` | 通过 | 双公网各 4 次 low 推理，共 8 次 completed、有回复且上报 Token；双方目录一致、默认 5.6 Sol、Astra PATCH 返回 400 INVALID_MODEL |
| 同一公网脚本：认证、文件、权限、用量 | 通过 | 员工真实密码登录；老板采用限时临时管理会话（未重置/读取老板密码），验证已有认证/ACL；双方文件往返、跨 chat 403、员工用量接口 403、老板用量可读 |
| `python3 .tools/verify-retention.py` | 通过 | 原 13 用户及密码/角色、25 项目、68 chat 及线程绑定、7 workflow 状态、15 submission 保留；quick_check=ok、外键错误 0 |
| 公网 HTML/版本资源哈希与本地 createStaticAssets 比较 | 通过 | 双域名资产版本均为 5f4989aa327c3c884908，与新代码一致，版本资源 immutable |
| `./bin/start-local.sh`、`./bin/status.sh`、双公网 `/api/health` | 通过 | 新工作树进程、Codex ready、memory index ready、Qwen disabled，隧道复用原 named job |

## 验收清理与回滚入口

- 公网测试只使用新建的两个临时项目和临时员工；两个项目经标准删除接口进入可恢复 trash，正式项目不动。临时员工已停用，保留其用量归属；因此当前用户总数为 14，其中原 13 用户均未改动。
- 临时管理员会话及员工会话全部撤销；无测试 active 用户/项目，无非终态 turn、待发输入、pending approval 或 lease。8 条测试推理用量保留，不伪造零消耗。
- 新服务由 `com.codex-harness-remote.server` 的 launchd job 管理；隧道继续复用原 named job。操作时从本聊天附加的新工作树运行 `./bin/status.sh`、`./bin/stop-local.sh`、`./bin/start-local.sh`。不要归档此运行工作树。
- 回滚先在新工作树运行 `./bin/stop-local.sh`，备份届时所有新增数据。当前验证已产生真实用量，不能直接用旧 SQLite 覆盖。优先前向修复；确需完整回退时，在明确保存/处理新增数据后，用私有 `pre-switch-data`（工作区、回收站、索引、会话）与 `pre-switch.sqlite` 恢复同一停服快照，确保没有旧 WAL/SHM 混入，再从旧 `codex-harness-graph` 目录运行 `./bin/start-local.sh`。旧源码和旧私有环境仍原样保留。
- 首次只读打开停服备份时，SQLite 的 WAL 模式尝试打开旁文件失败；对没有写者的 backup API 产物增加 `immutable=1` 后完成比较，生产库始终用普通 `mode=ro`，没有修改数据库规避检查。

## 结论

远端 graph 060b52b 加最小本机模型适配已部署到域名 1/2。完整门控、双角色四模型真实调用、禁用 Astra、Qwen disabled、记忆 ready、版本资产和数据保留均已验证。未更改域名 3/4 或桌面 Codex 全局配置。

## 遗留事项

- 微信代码及上游渠道能力保留，本次没有新增绑定或启动外部 relay；本机 WECHAT_CHANNEL_ENABLED=false。接通微信仍需明确绑定身份，不能把网页部署验收当作微信收发验收。
- Qwen 隐私执行按要求禁用；未安装/调用本机 Qwen。隐私代码和合成模型回归仍保留。
- 真实推理按 low 验收，不宣称已逐一测试所有推理强度组合。老板密码登录未用真实密码重验，员工公网密码登录与合成 E2E 双角色登录已验证。
- 域名 3/4 先前返回 Cloudflare 1033，其当前源站提交无法由健康接口确认；本次部署基线以已 fetch 的 origin/graph SHA 为准。
