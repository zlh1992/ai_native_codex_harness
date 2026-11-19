# 2026-10-11 Codex HOME 隔离：修复共享 models_cache 被旧版 pin 覆写

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-10-11 |
| 负责人 | starwin（本机运维 / 老板） |
| 关联目标 | 本机桌面 Codex 反馈“被降智”，输出质量明显下降；排查后定位为本项目固定版本 app-server 与桌面 Codex 共用 `~/.codex` 造成的共享状态污染 |
| 影响范围 | 代码（`src/config.mjs`、`src/codex-client.mjs`、`src/codex-search-service.mjs`）、脚本（`bin/_common.sh`、`bin/start-local.sh`）、运维（本机 launchd 监控与自愈）、文档、测试 |
| 架构规格 | [index 决策 8](../architecture/index.md)、[00 总览](../architecture/00-overview-and-decisions.md)、[01 组件](../architecture/01-system-context-and-components.md)、[02 约束](../architecture/02-project-constraints.md)、[04 信任边界](../architecture/04-security-and-trust-boundaries.md)、[06 持久化](../architecture/06-persistence-events-and-recovery.md)、[08 运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

本项目按发布契约把 app-server 精确 pin 在 `codex-cli 0.150.0-alpha.8`（见 08 第 48 行），而本机桌面 ChatGPT.app 内置 Codex 已升级到 `0.162.0-alpha.17.2`。两者此前共用同一个 `CODEX_HOME=~/.codex`：`bin/_common.sh:29` 与 `src/codex-client.mjs:85` 在未显式设置时都回落到 `$HOME/.codex`，`docs/SERVICE_CONTROL.md` 也把这一点写成当前行为。

Codex 会把服务端下发的模型清单缓存到 `$CODEX_HOME/models_cache.json`，并按拉取时的 `client_version` 决定返回哪一批模型。于是 0.150 的 app-server 每隔几分钟就以 `client_version=0.150.0` 重写这份缓存，把桌面版正在使用的模型元数据抹掉。

已验证事实（本机取证，均为只读观测）：

1. 线上端点按 `client_version` 分叉。同一份登录凭据实测：
   - `client_version=0.150.0` → 6 个模型：`gpt-reserve`、`gpt-5.6-sol/terra/luna`、`gpt-5.5`、`codex-auto-review`。
   - `client_version=0.162.0-alpha.17.2` → 额外含 `gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-6.1-sol`；`gpt-6-astra` 真实 `context_window=272000`，`gpt-6.1-sol` 为 `500000`。
2. `~/.codex/models_cache.json` 长期停留在 `client_version=0.150.0`、`models` 仅 6 项，且观测期间被反复重写（`15:00:38Z`、`15:03:42Z`、`15:28:19Z`、`15:31:22Z`）。
3. 桌面版因此持续记录 `WARN codex_models_manager::model_info: Unknown model gpt-6-astra is used. This will use fallback model metadata.`
4. fallback 元数据的上下文窗口是 `258400`，而 `gpt-6-astra` 真实值是 `272000`；近 3 天 rollout 中 `gpt-6-astra` 以 258400 计数出现 1333 次，`gpt-6.1-sol` 以 258400 出现 329 次（真实 500000，偏差 48%）。窗口偏小会让自动压缩提前触发，可观测后果是历史更早被裁掉。
5. 模型清单刷新本身也在失败：近 1 小时 84 次 `failed to refresh available models: request timed out`，本机直连 `chatgpt.com` 不通，必须经 `127.0.0.1:7897` 代理，因此缓存不会自愈。

推断（非直接证明）：提前压缩与 `model_reasoning_effort` 被压到 `low`（思考 token/输出 token 实测 20%，对照 `max` 档 44%）共同构成用户感知到的“降智”。effort 属于桌面侧配置，不在本报告改动范围内。

非本次问题：10-07～10-09 期间 `127.0.0.1:17841` 的连接拒绝来自更早的 `chatgpt-web` 第三方 provider 实验，10-09 23:36 后不再出现。

## 目标与非目标

### 目标

- Portal 启动的 app-server 不再与桌面 Codex 共用 `CODEX_HOME`，不再写 `~/.codex/models_cache.json`。
- 保持“单 app-server、单 `CODEX_HOME`、单上游 Codex 登录”不变量：项目内部仍然只有一个 `CODEX_HOME`，上游仍是同一份老板 ChatGPT 登录。
- `CODEX_HOME` 落在项目私有数据目录，随 `DATA_DIR` 一起可备份、可清理。
- 共用桌面家目录这一故障源不可能再被“无意恢复”：shell 启动链与 node spawn 两侧各自 fail closed，不提供静默绕过开关。
- 桌面侧具备常驻可观测与自愈：任何客户端再把旧 `client_version` 写进 `~/.codex/models_cache.json`，本机应在 5 分钟内发现、恢复并告警。
- 协议 pin 不变：仍精确使用 `codex-cli 0.150.0-alpha.8`。

### 非目标

- 不升级 CLI pin，不重生成 app-server schema。
- 不引入多租户隔离，不宣称敌对租户隔离能力。
- 不为 `local_private` 搜索进程改动（其已使用一次性私有目录）。

## 约束与风险

- 决策 8（index）与 00 的 R3 把“单 App Server、单 `CODEX_HOME`、单上游登录”登记为已知共享故障域。本次把共享对象从“与桌面共用”收敛为“项目内部单一”，缩窄而不放宽故障域；不削弱任何“必须”不变量。
- 04 第 17 行的 fail closed 约束保持不变：provider 仍必须为 `openai_http`，`validate_codex_upstream` 不动。
- 凭据风险：私有 home 需要上游登录。选择符号链接复用 `~/.codex/auth.json`（而非副本），避免两处独立刷新 refresh token 造成互相踢出；`installation_id` 同样链接，保持安装身份一致。
- 兼容风险：新 home 无 `[projects.*] trust_level`。已确认 Portal 每次 `thread/start` 与 turn 都显式传 `approvalPolicy: 'on-request'`（`src/codex-service.mjs:220`、`:711`），不依赖桌面 config 的项目信任表。
- 兼容风险：新 home 无桌面 `config.toml`，也就不会带入桌面插件/MCP。Portal 侧 `--disable` 列表本就关闭 plugins 等能力，方向一致。
- 模型可用性：`CODEX_MODEL=gpt-5.6-sol`、subagent `gpt-5.6-luna` 均在 0.150 清单内，隔离后不会出现新的“未知模型”回落。
- 回滚：删除新 home 并在 `.env` 显式设回 `CODEX_HOME=$HOME/.codex` 即可恢复原行为；无数据库迁移，无不可逆操作。

## 实施计划

1. `src/config.mjs` 新增 `codexHome`，默认 `DATA_DIR/codex-home`，显式 `CODEX_HOME` 优先。
2. `src/codex-client.mjs` 子进程环境默认取 `config.codexHome`，不再回落 `~/.codex`；spawn 前建立私有 home 并链接上游凭据，缺失则 fail closed。
3. `bin/_common.sh` 默认值与 `ensure_runtime_dirs` 同步为私有 home，保持 shell 与 node 一致。
4. 更新 `docs/SERVICE_CONTROL.md`、`docs/ARCHITECTURE.md` 中“读 `~/.codex`”的旧表述。
5. 更新架构文档：index 决策 8、00 R3、01 组件表、04 边界、06 灾备、08 运维。
6. 补测试：config 默认落在项目私有目录且不等于 `~/.codex`；`_common.sh` 与 `codex-client.mjs` 文本契约。
7. 重启本项目服务，实测 `~/.codex/models_cache.json` 改由 `0.162.0-alpha.17.2` 写入且含 gpt-6 模型；`npm run gate`。
8. 加两道 fail closed：`bin/_common.sh` 的 `validate_codex_home`（在 `start-local.sh` 启动链上）与 `bootstrapPrivateCodexHome` 的 `CODEX_HOME_SHARED_WITH_DESKTOP`，把“共用桌面家目录”变成不可能恢复的配置错误。
9. 桌面侧挂常驻监控与自愈（`com.starwin.codex-watch` / `com.starwin.codex-guard`），并以投毒演练验证“检测—恢复—告警”闭环。

## 实际改动

### 本仓库（消除故障源，保持既有不变量）

- `src/config.mjs`：新增 `codexHome`，默认 `DATA_DIR/codex-home`，显式 `CODEX_HOME` 优先。
- `src/codex-client.mjs`：子进程环境改为 `childEnv.CODEX_HOME ||= this.config.codexHome`，不再回落 `~/.codex`；新增导出 `bootstrapPrivateCodexHome(codexHome, sharedHome)`，在 spawn 前建 0700 目录并把 `auth.json`、`installation_id` 符号链接到本机登录，缺凭据以 `CODEX_HOME_UNAUTHENTICATED` 失败；若 `codexHome` 与 `$HOME/.codex` 指向同一目录（`samePath` 用 realpath 归一，符号链接也拦），以 `CODEX_HOME_SHARED_WITH_DESKTOP` 直接拒绝，不提供绕过开关。
- `src/codex-search-service.mjs`：auth 候选路径先取 `CODEX_HOME` 再回落 `~/.codex`。
- `bin/_common.sh`：`CODEX_HOME` 默认 `$DATA_DIR_ABS/codex-home`；`ensure_runtime_dirs` 建目录（0700）并链接凭据；新增 `validate_codex_home`，共用桌面家目录时打印“拒绝启动…”并返回 2。
- `bin/start-local.sh`：在 `validate_codex_upstream` 之后调用 `validate_codex_home`。`bin/start-public.sh` 与 `bin/services.sh start` 都经 `start-local.sh`，因此手动与 launchd 启动链一致受保护；`stop-*` 不受影响，停机永远可执行。
- 测试：`test/codex-client.test.mjs` 新增私有 home 引导（链接凭据、幂等、缺凭据 fail closed）与“拒绝与桌面共用 home 且不留半成品目录”两例；`test/protocol.test.mjs` 的私有 home 契约新增 `validate_codex_home`（`_common.sh` 定义、`start-local.sh` 调用）与 `CODEX_HOME_SHARED_WITH_DESKTOP` 文本契约。
- 文档：`docs/ARCHITECTURE.md`、`docs/SERVICE_CONTROL.md`、`spec/architecture/{index,00,01,04,06,08}` 由“读 `~/.codex`”改为项目私有 home，并记录两道 fail closed 与运维判据。

### 桌面与本机运维（仓库之外，老板授权后进行）

- `~/.codex/config.toml`：`model = "gpt-6-astra"` → `"gpt-6.1-sol"`（真实窗口 500000，非 fallback 的 258400），`model_reasoning_effort` → `"high"`；原文件备份为 `config.toml.before-raise-effort-<timestamp>`。
- 常驻监控：`~/bin/codex-traffic-watch.py`（`watch|audit|requests|tokens|guard|snapshot`）与 `~/bin/codex-traffic-watchd.sh`（launchd 包装，20MB 滚动日志）。
- LaunchAgent：`com.starwin.codex-watch`（KeepAlive，逐条记录桌面每次 `POST /responses` 与返回 token）、`com.starwin.codex-guard`（每 300 秒体检）。guard 健康时把正确清单刷新为金本位 `~/Library/Application Support/CodexTraffic/models_cache.golden.json`；检测到 `client_version` 落后于桌面 CLI 或正在使用的模型缺席时，用金本位原子覆盖恢复并弹 macOS 通知（退出码 2 表示“已自愈需重启桌面 app”，1 表示未能自愈）。
- 其它客户端排查：微信 bridge（launchd `local.wechat-codex`）使用 `/Applications/ChatGPT.app/Contents/Resources/codex`，即桌面同版本 0.162，不会再写旧 `client_version`；`/usr/local/bin`、`/opt/homebrew/bin`、`~/.local/bin` 上均无 `codex`。至此旧 `client_version` 的唯一来源就是本项目 pin，已隔离。

## 数据、接口与安全影响

- 数据迁移：无。新增目录 `DATA_DIR/codex-home`（0700），其中 `auth.json`、`installation_id` 为指向 `$HOME/.codex` 的符号链接。
- API/协议：无变化。app-server pin 仍为 `0.150.0-alpha.8`，Portal 对外接口与事件不变。
- 新增失败模式：`CODEX_HOME_SHARED_WITH_DESKTOP`（spawn 前）、`validate_codex_home` 返回 2（启动前）。两者都是配置错误的显式拒绝，不会静默降级；`stop` 路径不校验，保证任何时候可停机。
- 权限与秘密：私有 home 0700；凭据以符号链接复用，磁盘上不产生第二份 token 副本，日志与本报告不含凭据内容；金本位副本 0600 且位于 `CODEX_HOME` 之外，不含 token。
- 回滚：删除新 home，`.env` 显式设 `CODEX_HOME=$HOME/.codex` 并重启即恢复旧行为（但会重新引入本故障，仅用于取证）；监控回滚 `launchctl bootout gui/$(id -u)/com.starwin.codex-watch` 与 `.../com.starwin.codex-guard`；桌面配置回滚用上述 `config.toml.before-raise-effort-*` 备份。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm test` | 通过 | 203 tests / 203 pass / 0 fail（含新增共用 home 拒绝用例） |
| `npm run gate` | 通过 | exit=0，19 个 e2e 全绿，含 fixed Portal release gate |
| `git diff --check` | 通过 | 无空白错误 |
| 重启后 `~/.codex/models_cache.json` | 已自愈 | 隔离后 `10-11 01:43:28` 由桌面 `client_version=0.162.0` 首次写回 10 个模型；`10:28:26` 再次刷新仍为 `0.162.0` / 10 项，含 `gpt-6.1-sol`（500000）与 `gpt-6-astra`（272000） |
| 桌面 `Unknown model ... fallback` | 归零 | `logs_2.sqlite` 中最后一次 `Unknown model` 为 `10-10 23:xx`（隔离前），此后 0 次；`failed to refresh available models` 最后一次 `10-11 02:50:43`，此后 7 小时以上未复发 |
| 私有 home 生效 | 通过 | app-server PID 5975 环境 `CODEX_HOME=…/.data/codex-home`，目录 0700，`auth.json`/`installation_id` 为符号链接；其私有缓存 `client_version=0.150.0` 停留在项目内，不再外溢 |
| `lsof +D ~/.codex` | 通过 | 仅桌面 `ChatGPT.app`/`codex` 与桌面 `codex-dev.db`，本项目进程不再持有桌面家目录文件 |
| `validate_codex_home` 冒烟 | 通过 | `CODEX_HOME=$HOME/.codex` → rc=2 并打印拒绝；私有目录 → rc=0；默认值解析为 `.data/codex-home` |
| 投毒演练（临时 fixture，不落真实家目录） | 通过 | 伪造 `0.150.0`/6 模型 → guard 判“版本不一致 + 模型缺席” → 自愈为 `0.162.0`/10 → exit=2；第二次 guard exit=0；fixture 已删除 |
| Portal `/api/health` | 通过 | `ok=true`、`codexState=ready`、`memory.index=ready`、`nativeCodexMemory=false`、`localQwen=ready` |
| 公网入口 | 通过 | `https://workbench3.winy.cc/boss/login` 与 `https://workbench4.winy.cc/employee` 均 HTTP 200（重启窗口内隧道未中断） |
| launchd 常驻 | 通过 | `launchctl list` 两项均在；`guard.log` 记录 `exit=0 / ok` 并已生成金本位副本 |

## 结论

根因不是模型被“降级”，而是同一台机器上两个不同 `client_version` 的 Codex 客户端争抢一份 `models_cache.json`：本项目 pin 的 0.150 每几分钟就把桌面正在用的 gpt-6 元数据抹成 6 项旧清单，桌面据此把自己的模型判为未知、退回 `258400` 的 fallback 窗口并提前自动压缩。把 app-server 收敛到项目私有 `CODEX_HOME` 后，桌面在同一份登录、同一份代理链路下立即恢复拿到 10 项真实清单，`Unknown model` 归零；本项目行为不变（`gpt-5.6-sol`/`gpt-5.6-luna` 本就在 0.150 清单内），单 app-server、单 `CODEX_HOME`、单上游登录的不变量保持。故障源另有两道 fail closed 兜底，共用桌面家目录已无法被无意恢复；桌面侧再由 guard 做“检测—恢复—告警”闭环，即使将来出现新的旧客户端（含本仓库之外的第三方 bridge），也会在 5 分钟内被拉回。

## 遗留事项

- 桌面 ChatGPT.app 需重启一次，`config.toml` 里新的 `gpt-6.1-sol` + `high` 才会在新的 app-server 进程上生效。
- ~~本机直连 `chatgpt.com` 仍不通，模型清单刷新依赖 Clash Verge 的系统代理 `127.0.0.1:7897`~~ —— **2026-10-11 晚间已变更**：本机已切到 Clash Verge TUN 模式（虚拟网卡 + fake-ip），原先"裸连必死、只剩代理一条路"的无退路状态已消除，详见文末《追加》第 1 节。刷新超时本身仍在，但根因已定位为公网晚高峰，与代理形态无关。
- 本仓库所有改动尚未 `git commit`（分支 `graph`，另有老板既有的未提交改动未触碰），提交时机由老板决定。
- 监控器目前只覆盖桌面家目录 `~/.codex`；若以后新增其它 `CODEX_HOME` 的桌面级客户端，需按同一份金本位机制扩展一份实例。
