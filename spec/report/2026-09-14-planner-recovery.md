# 2026-09-14 规划网络失败恢复与可诊断状态

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（09-14 已部署） |
| 日期 | 2026-09-14 |
| 负责人 | Codex |
| 关联目标 | 降低规划失败后的无效人工处理，提供真实进度和核对入口 |
| 影响范围 | 后台运行、owner API、前端、测试、规格 |
| 架构规格 | [工作图](../architecture/09-human-work-graph.md)、[恢复](../architecture/06-persistence-events-and-recovery.md)、[发布](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

生产只读检查确认规划模型响应流网络解码失败；原生运行已 failed，仅上下文读取，没有结构化计划回执。调度再次领取后因保留 turn 绑定而统一报结果不确定。attempt 包含调度次数，不等于模型调用次数。旧页面重复提示且没有后台对话入口。

## 目标与非目标

### 目标

- 对明确终态、无计划回执的规划网络失败做有界退避恢复。
- 保留已持久回执，禁止重试丢回执导致重复建图。
- 展示模型配置、调用状态、回执及可访问的私有后台记录；仅真不确定重调才要求确认。

### 非目标

- 不改模型、推理强度、协议或普通输入队列重试契约；不保证上游网络可用。
- 不自动重跑生产失败任务、不重启生产、不部署或提交其他脏树改动。

## 约束与风险

- 遵守 WFG-003、DAT-006、DEV-003；未知/中断/租约丢失不盲目重放。
- 自动恢复限受管 planner，其唯一写入为原子保存计划和回执；reviewer 不扩大自动恢复。
- 重试可能增加模型费用，沿用 max_attempts；owner API 不泄露原始错误正文或跨用户 transcript。

## 实施计划

1. 共享恢复分类，租约下 CAS 清除确定失败的绑定，复用终态计划回执。
2. 手动重试复验终态与权限，保留回执；增加安全诊断投影及私有后台记录入口。
3. 增加隔离回归测试、更新长期契约，运行完整 macOS gate 与文档检查。

## 实际改动

- `workflow-recovery.mjs` 统一 retry/resume/confirm/blocked 分类，明确终态网络失败才允许自动再次调用。运行身份、owner/project、native turn id 必须匹配，未知/活跃失败闭合。
- `work-graph-runtime.mjs` 在租约与账号策略校验后 CAS 清理确定失败绑定；失败保留旧历史，规划回执即使随后模型 failed 也可复用。身份缺失的既有回执不重新调模型。没有结构化结果的 completed 直接转人工。
- `work-graph-routes.mjs` 手动 retry 保留所有回执，阻止活跃/缺失身份的重复调用；owner 投影新增恢复类别、配置模型/强度、带 native turn id 的调用计数、时间和回执标记。原始错误文本不出现在该接口。
- `public/work-graph.js` 顶部状态摘要与下方恢复操作分工；安全重试无无效确认框，复用结果标成恢复后续步骤。核对按钮通过现有 chat ACL 打开只读记录；转义正文，拒绝切换后迟到响应。轮询保留确认框，按钮防重复提交；配套恢复卡片换行样式。
- 新增分类/UI测试和真实临时 SQLite 的调度、次数上限、历史/回执、失租约及 retry 路由权限测试。未更改模型或现有普通队列的重放规则。

## 数据、接口与安全影响

- 数据迁移：不新增表；保留旧 turn/chat 历史。
- API/协议：扩展 owner job 状态投影；协议不变。
- 权限与秘密：沿用 owner/access 与 chat ACL，不记录生产正文。
- 回滚：撤回本报告对应代码并重启；无不可逆迁移，已生成的业务结果继续保留。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/workflow-recovery.test.mjs test/work-graph.test.mjs` | 初次 21/22；已修正夹具 | 新 API 夹具遗漏必填 chat title，非生产代码问题 |
| `node --test --test-name-pattern='job retry route' test/work-graph.test.mjs` | 通过 | 修正夹具后定向验证 |
| `npm run gate` | 两轮均通过，第二轮为最终代码 | 每轮 162 单元/集成 + 19 HTTP E2E；零跳过，退出码 0 |
| `node --input-type=module`（stdin，linkedom + WorkGraphUI.action） | 通过 | 后台记录正文转义、选择世代变化后丢弃迟到响应 |
| `node --input-type=module`（stdin，相对 Markdown 链接存在性检查） | 通过 | 5 份变更文档，39 条相对链接 |
| `git diff --check` | 通过 | 结束前复核无空白错误 |

所有写测试使用临时数据库/项目，自动清理；DOM 检查只用合成文本。没有修改生产数据、重启服务、重试用户项目、改 DNS 或保存凭据；未做真实浏览器视觉或上游推理验收。现存无关工作树改动全部保留。

## 结论

目标在 graph 工作树内完成，最终代码通过 macOS 全量发布门控。明确网络失败不再被统一锁成不确定，已有回执不丢弃，真正不确定仍保留人工保护。代码具备发布测试基线，但尚未重启生产或触发原失败项目；本次不声称已降低真实上游故障率或已在线恢复该任务。

## 遗留事项

- 真实上游与生产失败任务重试需另行验收。

## 09-14 发布追加

用户明确要求重启上线。计划：检查活跃运行/审批、SQLite 在线备份，使用 graph 的正式脚本重启，仅更新 Portal，保持现有隧道与域名；复验 health、双公网入口及版本资源一致性。不自动重试历史失败任务。上一阶段最终代码已通过 162+19 完整门控，本阶段不更改运行代码。

结果：发布完成。重启前 active turn、leased job、待发输入、pending approval 均为 0；在线备份保存至生产数据 backups 下 `pre-planner-recovery-KYFNA5/harness.sqlite`（目录 0700、文件 0600）。`./bin/stop-local.sh`、`./bin/start-local.sh` 成功，新进程确认运行 graph/src/server.mjs。

本地及两个固定公网 `/api/health` 均 HTTP 200、Codex ready、索引 ready、nativeCodexMemory=false；本地隐私引擎仍为 disabled，未改变配置。老板 `/boss/login` 和员工 `/employee` 均 200，版本 `f5bd9d169c0b2640164c` 一致；各自版本化 work-graph.js/styles.css 与 graph 磁盘字节完全相同。重启后 SQLite integrity=ok、foreign key 违规=0。

原失败规划保持 needs_attention、attempt=2，未自动重新调用；新分类为 retry，可在新页面显式重新尝试。不改 DNS/隧道，不建立测试账号，不执行真实模型新任务；备份保留用于回退。此次上线覆盖本报告修复，前述“未部署”结论是上线前阶段记录。
