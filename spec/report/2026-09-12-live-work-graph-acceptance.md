# 2026-09-12 真实模型多人工作图闭环验收

| 字段 | 内容 |
| --- | --- |
| 状态 | 已完成 |
| 日期 | 2026-09-12 |
| 负责人 | Codex |
| 关联目标 | 老板生成工作图，员工交付，AI 自动审核推进到其他员工，直至最终完成；发现问题按用户动线修复 |
| 影响范围 | graph 代码、真实 Codex、员工浏览器 UI、隔离验收项目/员工；生产健康与静态资源复验 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[生命周期](../architecture/05-execution-concurrency-and-lifecycle.md)、[发布契约](../architecture/07-e2e-release-contracts.md)、[多人图](../architecture/09-human-work-graph.md) |

## 背景与证据

上一轮完成了双角色导航、文件、真实单轮模型等基线验收；多人图完整闭环仅有 fake app-server 的隔离 HTTP 门控，不能据此声称真实模型端到端完成。本轮以当前 graph 工作树和服务为准重新验证。

## 目标与非目标

### 目标

- 经实际 Portal 入口生成计划并明确授权普通节点与最终节点自动审核。
- 两名隔离测试员工串行接力，提交固定文件证据，验证 AI 审核、owner Git delivery、下游 handoff/文件同步，最终整图通过。
- 检查任务发现、进入对话、完成清单、提交、等待审核、收到下一任务和老板查看结果的用户动线；修复真实复现问题。
- 区分真实模型/公网/浏览器证据与隔离自动门控，保留可复核状态和 SHA 元数据。

### 非目标

- 不改变现有业务图、员工密码或既有权限；不人工伪造审核通过、不手改任务状态。
- 不以模型声明代替独立运行测试；验收内容使用小型合成文本，不涉及法律或业务判断。
- 不改 DNS、隧道、原生记忆策略或发布分支；本轮不 commit/push。

## 约束与风险

- 遵循 PRD-001/003、FS-004、DAT-006/007、WFG-001/002/003 与 DEV-003/004。
- 在独立回环实例中创建明确 E2E 标识的测试项目和员工；使用同一份 graph 代码和真实上游模型。生产账号与项目不作修改，会话与凭据不输出。
- 带工作图历史的项目按既有证据保留规则不能普通删除；完成后退出验收会话、停止独立实例，保留离线验收数据，不绕过删除保护。
- 上游模型调用会消耗现有账号额度；使用小范围、明确输出与有限节点，禁止不确定调用盲目重放。
- 任何部署重启前核对真实活跃 turn/job/lease，避免中断业务。

## 实施计划

1. 核对 graph 工作树、规范、实时服务与认证入口。
2. 创建隔离验收资源，老板通过真实 planner 生成三段接力图并启动 auto/auto 策略。
3. 以员工各自身份完成与提交；逐步核对审核、Git、handoff、页面状态，发现问题先记证据再修复。
4. 修复补回归测试和相关架构说明，运行完整 macOS gate，安全部署后复验。
5. 审计最终图/任务/提交/审核/文件一致性，退出测试会话并停止独立实例，记录证据与剩余边界。

## 实际改动

- 公网 health ready，但启动配置内旧管理员密码返回 LOGIN_FAILED。未重置生产账号，已异步请用户登录。
- 改用同一 graph 代码、真实 pinned Codex 的独立回环实例（独立 SQLite/工作树/临时员工；不改公网实例）继续完整链路，记忆索引在夹具中禁用，原生记忆仍关闭。本轮不以该实例冒充公网登录证据。
- 真实 planner 已生成并启动三段串行图：员工甲简报 → 员工乙文案 → 员工甲整合最终稿；普通/最终策略均 auto。
- 员工甲在实际浏览器进入任务对话，真实 Codex 读取 task context、写入并复读 brief.md，经界面勾清单并选择原生最终回复成功提交。审核模型已给出逐项文件证据。
- 已修复 UI 问题：自动共享后待办出现但可见项目仍为 0；成功提交后旧对话保留“提交任务 Done”和可发送输入；auto 模式仍写“等待老板验收”。新增 `public/task-flow.js` 集中计算当前任务状态，`app.js` 同步任务/项目并丢弃迟到轮询，限制失效操作，提供审核/后续任务入口与模式中性提示；不清空输入草稿。
- 第二次 AI 审核已应用且最终节点 active 时，员工保持打开的审核详情仍停在“处理中 / 建议”，虽背后的工作台提示已通过。补充员工只读详情轮询：更新审核结果、保留滚动，不替换交付表单/上传/不确定提交，不让迟到响应重新打开已关闭的详情。
- 最终员工已真实读取两份上游成果、生成并复读 `final.md`。在浏览器勾选三项清单、选择原生最终回复并提交后，旧提交按钮已消失、发送控件已禁用；只读详情在保持打开时自动更新审核意见与最终已通过状态，工作台显示整图完成，返回看板显示甲的两个任务已通过、零进行中/待审。
- 最终审核真实返回 `needs_human`：上下文只有当前 submission 输出正文，上游 handoff 只有清单/摘要，无法对照 `copy.md` 原文。只读详情正确自动更新，证据缺口不能靠人工通过掩盖。追加修复计划：按任务激活时冻结的 input manifest 校验同图、已通过 submission/handoff；从各自固定 Git 快照提取上游正文，沿用总预算和异步 ACL 复验；使用带 submission ID 的证据引用避免同名冲突；root read proof、审核 proposal 和 auto apply 同时校验这些引用与覆盖。同步审核 skill 与回归，保留旧建议，通过既有暂停/恢复授权启动新一轮审核，不改旧提交或直接写状态。
- 上述证据修复已落实到 `project-context-service`、`work-graph-service`、`work-graph-runtime`、`task-review-service` 和项目审核 skill。按 skill-creator 作窄范围引用规则修订，未放宽通过标准、允许私有 transcript 或增加自主执行权限。追加两个回归测试覆盖固定上游正文、引用与 auto apply 双来源覆盖。
- HTTP 回归指出初稿“所有上游附件一律完整才可应用”的规则会新增验收要求：已人工通过的上游图片会阻塞并不依赖图片的下游文本任务。因此最终契约为本次输出必须完整，被引用上游也必须完整；审核 skill 仍须把清单需要但不可读的上游判为 needs_human。保留全部原 HTTP 断言，只更新 fake reviewer 对新增 `evidenceRef` 的读取方式，避免把上游文件误当成本次同名路径。
- 最终审核重试经原有 owner pause/resume API 明确改变 generation（1 → 3），保留同一 submission；新的真实审核逐项引用 final/brief/copy，自动应用 passed、完成 owner delivery 和整图 reconcile。未调用人工 review 接口，未写数据库任务/审核状态。

