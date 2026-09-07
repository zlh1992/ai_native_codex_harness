# 2026-09-06 多人 Work Graph 实施

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（未部署生产） |
| 日期 | 2026-09-06 至 2026-09-07 |
| 负责人 | Codex |
| 关联目标 | 实施 [完整计划](2026-09-06-human-work-graph-plan.md) 的 P0–P4 |
| 影响范围 | 数据库、业务服务、API、前端、受管 skills、架构规格与测试 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[领域](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[运行](../architecture/05-execution-concurrency-and-lifecycle.md)、[恢复](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

用户已批准完整计划并明确要求在 `team_member_work_graph` 分支实施。已从 `team_member` 创建该分支，保留前一轮计划报告和索引修改。起点为既有线性 roadmap、多人 project access/worktree、Codex submission 和 owner Git delivery。

## 目标与非目标

### 目标

- 员工资料与项目资料驱动的一句话生成、校验、编辑和启动图。
- 多人自动分享、依赖/并行/汇合、员工 checklist、人工与 Codex 提交、成果同步。
- 人工/辅助/自动审核、返工、持久调度、重试恢复、暂停/取消、ACL 与容量约束。
- 用既有任务首页承载老板图及员工待办，验证完整 P0–P4 闭环。

### 非目标

- 不改变计划中明确暂缓的多组织、自由画布、外部 IM、任意条件分支或每任务 worktree。
- 不自动部署或重启生产服务，不放宽原有发布契约。

## 约束与风险

- 保持所有既有 linear 与显式 share 契约，图业务采用单独 kind 分支。
- 新 schema 必须幂等，人工提交迁移保留所有旧证据和外键。
- 自动审核、Git 交付与任务推进分阶段收敛；权限撤销与迟到回报必须有围栏。
- 私有输入和 transcript 不作为项目事件广播；自动 share 不复制规划历史。

## 实施计划

1. P0：数据库扩展、图契约和状态模型、服务提取，先验证兼容与迁移。
2. P1：员工资料、固定项目输入、受管 planner 与计划 API/UI。
3. P2：批量分享、待办、两种提交、审核、handoff 和项目事件。
4. P3：持久 job、自动 reviewer、恢复、暂停取消与预算。
5. P4：完整前端、业务 E2E、规格与操作文档、`npm run gate`、链接/空白检查和可用的隔离真实验证。

## 实际改动

- P0：新增 schema/contract/store，submission 表重建支持 manual CHECK 与原有 native 证据，保留 linear 路径；提取分享与审核服务。
- P1：员工资料 revision 表单/API，固定项目文本和候选员工投影，受限 planner skill/tool、草稿增删改和启动。
- P2：批量 files_only 准备与原子发布、清单/两类提交、固定文件预览下载、Git delivery/handoff 与前序 fast-forward、按接收者过滤的项目事件。
- P3：持久工作、租约、补偿、模型串行/容量退避、auto/assisted 审核、返工预算、策略 epoch、暂停取消和清理，保留不确定原生调用的人工确认。
- P4：截图风格老板任务首页、分层图/缩放/关联高亮/列表、员工交付抽屉、员工资料表单，新增单元与 HTTP 闭环测试，三个运维开关和操作说明。
- 浏览器发现 CSP 拦截 HTML 内联坐标导致重叠，已改为 DOM style 属性设置，保留安全头。表单沿用黑绿主题。小屏默认列表。
- 重启 E2E 发现 fake app-server 的 turn 序号重启后复用，触发原生 turn 唯一性约束；测试替身改为进程标识加序号，保持真实协议的唯一身份语义。
- 合并同次 Git rev-parse 的 HEAD/tree 与根目录/HEAD 查询，减少共享和交付路径的子进程开销，保持全部 SHA、路径及祖先校验。宿主高负载下旧 E2E 两轮触及总计 60 秒上限，未延长契约。
- 验证调整：增加 Git/Seatbelt 业务测试后，默认测试文件并行使旧审批等待两次超时。`npm test` 改为按文件顺序执行，不删除用例、不放宽断言或超时。
- 计划调整：逾期检查与依赖补偿共用 30 秒 DB 扫描，事件按任务版本去重，省去第二套定时器；不额外引入 skill 插件市场或外部消息服务。
- 固定成果预览以转义文本/附件呈现；原有工作台 HTML sandbox 渲染保留，图抽屉不执行主动内容。

## 数据、接口与安全影响

- 数据迁移：新增七个业务表及领域扩展，幂等迁移、FK 校验；未操作生产数据库。
- API/协议：新增接口与约束见 [工作图架构](../architecture/09-human-work-graph.md)；保留精确 Codex pin。
- 权限与秘密：项目/员工/任务版本与后台授权复验，保留日志脱敏。
- 回滚：禁用新派发，排空后台运行，备份 SQLite/worktree，再回退兼容代码；不得删除交付证据。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git branch --show-current` | 通过 | 最终开发 worktree 为 `graph`，基线 `966ab34` |
| `node --test test/work-graph.test.mjs` | 通过 | 14 项；含有数据旧库重复迁移、真实 Git、三人分支汇合/返工、ACL、租约、容量等待与清理 |
| `node --test test/e2e/work-graph.test.mjs` | 通过 | fake 原生工具协议 + HTTP 自动闭环 |
| `node --test /tmp/work-graph-real-smoke.mjs` | 通过 | 精确 pinned Codex：生成、拒绝错误缺项、修正后通过，158.6 秒 |
| 浏览器隔离冒烟 | 通过（前阶段，同一功能代码） | 老板入口、黑绿分层图已目视验证；员工勾选、人工提交及待验收状态已验证；390px 小屏列表与操作无横向溢出，已复查通过 |
| `git diff --check` 与 `python3 /tmp/check-human-work-graph-resumed-links.py` | 通过 | 34 个 Markdown 文件、140 个相对文件链接，零无效链接 |
| `npm run gate` | 通过（最终代码） | 2026-09-07，macOS 原样执行：90 项单元/集成、16 项 HTTP E2E；失败、取消、跳过均为 0。日志 `/tmp/work-graph-resumed-gate.log` |

## 清理与验证边界

- 单元/HTTP/浏览器验证使用系统临时目录中的独立 SQLite、项目和 worktree。真实 Codex 冒烟使用仓库已有精确版本二进制及当前登录，项目内容全部为合成算术结果；未读取生产数据库、资料或凭据。
- 真实冒烟已停止独立 Portal 并移除临时业务目录；原生 Codex 本地历史可能保留合成测试对话，不作生产项目内容。未发布公网入口，未部署或重启生产服务。
- 新 HTTP E2E 在并行分支已下发后重启 Portal，验证持久状态继续完成，并在停止后检查 SQLite integrity、foreign keys 与零租用 job。
- 迁移用含真实关联行的合成旧 schema 重建两次，原生证据、SHA 和 review 外键保留；人工身份 CHECK 拒绝伪造。

## 结论

P0–P4 的第一版业务闭环已实现，最终完整门控通过。当前版本保留既有发布契约，具备进入受控发布流程的验证证据；本次未部署生产，自动审核质量不等同于独立测试执行能力。

## 遗留事项

- 开发目标无阻塞项。生产启用仍须按操作说明安排备份、维护窗口和分阶段开关；当前线上继续运行 `team_member`。浏览器与临时测试 Portal 已关闭，测试夹具自动清理独立业务目录。

## 2026-09-07 用户要求的分支保存与运行切换

- 用户要求将当前全部改动提交到远端 `graph`，再切回远端 `team_member` 版本重启程序；本次保存不是发布 Work Graph。
- fetch 后，本地 `team_member` 与 `origin/team_member` 的双向提交差均为 0；当前开发分支 HEAD 也以同一 `7e084ae` 为基线，差别来自未提交的工作图改动。
- 当前最终门控未通过。曾有中间版本全量通过，后续门控出现旧 approval 处理等待超时及旧 HTTP 套件 60 秒总时限取消；不得据中间结果宣称当前版本发布通过。最新 `npm run gate` 输出在系统临时目录，最后一次失败为既有 approval 等待超时。
- 新工作图单测（14 项）、含重启的 HTTP 闭环、真实 Codex 生成/打回/修正通过及浏览器操作已取得通过证据；完整最终发布验证仍待完成。
- 保存后恢复既有 `team_member` 运行；生产数据库兼容性、服务 ready 与公网入口在切换时独立核对，不向生产部署工作图。

## 2026-09-07 恢复 graph 实施

- 按用户最新要求继续完成原目标，在相邻独立 worktree 检出 `graph`（基线 `966ab34`）；原目录保留 `team_member` 供现有服务运行。开发目录通过 `npm ci` 安装依赖，不复制生产环境配置或数据库。
- 收尾计划：先复核既有审批测试与完整门控，再审查业务闭环及文档证据，修复实际缺陷，最后同步报告与索引并检查相对链接。
- 定位更正：旧审批 helper 是 100 次、每次 1ms 的轮询，并非固定 500ms；上一阶段的 500ms 描述不准确。本次原样运行 `node --test test/approval-security.test.mjs` 三项通过，无须修改测试或超时。
- 最终完整 `npm run gate` 已通过：单元/集成 90/90，HTTP 16/16，无失败、取消或跳过；旧固定 HTTP 套件约 23 秒，新增工作图业务用例约 14 秒。`test/e2e/portal-gate.test.mjs` 相对 `origin/team_member` 无修改。此次没有修改业务代码或测试阈值，不能据本次通过证明过去超时的唯一原因。
- 收尾仅更新实施报告及索引。Git 空白检查与相对链接检查通过；无新增迁移、API 或安全边界变化。回滚本次文档收尾可直接 revert 对应提交，业务版本回滚仍遵守上文备份与兼容要求。
