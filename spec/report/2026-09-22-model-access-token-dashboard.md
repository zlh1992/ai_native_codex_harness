# 2026-09-22 员工模型开放与 Token 看板

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署） |
| 日期 | 2026-09-22 |
| 负责人 | Codex |
| 关联目标 | 员工全部 GPT 模型、按对话强度、网站全部调用 Token 看板 |
| 影响范围 | API、UI、SQLite、运行采集、测试、运维 |
| 架构规格 | [领域](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[运行](../architecture/05-execution-concurrency-and-lifecycle.md)、[持久化](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[隐私](../architecture/10-local-private-projects.md) |

## 背景与证据

线上使用本工作树；员工模型此前固定服务默认，强度仅页面选择。已有 root usage journal 不涵盖全部辅助请求；本地引擎默认禁用。不能以旧事件宣称完整历史账单。

## 目标与非目标

### 目标

- 老板与员工均可选择七种现有 GPT；员工默认 medium，老板保持配置默认 high，模型/强度独立按 chat 保存。
- 全网站 root、子代理、搜索、工具摘要、本地推理/压缩计量，老板查看总量、员工、模型与每日趋势。
- 完整保留 ACL、隐私路由、排队、失败和恢复契约；门控通过后备份和安全发布。

### 非目标

- 不启用 DeepSeek，不改 CLI pin、模型白名单或固定 Luna 辅助策略；不记录正文，不计算费用，不统计网站外请求，不回填旧记录。

## 约束与风险

- PRD-001/002/009、RUN-006、DAT-006、DEV-001 至 DEV-006。计量不得扩大内容权限或引入云端隐私摘要。
- 累计 Token、fork/resume、重复/迟到通知及多步调用可能重复计数；建立持久基线和调用去重，无法证明完整时明确标记。
- 缺少上游 usage 不可当零；实际 DeepSeek 尚未启用，合成测试不代替真实模型验收。

## 实施计划

1. 集中角色默认与模型/强度校验，增加 nullable preferred_effort；前端持久化与队列冻结。
2. 添加独立计量账本/基线与聚合接口，接入 Codex root/子代理、独立搜索/摘要、DSH 流请求。
3. 增加老板 Token 指标、筛选、趋势和员工/模型表，处理缺失数据与身份切换。
4. 补迁移、计量、权限、UI 和 HTTP 场景，同步架构，完整执行 gate/link/diff 检查。
5. 排空并备份，重启正式服务，验证健康、身份接口与公网资源，记录回滚和验收限制。

## 实际改动

- `models.mjs`、DB、队列、HTTP 与聊天 UI：统一七种模型目录；员工默认 medium、老板保持 high。新增 nullable `preferred_effort`，按对话保存；保存期间禁止发送，失败恢复原值，运行/恢复/待发送队列阻止修改。旧模型偏好保留，分享新副本使用接收者默认，明确非法强度在建立 SSE 前返回 400。
- `token-usage.mjs`：独立 calls/streams/samples/meta 表，数值计量与原生 thread/turn 基线持久化；重复样本去重，未知 resume/fork 基线保守计入已知下限并标注不完整，乱序累计不回退水位。调用前冻结归属、模型、强度；删除 chat 不删除账本。启动恢复只在正式 server 执行。
- Codex root/子代理和独立搜索/工具摘要接入相同账本。计量处理先于活动运行过滤，接收迟到通知；root 在 turn/start 响应确认 ID 后处理提前通知，避免把恢复旧样本算到新调用。子代理沿用现有受验证的 native parent/root 关系，不以工具输出授予线程权限。
- `local-usage.mjs` 在 DSH 实际 HTTP 流中采集数值 usage，通过异步上下文区分 root/compaction；缓存计入含缓存输入，不把框架默认零或估算当作实际消耗。失败/取消保留已上报值，缺失显示不完整。没有启用本地模型。
- `token-dashboard.js` 与老板页面：四卡、每日趋势、员工/模型/强度/类别表，日期/用户/引擎/模型筛选，北京时间默认七天，可见时 30 秒刷新及手动刷新；显示采集开始时间、缺失/不完整和引擎未启用状态。
- 同步领域、安全、运行、持久化、发布、运维、隐私架构及双方操作文档。无依赖、CLI pin 或模型默认变更。

实现口径：GPT 账本以 native turn 为稳定计量单元，累计同一 turn 的多步模型消耗；DeepSeek 以实际 HTTP 推理请求为单位。界面的调用数用于完整性说明，不是费用或供应商账单请求次数。

## 数据、接口与安全影响

- 数据：幂等增加可空 chat 强度字段及独立计量表；账本不随业务 chat 删除。生产库迁移前后一致性检查均为 ok，无外键违规，不从历史事件回填。
- 接口：`/api/me` 模型与角色默认，PATCH chat `preferredEffort`，老板专用 `GET /api/admin/token-usage`；所有筛选经校验及参数化查询。
- 安全：只保存归属和计量元数据；跨用户统计仅限老板，不返回正文或内部原生标识，不扩大老板的员工内容读取权。隐私的 boss-only、不可分享、回环模型、命令禁网、审批和 query-only 搜索边界保持。
- 回滚：还原此次代码，保留新增数据表/字段，不切回不支持隐私项目的旧版本；回退期间缺少采集的时间须作为空窗处理。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm run gate > /tmp/harness-release-verified.log 2>&1` | 通过 | macOS 真实回环/Seatbelt：176 单元/集成 + 19 E2E，0 失败、0 跳过；最终运行代码通过 |
| `git diff --check` | 通过 | 无空白错误 |
| `python3 /tmp/harness-check-markdown-links.py` | 通过 | README、docs、spec 共 53 文档的 239 个相对链接，0 断链 |
| `node /tmp/harness-browser-qa.mjs` | 通过 | 隔离 Chrome，1440px 桌面与 390px 手机实际布局无横向溢出、0 JS 异常；合成计量数据，无生产内容截图 |
| `node /tmp/harness-live-acceptance.mjs` | 通过 | 正式 HTTP：双方 7 模型可选、medium/high 默认、新临时会话恢复偏好、跨人修改及员工统计 403、非法强度 400；汇总=角色分项=趋势=模型合计 |
| 真实 GPT 推理与保留 | 通过 | 单次老板 Sol-medium 合成验收，无工具、禁用该测试 chat 的记忆读写；usage 完整上报 11,889 Token，删除测试 chat 后账本保留 |
| 公网 `curl -f -sS --max-time 20` | 通过 | 两个 HTTPS 登录入口与健康接口 200；boss.js/token-dashboard.js/boss.css/app.js 与部署文件 SHA-256 一致 |

单元/HTTP 契约覆盖迁移、旧 chat 默认、独立偏好、队列冻结、越权、重复样本、多步/子代理、fork/resume、重启、失败/取消、迟到样本/摘要、日期边界、删除保留、缓存与本地压缩。真实推理只验收 Sol-medium；七种模型均验证了网站授权和偏好保存，上游不支持的组合仍明确报错。

生产验收以短期、内存生成凭据的隔离会话调用现有角色权限，未更改账号密码或原会话。只创建两个合成空项目及其新 chat，不读取原有对话正文；测试 chat 关闭记忆。四个临时会话、两个测试项目及其回收站副本已删除。标准原生运行记录和 11,889 Token 账目按保留策略留下，归属老板验收调用。凭据、Cookie、原始流和业务正文未输出或写入本报告。

## 清理与回滚

- 2026-09-22 北京时间 01:18 发布前确认活动运行、待发送输入、待审批均为 0，工作图任务只有 succeeded。停止 graph 服务后用 SQLite backup API 一致性备份，再启动服务完成兼容迁移；原有隧道保持运行。
- 受限备份目录：`codex-harness-remote/.data/backups/20260922-011812-model-token-dashboard/`，目录 0700、文件 0600。包含 `harness.sqlite`、`rollback-code.tar`、`release.json`；代码快照为此前 HEAD `b2f1771dbdf47d7bcdb01dc95364a34c4fe94711`。未复制或更改 `.env`、模型配置和项目文件。
- 采集正式始于 `2026-09-21T17:18:18.442Z`，即北京时间 2026-09-22 01:18:18。HTTP/Codex/记忆索引 ready，本地 DeepSeek disabled。
- 已关闭隔离布局预览进程；自动浏览器使用独立 profile，不修改用户浏览器。生产合成项目和临时会话清理情况见上。
- 若需回滚：先排空并 `bash bin/stop-local.sh`，从受限 `rollback-code.tar` 恢复此前源文件并移走本次新增运行模块，保留 `.env`、生产数据目录及新增字段/账本，然后 `bash bin/start-local.sh` 验证健康。不要通过还原旧数据库丢弃上线后的记录；数据库备份仅用于单独审查后的灾难恢复。

## 结论

范围内目标已实现并部署至实际运行的 graph 网站。老板和员工入口可用，双方普通项目模型目录一致、角色默认与 chat 偏好生效，老板看板可查询本网站新采集用量，权限和隐私契约通过门控。当前服务正常。

## 遗留事项

- 真实 DeepSeek 推理/计量需模型启用后验收。
- 旧账、网站外调用和费用不在统计范围；无法证明完整的上游数据继续以不完整状态展示，不推算补齐。