### 真实闭环审计

- 工作图：`129b6d48-bdcf-401b-b01f-6e7dd866b0e3`；运行：`6f932075-7a2b-4d03-ab63-79be942788f9`。最终 `passed`、revision 5、generation 3、`nextCheckAt=null`。
- 真实模型使用 pinned CLI `0.150.0-alpha.8` 与 `gpt-5.6-sol`。8 个 completed 原生 turn：1 个 planner、3 个员工执行、4 个 reviewer（含修复前证据不足的一次），均保留原生标识；没有 fake 替代本段调用。
- 三份 submission 均 `kind=codex`、绑定真实完成回复，三份 applied review 均 `source=ai`；人工 review 数量为 0。最初最终审核的 needs_human 已 superseded，历史不删除。

| 节点 / 员工 | 快照 commit | owner delivery commit | 结果 |
| --- | --- | --- | --- |
| write_brief / 甲 | `8aec257f95660b0c0ab882ec20f30d2bad795e3e` | `13b40e5d9c19ea5cac8f7ea5841d2935f8779b2d` | passed |
| edit_copy / 乙 | `e2f88aad656fd5d2474a8a07ec719360f0f907c7` | `71d3296e8d234e8a0de9ba148cbbbb89d3b0fce4` | passed |
| assemble_final / 甲 | `ea828d02aacb29f4a8c4b409e7bb55e1b57de4e0` | `b51ed061460759d23f85675294892654a2a35799` | passed |

只读 SQLite + Node assert + Git 审计（执行会话 32818，exit 0）验证：三份 handoff，输入数量依次 0/1/2；所有 delivery 均为 owner HEAD 祖先，owner 工作区 clean；三份文件逐字等于各自提交快照；final.md 仅含指定两个标题、三项功能，产品文案等于 copy.md 全文。老板受认证文件 API 返回 final.md HTTP 200，616 bytes，版本哈希 `9d599c0dc039a91964be2095296997e3d0af94cc5d23a62e01bc08a7b1012b50`。数据库 quick_check=ok、foreign_key_check=0。

项目事件顺序独立核对为 dispatched → passed → dispatched → passed → dispatched → passed → workflow.passed。前两次交接分别在通过后约 0.38 秒、0.81 秒下发下一棒；最终交付后整图自动结束，无 pending workflow job。最后一次真实审核的全部上游 coverage 都完整，也符合后续回归校准的“被引用上游必读”规则。

## 数据、接口与安全影响

