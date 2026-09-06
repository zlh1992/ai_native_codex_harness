# 2026-09-06 运行中对话空白用户气泡修复

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-09-06 |
| 负责人 | Codex |
| 关联目标 | 修复 EXECUTE 运行期间刷新或切回对话后出现空白 `YOU` 输入气泡的问题 |
| 影响范围 | UI、前端恢复逻辑、文档、测试 |
| 架构规格 | [系统上下文与组件](../architecture/01-system-context-and-components.md)、[持久化、事件与恢复](../architecture/06-persistence-events-and-recovery.md)、[端到端发布契约](../architecture/07-e2e-release-contracts.md) |

## 背景与证据

用户截图显示：真实输入下方出现第二个带 `YOU` 标签和用户气泡样式、但正文为空的消息。代码检查确认该节点不是 CSS 留白，而是运行中对话恢复路径显式追加的空用户消息。

`resumePersistedTurn()` 有意不从事件 journal 恢复敏感 prompt，因此恢复 entry 的 `prompt` 为 `''`。`selectChat()` 随后把“历史消息中不存在与 `running.prompt` 相同的用户消息”作为补绘条件。由于已持久化的真实用户消息内容不等于空字符串，该条件成立，并调用 `appendMessage('user', '')` 生成空白气泡。问题在刷新页面或切回仍处于 queued/starting/running 状态的对话时可稳定触发；与命令执行本身无关，但默认/常用 EXECUTE 流程更容易暴露它。

## 目标与非目标

### 目标

- 恢复运行中对话时，不为缺失于 journal 的 prompt 合成空白用户消息。
- 保留当前实时发送路径中的即时用户输入和 Codex 占位气泡。
- 增加回归测试，锁定“只有持有非空 prompt 时才允许补绘”的前端约束。

### 非目标

- 不把 prompt 写入 turn event journal。
- 不改变消息数据库、API payload、Codex 协议或 EXECUTE 调度。
- 不改变空 assistant 占位气泡；该气泡会用省略号表达运行状态。

## 约束与风险

- 继续满足 `DAT-006`：事件与审计不得记录 prompt；不能为修 UI 而把输入加入 journal。
- 继续满足确定性消息 fallback：服务端 `user:<turnRunId>` 是恢复时用户输入的事实来源。
- 风险仅在前端补绘判断。若未来存在尚未持久化但客户端仍持有 prompt 的恢复对象，非空 prompt 仍应按原逻辑补绘一次。
- 遵守 `DEV-001` 至 `DEV-004`；不删除或弱化现有发布契约。

## 实施计划

1. 提取运行中 prompt 是否需要补绘的纯判断，只允许非空 prompt 进入补绘路径。
2. 在前端测试中覆盖空 prompt、已有同内容消息和确实缺少非空 prompt 三种情况。
3. 在持久化/恢复架构说明中记录“不用缺失 prompt 合成空用户消息”的长期约束。
4. 运行针对性测试、完整 `npm run gate`、Markdown 相对链接校验和 `git diff --check`。

## 实际改动

- `public/app.js` 新增 `shouldAppendLivePrompt(messages, entry)`。补绘条件现在同时要求客户端持有非空 prompt，并且历史中不存在同内容用户消息。
- `selectChat()` 使用该判断恢复运行中对话。`resumePersistedTurn()` 继续把未进入 journal 的 prompt 保持为空，但不会再因此创建空 `YOU` 气泡。
- `test/frontend.test.mjs` 直接执行上述纯判断，覆盖空字符串、纯空白、已有消息和确实缺失非空消息四种情况。
- `spec/architecture/06-persistence-events-and-recovery.md` 固化恢复 UI 以确定性 `messages` 为用户输入事实源、不得从缺失 prompt 合成空消息的约束。

实现未偏离计划；未修改消息持久化、API 或 EXECUTE 行为。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：无。
- 权限与秘密：无；prompt 继续不进入事件 journal。
- 回滚：恢复 `selectChat()` 原补绘条件并删除对应测试和规格条目即可；无数据回滚。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --check public/app.js && node --test test/frontend.test.mjs` | 通过 | 7/7 前端测试通过，含新增空用户消息回归用例。 |
| 隔离浏览器场景：启动保持中的 EXECUTE，刷新并切回对话 | 通过 | DOM 中恢复后仅 1 个非空用户气泡，空白用户气泡为 0，Codex `…` 占位仍存在。 |
| `npm run gate` | 通过 | macOS loopback + Seatbelt 环境中 60/60 单元/集成测试、10/10 E2E 测试通过。 |
| Markdown 相对链接校验 | 通过 | 检查 26 个 Markdown 文件，全部相对链接可解析。 |
| `git diff --check` | 通过 | 无 whitespace error。 |

验证使用独立临时数据库、测试项目、合成账号和 fake Codex，不读取或修改生产数据。验证后已关闭浏览器标签和隔离 Portal 进程，临时目录移动到当前用户废纸篓以便恢复或清理；未保存任何真实凭据。

## 结论

目标已达成。刷新或切回 queued/starting/running 对话时，缺失于事件 journal 的 prompt 不再产生空白用户气泡；正常即时输入和 assistant 运行占位保持不变。针对本修复的测试与完整发布门控均通过，可以随当前工作树其他变更一起进入后续发布流程。

## 遗留事项

- 无。
