# 2026-09-06 老板工作台模型选择

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 将老板登录后工作台模型标签改为模型选择 |
| 影响范围 | UI、API、数据库、运行参数、测试、架构 |
| 架构规格 | [领域模型](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[运行](../architecture/05-execution-concurrency-and-lifecycle.md) |

## 背景与证据

截图对应 public/index.html 工作台顶部 model-badge；当前 UI 和 root turn 固定显示/使用服务默认模型。工作树已有其他需求的未提交修改，本次增量保留。

## 目标与非目标

### 目标

- 老板可为自己的对话选择本地 Codex 同名模型，至少包括 GPT-6 Astra、GPT-5.6 Sol、GPT-5.6 Terra。
- 按 chat 持久化，实际 root thread/turn 使用选择；默认继续使用 CODEX_MODEL。

### 非目标

- 不修改员工模型权限、上游身份、CLI pin 或固定 Luna 子代理策略；不自动部署。
- 不承诺每个上游模型的账号可用性，不动态同步桌面模型目录。

## 约束与风险

- PRD-001/002/003、CAP-003、PRO-001、DAT-006 保持；服务端白名单和 admin 校验。
- 模型变更仅空闲且无待发输入时接受，避免排队参数漂移；旧 chat nullable 字段兼容默认值。
- 上游模型可用性由共享账号决定；失败沿用现有错误处理，不静默降级。

## 实施计划

1. 增加模型目录、chat 偏好迁移与受控更新 API。
2. 将老板标签改为下拉选择，接入 thread/turn 参数并保留员工默认策略。
3. 补充持久化、权限与模型传递验证，运行 gate 与 Markdown 链接检查并补全报告。

## 实际改动

- `src/models.mjs` 提供受控 root 模型目录和权限感知解析；Astra、Sol、Terra、Luna、GPT-5.5、Mini、Spark 使用本地 Codex 同名 id。
- `src/db.mjs` 为旧库幂等添加 nullable preferred_model，chat payload 和更新映射支持偏好；员工 share 副本保持 null。
- `src/server.mjs` 在 /api/me 返回老板模型目录，chat PATCH 验证 admin、白名单、原有 ACL 与空闲/队列屏障。
- `src/codex-service.mjs` 在 run 创建前解析模型，thread/start、resume、turn/start 使用冻结后的模型；员工继续使用服务默认。
- `public/index.html`、`app.js`、`styles.css` 将老板顶部标签改为带可访问名称的原生下拉框，切换对话恢复选择、保存失败恢复原值、保存中阻止发送；移动端保留选择入口。
- 补充迁移/重开/独立偏好、原生参数传递、员工默认策略、前端切换状态、HTTP 白名单/角色/运行中拒绝测试。同步领域、安全、运行架构及报告索引。
- 无功能范围偏差。完整 gate 首轮遇到导入置于 shebang 前的语法错误，已修复；运行测试 mock 缺少 client.start 桩，已补齐。随后一次 gate 的现有队列 replay 敏感标记断言失败；检查当前实现后完整重跑通过，未删除或弱化该断言。

## 数据、接口与安全影响

- 数据迁移：chats.preferred_model 可空字段，幂等 ADD COLUMN。
- API/协议：/api/me 模型目录；PATCH chat 增加 preferredModel；沿用原生 model 参数。
- 权限与秘密：只允许 admin 修改自己的 chat，保留 ACL/CSRF/Origin，无凭据读取。
- 回滚：回退本次代码即可忽略 nullable 字段；保留数据库和其他未提交改动。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `git diff --check` | 通过 | 无空白错误 |
| `npm run gate` | 通过 | macOS、Node v25.6.0；71 个单元/集成测试与 15 个 HTTP E2E 测试全部通过，0 skipped；包括真实 Seatbelt 与 loopback |
| `node --test test/frontend.test.mjs` | 通过 | 10 个前端测试，包括模型切换/保存/无 chat 状态 |
| `python3 /tmp/codex-model-links.py` | 通过 | 逐个解析 README、spec、docs 的相对 Markdown 链接并验证目标存在 |

## 清理与回滚

验证使用临时数据库、worktree 与 fake Codex，不读取生产凭据，不创建生产任务；新增模型单元测试在 finally 关闭数据库并删除临时目录，HTTP gate 沿用原有清理机制。临时门控输出仅存 /tmp，不入库。回滚仅撤销本报告列出的模型功能增量；可保留 nullable 数据列，不回退其他未提交需求，不删除生产数据。

## 结论

需求已实施，发布门控通过。老板选择一个对话后可在顶部切换模型，刷新保持选择，实际 root 运行使用所选模型，员工与子代理策略保持原边界。代码具备进入发布流程的条件，但本次未部署或重启正式服务。

## 遗留事项

- 未进行真实上游各模型调用或浏览器视觉冒烟；上游账号可用性不由 fake E2E 保证。模型目录为受控静态目录，未来桌面新增模型需显式更新。