- 数据迁移：当前无。
- API/协议：`publicTask` 增量提供服务端推导的 `reviewMode`；聊天读取接口统一使用该公共任务表示，包含 `workflowStatus` 并过滤内部 `assignedAccessId`。审核 `work_graph_context` 增量提供带 `evidenceRef` 的冻结上游正文与覆盖元数据；原生工具名称/schema、HTTP 路径、审核授权不变。
- 权限与秘密：测试资源隔离，绝不重置真实员工密码或记录凭据。
- 回滚：仅撤销本报告所述 task-flow、任务状态同步、只读详情刷新、公共任务表示及上游审核证据的改动；保留此前导航/看板和用户既有修改。无数据库迁移，停服窗口内回退代码后按现有启动脚本恢复。历史新增的 qualified evidenceRef 为普通 JSON 元数据，回退不得删除审核历史；回退旧上下文实现会重新出现上游证据缺失限制。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| 独立实例真实模型三段接力图 | passed，所有交付闭环 | 老板通过受认证 HTTP 生成并启动；员工经真实浏览器执行与提交；不冒充公网登录验收 |
| 任务用户动线 | 五类实测问题已修复并复验 | 项目计数、失效提交/输入、验收模式提示、只读审核详情、审核缺少上游正文 |
| `node --test test/task-flow.test.mjs` | 8/8 通过 | 含乱序轮询、暂停/版本变化、详情关闭/编辑竞态 |
| `node --test test/work-graph.test.mjs test/work-graph-review-runtime.test.mjs` | 20/20 通过 | 含上游不可变 Git 字节、引用、覆盖/预算/异步变化拒绝；会话 68600、49106 |
| `node --test test/e2e/work-graph.test.mjs` | 通过，exit 0 | 最终夹具区分当前/上游文件，并引用 qualified 上游证据；所有原断言保留，会话 69720 |
| `python3 /Users/zlh1992_home/.codex/skills/.system/skill-creator/scripts/quick_validate.py portal-skills/work-graph-review` | Skill is valid | 窄范围审核引用规则修订 |
| `npm run gate`（首次 UI 修复） | 137 单元 + 18 HTTP E2E 通过，0 失败/跳过 | macOS，会话 84641，exit 0 |
| `npm run gate`（上游证据修复后首次） | 138/139 单元通过；旧审批用例短超时，未进入 E2E | 会话 82509，exit 1；100 次 1ms 轮询等待 command 子进程，保留原断言与时限，模型空闲后完整重跑 |
| `npm run gate`（第二次） | 139 单元通过；HTTP 门控未通过 | 会话 95326，exit 1；固定 Portal 父测试达到 60 秒上限，工作图夹具未识别 qualified 引用；修复夹具并校准上游必读范围后继续完整重跑，不删减断言 |
| `npm run gate`（最终） | 139 单元 + 18 HTTP E2E 全通过，0 失败/跳过 | macOS，会话 78348，exit 0；固定 Portal 32.9 秒、工作图 30.5 秒；未修改原测试时限或删减断言 |
| `git diff --check` 与相对链接 | 通过 | Node 检查 spec 内 176 个相对 Markdown 链接，broken=[] |
| `./bin/stop-local.sh && ./bin/start-local.sh` | 通过 | 在生产 active/queue/leased job/approval/lease 全零后执行；会话 5541，exit 0 |
| 本地及双域名 HTTP 验证 | 全部通过 | Node fetch + assert；入口/新 task-flow 资源 200、health ready、原生记忆 false；会话 62903，exit 0 |

## 清理与部署

- 两名临时员工已在浏览器退出，两个临时标签页已关闭；boss/甲/乙三个验收 HTTP 会话 logout 均为 200。临时辅助进程停止，忽略目录下的 `graph-acceptance-client.mjs` 已删除，不进入提交。
- 独立实例在 active turn、leased job、execution lease、pending approval 全为 0 后正常 SIGTERM 停止。保留 `/var/folders/q6/yk3g6y_16cl82bklmw3hmdyh0000gn/T/harness-live-graph-WfpNzr` 中离线 SQLite/Git 审计证据，不修改其中完成历史；该临时目录不是持久备份。
- 未修改任何生产账号密码、项目文件、图状态或 DNS/隧道。最终 gate 成功后，在全零空闲屏障内重启 graph 服务，生产 PID 61416；资源版本 `6b1aa0607fbf1365b8d6`。
- 本地 `http://127.0.0.1:4310`、老板 `https://workbench1.winy.cc/boss/login`、员工 `https://workbench2.winy.cc/employee` 的入口和新资源均 200，health ready，原生 Codex memory=false。重启后生产 quick_check=ok、foreign_key_check=0、active turn/queued input/leased job/approval/lease 均 0。没有 commit/push。

## 结论

已完成用户要求的真实老板规划 → 员工甲交付 → AI 自动审核与交接 → 员工乙交付 → AI 自动审核与交接 → 员工甲最终交付 → AI 自动审核、owner Git 合入与整图 passed。五类实测问题已修复、完整发布门控通过并更新 graph 服务。测试中遇到的首次证据不足、重试授权和门控失败均保留上述记录，不把一开始失败描述为一次即通。

## 遗留事项

- 证据边界：真实闭环在独立回环实例完成，老板规划/启动通过受认证 HTTP，员工执行/提交通过实际浏览器。生产旧老板凭据曾失败且未重置，因此本轮不声称完成生产老板网页登录后的整条业务复验；公网只确认入口、健康和新资源。
- 旧审批短轮询与固定 Portal 60 秒总时限曾在忙碌宿主出现超时，最终同码完整重跑通过。保留该可靠性观察，未以延长时限或跳过测试换取通过。
- 本次小型合成文本闭环不证明所有复杂文件、模型质量或公网长期可用性；原有不支持/不可读/独立验证要求仍按策略转人工。
