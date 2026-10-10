# 2026-10-04 oMLX 本地 Qwen 接口兼容性

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中 |
| 日期 | 2026-10-04 |
| 负责人 | Codex |
| 关联目标 | 核验 oMLX Qwen 服务与 Portal 所有本地 LLM 接口的兼容性 |
| 影响范围 | 运维配置、运维文档、真实接口验证 |
| 架构规格 | [本地隐私项目与本地引擎](../architecture/10-local-private-projects.md)、[项目强制约束](../architecture/02-project-constraints.md) |

## 背景与证据

本机 oMLX 服务运行在 `127.0.0.1:8000`，`/health` 正常，`/v1/models` 返回 `Qwen3.8-Flash-Next-oQ5e-mtp`，并报告 `max_model_len=262144`。Portal 之前的本地配置仍指向已停止的 TensorFold 模型 ID；若直接启用，会在模型探测阶段进入 unavailable。

## 目标与非目标

### 目标

- 将 `LOCAL_QWEN_*` 配置恢复到 oMLX 实际模型和窗口。
- 核验项目所有本地 LLM 路径：模型探测、普通 SSE、thinking、原生工具调用、tool result 多轮、续聊和 usage。

### 非目标

- 不改变普通项目、微信渠道或 Codex 官方上游。
- 不改变 local_private ACL、审批、文件沙箱、记忆边界或本地 egress 限制。
- 不在本次检查中强制开启当前 Portal 的 Qwen 运行实例。

## 约束与风险

- 遵守 `RUN-004`、`PRD-009`、`DEV-001`、`DEV-003`；本地模型只允许回环 HTTP，且只服务 `local_private`。
- oMLX 的接口返回 reasoning 内容和完整 usage；DSH 兼容层需关闭默认 thinking，并保留可选 thinking 解析。
- 模型探测要求配置模型 ID 与 `/v1/models` 精确一致；TensorFold ID 已实测返回 404，不能保留在配置中。

## 实施计划

1. 核对 oMLX 进程、健康接口、模型目录及 OpenAI-compatible 参数。
2. 用真实 DSH worker 验证工具往返、usage 和 resume。
3. 更新配置与运维文档，运行回归校验并记录回滚方式。

## 实际改动

- `.env` 与 `.env.example` 改为 `Qwen3.8-Flash-Next-oQ5e-mtp`、上下文 `262144`、最大输出 `8192`。
- `docs/LOCAL_PRIVATE_PROJECTS.md` 改为 oMLX 当前模型与容量说明。
- 未修改 `src/local-qwen-service.mjs` 或 `src/local-dsh-worker.mjs`；现有接口覆盖已验证。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：无新增；继续使用 `/v1/models` 和 `/v1/chat/completions` SSE。
- 权限与秘密：无变化；真实验证使用临时 session 目录和本地占位 API key，未写入项目数据库或日志。
- 回滚：恢复 `.env` 中的上一组模型配置；Portal 不需要数据库迁移。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| oMLX `/health` 与 `/v1/models` | 通过 | 服务健康，模型 ID 精确匹配，报告上下文 262,144 |
| 普通 SSE + usage | 通过 | 返回可见文本、reasoning 内容和 usage |
| TensorFold 旧模型 ID | 按预期失败 | oMLX 返回 HTTP 404，证明旧配置不能继续使用 |
| DSH worker 工具往返 | 通过 | `probe_echo` 收到参数并返回 `OMLX_COMPAT` |
| DSH worker 续聊 | 通过 | 新 worker resume 后可读取上一轮工具结果 |
| usage 计量 | 通过 | 每次 HTTP 请求返回 prompt/completion/total usage，Portal meter 成功提取 |
| `git diff --check` | 待执行 | |
| `npm test` | 待执行 | |
| `npm run gate` | 待执行 | |

## 结论

oMLX 与项目当前所有本地 Qwen 接口兼容，不需要代码适配；必须先切换配置模型 ID，随后才能启用 Portal。本次未开启 Portal Qwen，普通 Codex 服务不受影响。

## 遗留事项

- 启用 Portal 后仍需用真实 `local_private` 项目做一次文件审批、记忆和恢复验收。
- 需要在 macOS 上运行 `npm run gate`，本报告暂不宣称发布门禁通过。
