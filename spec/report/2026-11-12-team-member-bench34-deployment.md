# 2026-11-12 Fast、归档和改密适配部署到 bench3/bench4

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署，完整 gate 与双角色公网真实推理通过） |
| 日期 | 2026-11-12 |
| 负责人 | Codex |
| 关联目标 | 拉取 team_member@96713b7，按用户确认保留线上能力后部署，说明相对现有版本的改进 |
| 影响范围 | 运行版本、兼容迁移、API/UI、部署配置、测试夹具、固定启停入口及文档 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[恢复](../architecture/06-persistence-events-and-recovery.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

交互主目录为 graph@060b52b，包含未提交修改。核对进程身份后确认实际旧生产目录为 unattended-graph-deploy，基线 b152171，并含本机认证适配。team_member 已拉取到精确 96713b78867f5c19b2729fcb9d485ea70ebd4c9c，该提交与生产的共同祖先为 7e084ae，属于旧基线上的功能提交。它缺少生产工作图、微信、隐私引擎、记忆、浏览器、用量等能力，远端报告明确这些功能已另行适配生产。

用户确认保留线上能力，将 Fast/归档/改密适配到当前版本。采用远端生产适配代码 c5bec0a 及验收提交 7d59a5c798a0eb5efe546d56988b8e3457026e79，延续 b152171，再三方合入本机既有认证修改。

## 目标与非目标

### 目标

- 完成指定代码获取、兼容适配、生产数据备份、完整 macOS 门控、双公网部署及真实请求验证。
- 保持本机认证、项目数据和原 Finder 启停入口可用，记录版本对比与回滚入口。

### 非目标

- 本次范围为 bench3/bench4 的 Fast、归档、改密发布，后续 Panelize 功能不在范围。

## 约束与风险

- 遵守 RUN-001/002/003/004/006、DAT-003/005/006、DEV-001/003/004/005/006。
- 协议保持生产精确 pin 0.164.0-alpha.11.1。项目私有 CODEX_HOME 继续复用原生历史与本机认证。
- 永久删除有不可恢复的产品语义，仍要求项目 ID 确认及运行/共享/保留工作树/工作图历史保护。
- Fast 实际延迟与上游配额有关，本次没有量化加速幅度。

## 实施计划

1. 核对实际进程与目标分支，确认兼容发布方式。
2. 独立检出生产适配版并三方合入本机修改，安装锁定依赖，验证迁移及完整 gate。
3. 确认空闲，停服一致性备份，切换 Portal 并检查整套服务。
4. 公网双角色合成验证，回收临时项目及会话，检查原业务数据。
5. 更新报告、索引、架构和启停说明，验证文档链接与 diff。

## 实际改动

- 实际运行目录为主仓库 `.tools/releases/bench34-fast-7d59a5c`，基线 7d59a5c 加原本机认证适配。原两个工作树及未提交修改保留。
- 合入 Fast 按钮/托管工具、项目归档和筛选、老板确认永久删除、自助密码及创建/重置密码确认。新功能由上游生产适配实现，保持隐私 chat、后台任务与工作图保护。
- 生产配置继承原 DATA_DIR、DATABASE_PATH、私有 CODEX_HOME、ChatGPT 模式、匹配 CLI、记忆 Python、Qwen 与角色域名。新目录独立复制 cloudflared，并显式绑定原微信 relay 目录。
- 首轮候选 gate 的 7 项失败来自手写测试配置遗漏显式 Python/Git 路径。四个测试文件现读取 COMMAND_PYTHON_BIN/COMMAND_GIT_BIN，保留所有断言和真实执行器。同步发布契约说明。
- 主目录 bin/services.sh 读取私有 `.tools/active-runtime` 并校验路径必须落在本仓库 `.tools/releases/`，再转发原 .command 操作。实际 status.command 已验证新 PID，原 Finder 启停入口可继续使用。

## 数据、接口与安全影响

- 幂等新增 chats.fast_mode 与 projects.archived，默认 false。生产副本连续迁移两次，45 张表原有行逐值一致，完整性正常。
- 新增 POST /api/me/password、POST /api/projects/:id/archive，PATCH chat 支持 fastMode，自定义密码创建/重置增加 passwordConfirmation。
- Fast 后续 root 固定 gpt-6-luna/high/fast，关闭恢复原偏好。项目归档为全局展示状态。改密撤销会话并排空任务，生产适配还处理微信代次和工作图成员。
- 未重置原账号密码。测试通过短期随机会话绑定既有角色，仅访问新建的合成项目，凭据与正文未写入报告。

## 验证

门控环境 PATH 为 `/Users/starwin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/starwin/.codex/worktrees/unattended-graph-deploy/codex-harness-remote/.tools/bin:/usr/bin:/bin:/usr/sbin:/sbin`，COMMAND_PYTHON_BIN 为 `/Users/starwin/.local/share/uv/python/cpython-3.12.14-macos-aarch64-none/bin/python3.12`，COMMAND_GIT_BIN 为 `/Library/Developer/CommandLineTools/usr/bin/git`。

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 原始 96713b7 独立目录 `npm run gate > /private/tmp/bench34-96713b7-gate.log 2>&1` | 通过 | 79 单元/集成 + 16 E2E，0 失败/跳过 |
| 最终适配目录 `npm run gate > /private/tmp/bench34-fast-gate-2.log 2>&1`，使用上述环境 | 通过，退出 0 | macOS loopback/Seatbelt，254 单元/集成 + 24 E2E，0 失败/跳过，含真实 Chrome、微信、工作图、改密会话失效与沙箱隔离 |
| `node .tools/check-migration.mjs` 与 SQLite 原始行比较 | 通过 | 两次迁移，45 张表原有值不变，quick_check=ok，外键错误 0 |
| 旧目录 `bash bin/stop-local.sh`，新目录 `bash bin/start-local.sh`、`bash bin/services.sh start` | 通过 | 新 Portal PID 92152，named tunnel 继续运行，微信 relay bound=true/phase=running |
| 新目录 `node .tools/public-fast-smoke.mjs > /private/tmp/bench34-fast-public-smoke-3.log 2>&1` | 通过，退出 0 | 老板/员工各完成 Fast 实际推理，持久最终回复匹配，用量 gpt-6-luna/high；双方归档/恢复成功 |
| 公网 curl 六场景 | 通过 | 两角色登录页 200，两个 health 为 Codex/Qwen/记忆 ready，匿名 me 均 401，资源版本同为 a7772c9c4e868f64ffd7 |
| 主目录 `bash status.command` | 通过 | 转发新部署，Portal/隧道/微信完整状态正常 |
| `bash -n bin/services.sh`、`git diff --check`、`git diff --cached --check` | 通过 | 主目录与候选目录分别检查 |
| 修改 Markdown 的相对链接验证 | 通过 | 收尾时检查全部修改 Markdown |

初次公网脚本的文本验证误把 SSE 分帧当作完整回复，模型运行已 completed。修正为检查持久化最终回复后完成两角色验证。其间一次显式代理 TLS 握手出现 ECONNRESET，使用正常 OS 路由后完成验收。

## 清理与回滚

- 停服数据 APFS 克隆和 SQLite backup、旧私有环境保存在主仓库 `.tools/backups/2026-11-12-bench34-fast`，目录 0700、敏感文件 0600，均在 Git 忽略目录。
- 原 8 用户、13 项目、22 access、17 chats、14 tasks、8 roadmaps、20 inputs 逐行未改，原 submission 无丢失。工作图保留全部记录，调度器更新 8 条运行的检查时间以及 8 条 job 的 due_at/updated_at。
- 合成项目均通过正常 DELETE 移入可恢复 trash，临时会话撤销。最终 quick_check=ok、外键错误 0、active run/lease/临时 session 均 0。两条原 paused 输入保留。
- 既有微信绑定保留，relay 状态 verified=false，未额外发微信消息。Qwen ready 已检查，本轮实际模型验证使用普通 GPT 路径。
- 回滚先排空并停新 Portal，备份切换后新增数据，使用旧生产工作树及其配置启动。原生 thread、业务目录与新库附加字段应保留，禁止直接覆盖上线新数据。主目录活动指针同时切回合规目录或移除后显式使用旧工作树操作。

## 结论

用户确认的兼容方案已部署至老板 workbench3、员工 workbench4。两端真实 Fast 请求、归档恢复、完整发布门控及生产数据保留检查通过。部署版本为 7d59a5c 加本机适配，原始 96713b7 已独立拉取保留。

## 遗留事项

- 本轮未量化 Fast 延迟，未进行手机扫码收发或 Qwen 新一轮推理验收。改密流程由完整 HTTP E2E 验证，原生产账号密码保持原值。
