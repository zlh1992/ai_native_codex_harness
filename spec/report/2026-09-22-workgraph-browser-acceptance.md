# 2026-09-22 Workgraph Chrome 双员工闭环验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署、Chrome 三轮复验） |
| 日期 | 2026-09-22 |
| 负责人 | Codex |
| 关联目标 | 老板生成并自动派发工作图，两位员工在各自界面完成清单与交付，持续推进至完成；发现问题后修复发布并重新验收 |
| 影响范围 | Chrome 用户动线、任务看板、交付与审核、按发现修复代码和测试、运维 |
| 架构规格 | [领域模型](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[持久化](../architecture/06-persistence-events-and-recovery.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[运维](../architecture/08-operations-protocol-and-evolution.md)、[多人工作图](../architecture/09-human-work-graph.md) |

## 背景与证据

用户要求通过真实 Chrome 和指定的一个老板、两个员工账号完成实际 Workgraph，重点检查收到任务、清单、提交、审核、待办卡片清除与下游推进。当前正式服务运行 graph 工作树；health 的 Codex 与记忆索引 ready，本地 DeepSeek disabled。已有模型权限与 Token 看板变更保持原样。

最初 Chrome 控制工具创建标签页超时，多次重试仍连接失败。用户随后明确授权替代 UI 控制方式，现通过独立可见 Chrome profile 的回环 CDP 操作真实网页；凭据只保留内存，禁止保存密码。独立 profile 在验收退出后清理。不能以 API 或测试替代浏览器验收。

开始前只读状态查询确认没有活跃模型运行；已有工作图 passed 1 / running 2，后台作业 succeeded 26。未修改既有图、任务、账号或文件。

## 目标与非目标

### 目标

- 用新建合成验收项目运行至少包含两名员工和依赖交接的完整工作图。
- 在真实员工界面完成清单、成果、提交，检查无需重登录的状态同步与看板流转。
- 用证据复现问题并修复；若发布修复，则安全重启并用新工作图再验收。
- 保留不可变提交与审核证据，记录验收项目标识和实际最终状态。

### 非目标

- 不修改既有业务项目、历史交付、账号密码和策略，不启用本地模型。
- 不通过数据库手改任务状态伪造流程完成，不删除历史证据以清空看板。

## 约束与风险

- 遵循 PRD-001/003/004、DAT-001/002/006/007、WFG-001/002/003、DEV-001/003/004。
- 只在新增验收项目执行；账号凭据仅用于登录，不写入文件、报告或日志。
- 原浏览器控制连接失败已通过用户明确授权的独立 Chrome/CDP 方式解决，验收操作仍来自真实页面。
- 发布前检查并排空活动运行、备份数据库，保留前一任务未提交的源码改动。
- 工作图项目可能因证据保留不能普通删除；完成卡片应进入已通过，而非删除提交记录。

## 实施计划

1. 读取规范及任务、提交、看板刷新实现，建立新验收记录。
2. Chrome 分别登录老板与两位员工，生成并自动启动合成工作图。
3. 操作每个员工的交付流程，记录当前图的状态、交接、看板与最终证据。
4. 对实际问题增加有意义的回归并修复，同步架构与操作说明。
5. 执行 macOS gate、差异空白与相对链接检查；必要时备份并重启正式服务。
6. 新建工作图重复真实页面闭环，检查最终状态与无活动残留，完成报告。

## 实际改动

- 第一轮 Chrome 实测完成：新项目 `eb9e0b81-d189-4d62-9520-a9f0c3d20827`，图 `6845dc7f-ad97-4a45-a30b-0930136e93b7`，两位员工并行交付后自动激活汇总，三个节点和整图 passed。两位员工各自看板 active/review 均 0，done 分别 2/1；老板待开始、进行中、待验收均 0。测试资料只有合成文本。
- 第二轮新项目 `66884f1c-96ce-42e6-9487-dc914447c21f`，图 `267db3b5-ccc9-4d5d-bc29-ffd6f772b360` 已 passed。故意缺项的合成附件被自动打回，失败清单项复位、任务升 V2、V1 对话禁止继续发送；员工进入 V2 让真实 Codex 修正文档，以最终回复提交，再向下游交接。老板查看固定最终文件及 AI 意见后人工通过，两名员工各自 active/review 均 0、done 均 1。
- SQLite 只读复验上述两图及全部五个任务 passed；6 份提交（manual 5 / codex 1）均有固定 Git commit/tree，5 份 passed 均有 delivery commit，返工的旧提交保留。没有手改业务状态。两轮 Chrome 页面 JavaScript 异常为 0。
- 实测切换项目后残留上一项目的规划完成文案；代码确认 `selectProject` 未清空规划状态，`generate` 异步回执使用当前 projectId 而非发起项目，存在迟到回执跨项目污染。已按发起项目保存回执/重试身份，并以选择世代防止更新错误页面；轮询额外校验 jobId，退出替换状态容器以废弃迟到回执。
- 新增 `test/work-graph-navigation.test.mjs` 五项回归，原代码 5 项均失败，修复后全部通过；连同导航和任务动线共 29 项通过。
- 完整 macOS `npm run gate` 通过（181 单元/集成 + 19 E2E，0 失败/跳过），日志 `/tmp/workgraph-browser-gate.log`。正式运行/待发输入/后台作业均 0 后安全停服备份、重启，PID 19022；Codex 与记忆索引 ready，DeepSeek 保持 disabled。
- 备份位于 remote `.data/backups/20260922-014753-workgraph-browser/`：SQLite 自包含备份 integrity ok、源码归档、改动前 runtime 单文件及发布元数据，目录 0700、文件 0600。改动前 runtime 字节已与停止前服务资源匹配。
- 新建发布复验项目 `5f81ced0-1995-4da9-8fc3-14b9110a2287`。Chrome 从资产版本 `497a3ca4268cf39f5e08` 切换到 `12668884c74f5f181b71`。以 CDP 暂缓真实规划 HTTP 202 响应交付，切到旧项目后释放：旧项目未出现错误回执，回执保存在发起项目，返回该项目恢复真实规划进度。未改请求或服务器结果。
- 第三轮图 `4378d2a9-2b36-4a0a-8026-053a9eda769d` 的两节点和整图 passed。第二员工保持打开的等待详情自动变为进行中并出现交接/提交入口；打开上游文件、勾选、上传、提交后，老板打开的审核详情自动变为已通过并移除审核按钮。员工各自 active/review 均 0、done 均 1，JS 异常 0。
- 三轮最终只读审计：3 图 / 7 任务全 passed，8 份固定提交保留，其中 7 passed 带 delivery commit、1 旧返工提交保留；每图两位员工分别绑定两个独立 worktree；所有本次后台工作 succeeded。数据库 integrity ok、foreign key error 0，全站 active run / queued input / active job 均 0，原有两张 running 业务图仍保留。
- 27 项针对性自动测试通过，包括隔离服务器上的规划、自动分享、人工提交、审核返工、并行汇合、最终交付、重启恢复、文件交付以及 DOM 导航/状态同步；使用 fake Codex，不等同真实模型/浏览器验收。

## 数据、接口与安全影响

- 数据迁移：本次无；仅新增合成验收项目、图、任务、提交、交付及通常的计量记录。
- API/协议：无变更，精确 Codex CLI pin 保持 0.150.0-alpha.8。
- 权限与秘密：沿用角色、项目、任务权限；不保存登录凭据或完整提示词。
- 回滚：排空并停服，把备份 `rollback-work-graph.js` 恢复到 `public/work-graph.js` 后重启；该文件是本次唯一 runtime 修改。保留数据库、新图及提交，不回退前一项模型/用量功能，不以旧数据库覆盖新业务记录。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 正式 `/api/health` | 通过 | HTTP/Codex ready；本地模型 disabled |
| Chrome 原控制工具 | 连接失败 | 创建页超时，清单请求失败，无可操作标签页 |
| 双公网登录页与真实账号登录 | 通过 | HTTP 200；真实 Chrome 分别登录指定老板及两员工，同一 Chrome 标签页员工身份独立，重启刷新仍保持正确身份 |
| `node --test --test-concurrency=1 test/task-flow.test.mjs test/navigation.test.mjs test/task-graph-filter.test.mjs test/e2e/work-graph.test.mjs` | 通过 | 27 passed、0 failed、0 skipped；临时夹具退出清理 |
| `node --test test/work-graph-navigation.test.mjs test/task-flow.test.mjs test/navigation.test.mjs` | 通过 | 29 passed；新增 5 项先复现失败再通过 |
| 真实双员工工作图 | 通过 | A 并行汇总全自动、B 自动返工 + Codex V2 提交 + 老板最终审核、C 发布后重新生成并自动完成 |
| Chrome 延迟规划响应 / 切项目 | 通过 | 原项目保存回执，其他项目不被污染；已完成后再次切项目立即清空旧提示 |
| 双公网 `/assets/12668884c74f5f181b71/work-graph.js` | 通过 | curl 获取后 SHA-256 均与当前工作树一致，两个 health 均 Codex ready |
| `python3 /tmp/workgraph-live-audit.py` | 通过 | 三图七任务、Git 快照/交付、双员工 worktree、数据库完整性和无活动残留断言通过 |
| `git diff --check` | 通过 | 当前工作树无差异空白错误 |
| `npm run gate > /tmp/workgraph-browser-gate.log 2>&1` | 通过 | macOS，181 + 19，0 failed / skipped；退出 0 |
| `python3 /tmp/harness-check-markdown-links.py` | 通过 | 54 文档、247 个相对链接，0 断链 |

## 清理与证据保留

- 三个合成项目和已完成卡片作为验收证据保留，名称为 `Chrome双员工闭环验收-0922-A/B/C-发布复验`（A、B 无最后后缀）。未删除不可变交付，也未以清除历史代替状态流转；可按工作图筛选查看。
- 本次三账号会话均从各自真实页面退出。退出一个员工后，另一个员工和老板仍认证成功。随后关闭独立 Chrome 并删除本次临时 profile；用户原 Chrome profile 未操作。
- 本次截图仅含合成任务：`/tmp/workgraph-A-boss-completed.png`、`/tmp/workgraph-C-boss-completed.png`、`/tmp/workgraph-C-gw-completed.png`。测试服务和临时 HTTP 夹具均退出；生产 Portal/隧道继续运行。
- 凭据未写入脚本、源码、报告或输出日志，不保存浏览器密码。代码改动保留在当前工作树，未新增 Git 提交或推送。

## 结论

目标已完成。使用指定账号在真实 Chrome 完成三轮工作图，其中一轮在修复、门控和正式服务重启之后新建并完成。员工收到任务、勾选、提交、返工、交接、最终验收与看板清除未完成状态均有页面及持久证据；发现的规划进度跨项目污染已修复并经真实迟到响应场景复验。当前版本已部署。

## 遗留事项

- 本目标无未完成项。原有两张业务图不属于本次合成验收，保持原状。
