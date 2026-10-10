# 2026-09-27 老板隐私项目切换本机 Qwen

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（发布 gate 仍受既有环境失败限制） |
| 日期 | 2026-09-27 |
| 负责人 | Codex |
| 关联目标 | 将老板 `local_private` 项目的本地 API、运行时字段和账本引擎统一为已运行的本机 Qwen OpenAI-compatible API |
| 影响范围 | 本机模型配置、运行时 API、Token 账本、恢复 lineage、隐私项目运维文档、真实本地模型验证 |
| 架构规格 | [本地隐私项目](../architecture/10-local-private-projects.md)、[安全边界](../architecture/04-security-and-trust-boundaries.md)、[运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

当前本机 `127.0.0.1:8000` 有一个 uvicorn OpenAI-compatible 服务。已验证 `/v1/models` 返回模型 `Qwen3.8-Flash-Next-oQ5e-mtp`，`/health` 报告服务 healthy，`/v1/chat/completions` 的普通、流式和 tool call 请求均可完成。Portal 的本地隐私引擎已切换到该 Qwen 服务；普通项目和微信渠道仍使用本机 ChatGPT 官方 Codex 登录。

## 目标与非目标

### 目标

- 把老板 `local_private` 项目的本地模型地址和模型 ID 对齐到本机 Qwen 服务。
- 移除活动代码、配置、UI、运维脚本和架构中的本地 DeepSeek API 命名，统一使用 Qwen；保留 `@deepseek-ai/dsh-*` 作为实际 DSH 依赖包名。
- 保持仅老板可访问、项目不可分享、loopback-only、无云端 fallback、工具/文件/审批边界不变。
- 重启 Portal 后验证模型目录、健康状态和至少一轮真实本地问答。

### 非目标

- 不改变普通老板/员工/微信渠道的本机 ChatGPT 官方上游。
- 不开放 Qwen 端口公网访问，不修改项目 ACL、数据库 schema 或微信绑定。
- 不改变 DSH 底层包名、普通项目上游、项目 ACL 或项目类型。

## 约束与风险

- 本地 URL 必须是明确 HTTP loopback，禁止凭据、查询、重定向和远端地址。
- Qwen 服务必须继续提供 `/models` 和 OpenAI-compatible `/chat/completions`，包括 SSE 与 tool calls。
- Qwen 模型的实际上下文窗口和输出上限由服务返回/运维配置确认；错误模型 ID 必须使本地引擎报告 unavailable，不得回退云端。
- 真实验证使用无敏感内容；不写入日志、报告或提交模型返回中的秘密。

## 实施计划

1. 记录 Qwen API 的模型目录、健康状态、流式输出和 tool call 兼容性。
2. 更新本机私有配置、示例配置和隐私项目操作说明，使用实际 Qwen 模型 ID 并启用本地引擎。
3. 将本地 Qwen 运行时、health、Token 账本和恢复 lineage 的旧引擎标识统一为 Qwen。
4. 安全重启本地服务，核验 Portal health/status 与实际隐私项目问答。
5. 运行目标测试、语法检查、`git diff --check` 和 `npm run gate`，记录环境限制。

## 实际改动

### 配置与适配层

- `.env` 已启用本地隐私引擎，地址为 `http://127.0.0.1:8000/v1`，模型为 `Qwen3.8-Flash-Next-oQ5e-mtp`，上下文窗口按模型服务报告设置为 `262144`。
- `.env.example`、`.env`、`src/config.mjs` 和 `docs/LOCAL_PRIVATE_PROJECTS.md` 使用 `LOCAL_QWEN_*`；服务类、health 字段、runtime 字段和 usage engine 值统一使用 Qwen 命名。活动路径不再接受或读取 `LOCAL_DEEPSEEK_*` 配置。
- `src/local-dsh-worker.mjs` 将本地 OpenAI-compatible thinking 格式切换为 Qwen，并声明 reasoning capability，使 DSH 默认请求发送 `enable_thinking=false`；这避免 Qwen 默认推理模式在私有会话中无界消耗输出预算。工具调用、SSE、会话 JSONL 和 Portal 审批边界未改变。

### 用户界面、运维与架构

- 隐私项目、状态脚本、老板驾驶舱、Token 看板和工作台提示改为显示“本地 Qwen”。
- 架构第 00/01/04/06/07/08/10 章与本地隐私操作指南明确：普通项目/微信仍走本机 ChatGPT 官方登录，`local_private` 仅走回环 Qwen，无云端 fallback。
- Portal、公网隧道和微信 relay 已安全重启；微信绑定保持 `bound=true`，未修改二维码、ACL、项目数据或数据库 schema。

## 数据、接口与安全影响

- 数据迁移：启动时将历史 `token_usage_calls.engine` 和 `chat_thread_recoveries.engine` 的旧值迁移为 `qwen`，保留项目、会话、记忆和 JSONL；这是一次性持久化兼容迁移，不是继续支持旧 API 配置。
- API/协议：health、runtime 和 Token 看板字段从旧本地引擎标识统一为 Qwen；模型接口仍使用回环 `/v1/models` 与 `/v1/chat/completions`。
- 权限与秘密：无新凭据；Qwen 只通过 loopback 访问，Portal 子进程不继承主机秘密。
- 回滚：停止服务，恢复代码与配置版本后重启；数据库中的新 `qwen` 标签需在回滚版本中保持可读，不能直接恢复到不识别该值的旧版本。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `curl http://127.0.0.1:8000/v1/models` | 通过 | 返回 `Qwen3.8-Flash-Next-oQ5e-mtp` 和 `max_model_len=262144` |
| `curl http://127.0.0.1:8000/health` | 通过 | 服务报告 healthy，模型已加载 |
| OpenAI-compatible completion/SSE/tool call | 通过 | 普通、流式和函数调用均返回有效协议 |
| DSH worker 真实问答 | 通过 | 独立 worker 返回 `QWEN_PORTAL_LOCAL_OK` |
| 本次重命名后 DSH worker 真实问答 | 通过 | 使用当前 `src/local-dsh-worker.mjs`、实际 Qwen 模型和无敏感短提示，返回 `QWEN_RENAME_OK` |
| 隔离 Portal → local_private → Qwen 真实问答 | 通过 | 隔离临时 DB 中创建老板隐私项目，真实队列 turn completed，回复 `PORTAL_QWEN_OK` |
| `node --test test/config.test.mjs test/token-usage.test.mjs test/local-private.test.mjs test/e2e/local-private.test.mjs` | 通过 | 17 项通过；覆盖配置、账本、隐私 HTTP/DSH 隔离流程 |
| `node --test test/frontend.test.mjs test/e2e/local-private.test.mjs` | 通过 | 19 项通过；覆盖隐私 UI 文案和前端/HTTP 回归 |
| `git diff --check`、Node/shell 语法、Markdown 相对链接 | 通过 | 280 条相对链接无断链 |
| `npm run gate` | 未通过（既有环境限制） | 155 项中 146 通过、9 失败；PDF/DOCX 提取、云端搜索环境和 7 个缺失 `linkedom` 前端测试，不是本次 Qwen 改动引起 |
| `node --test test/config.test.mjs test/token-usage.test.mjs test/token-dashboard.test.mjs test/frontend.test.mjs test/local-private.test.mjs test/e2e/local-private.test.mjs` | 受环境限制 | 配置/账本/前端/隐私部分通过；`test/token-dashboard.test.mjs` 因环境缺少 `linkedom` 无法加载 |

## 结论

目标已达成：老板 `local_private` 当前实际使用本机 Qwen OpenAI-compatible API，Portal、DSH worker、工具调用和真实问答均已验证；活动代码和配置已移除本地 DeepSeek API 命名，普通项目、员工项目和微信渠道的 ChatGPT 官方上游未改变。完整发布 gate 仍不能声称通过，原因是既有环境依赖/外部搜索失败。

## 遗留事项

- Qwen 服务必须持续监听 `127.0.0.1:8000`；关闭或更换模型后，`localQwen` 会显示 unavailable，隐私项目不会回退到云端。
- 旧数据库中的引擎标签会在下次 Portal 启动时迁移；历史报告中的旧名称仅用于还原当时事实，不代表当前 API 入口。如存在外部客户端硬编码旧 health/runtime 字段，需要同步升级客户端。
- `npm run gate` 的 9 项既有环境失败仍需在依赖齐全、搜索可用的 macOS 发布环境复验。
