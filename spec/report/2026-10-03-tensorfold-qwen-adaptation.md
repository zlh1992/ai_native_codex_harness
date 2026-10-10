# 2026-10-03 TensorFold 本地 Qwen 适配

| 字段 | 内容 |
| --- | --- |
| 状态 | 实施中 |
| 日期 | 2026-10-03 |
| 负责人 | Codex |
| 关联目标 | 将已启动的 TensorFold OpenAI-compatible Qwen 服务接入 Portal 本地隐私项目 |
| 影响范围 | 运维配置、运维文档、验证 |
| 架构规格 | [本地隐私项目与本地引擎](../architecture/10-local-private-projects.md)、[项目强制约束](../architecture/02-project-constraints.md) |

## 背景与证据

用户提供的本地服务运行在 `127.0.0.1:8000`，健康接口报告模型为 `Qwen3.8-Flash-Next-MLX-4bit-MTP-tensorfold`。`/v1/models` 返回同一模型 ID；普通 OpenAI Chat Completions、SSE 流式原生 `tool_calls` 均已通过真实请求验证。TensorFold 启动参数固定总窗口 49,152、最大输出 16,384、关闭 thinking，活动 KV cache 与 MTP 正常。

## 目标与非目标

### 目标

- 将 `LOCAL_QWEN_*` 配置与 TensorFold 实际模型 ID 和容量对齐。
- 保持现有 DSH/OpenAI-compatible 适配层，不引入第三方 provider 或放宽回环网络边界。
- 记录真实接口验证和回滚方法。

### 非目标

- 不修改普通项目或微信渠道的官方 Codex 上游。
- 不改变 local_private ACL、审批、记忆或工具权限。
- 本次不自动开启当前 Portal 的 Qwen 运行实例；只准备下次启用所需配置。

## 约束与风险

- 遵守 `RUN-004`、`PRD-009`、`DEV-001`、`DEV-003`；本地引擎只服务 `local_private`。
- TensorFold 的 49,152 是输入加输出总窗口，不能按旧配置宣称 64K 输入；过大的 Portal 上下文会被本地服务拒绝。
- 新量化模型与旧模型的质量、首 token 延迟和上下文容量不同，仍需在启用后完成实际私有项目问答验收。

## 实施计划

1. 核对线程记录、本地服务健康接口、模型目录和 tool call 流。
2. 更新 `.env` 与运维文档中的模型 ID、窗口和输出上限。
3. 运行配置/文档校验，保留当前 Portal Qwen 关闭状态，并记录回滚步骤。

## 实际改动

- 将 `.env` 的 `LOCAL_QWEN_MODEL`、`LOCAL_QWEN_CONTEXT_WINDOW` 和 `LOCAL_QWEN_MAX_TOKENS` 对齐 TensorFold。
- 更新 `docs/LOCAL_PRIVATE_PROJECTS.md` 的模型与容量说明。
- 未修改 `src/local-dsh-worker.mjs`；现有 DSH Qwen thinking/工具调用兼容层适用于该服务。

## 数据、接口与安全影响

- 数据迁移：无。
- API/协议：无新增 API；继续使用回环 OpenAI-compatible `/v1/models` 与 `/v1/chat/completions`。
- 权限与秘密：无变化；Worker 仍只允许配置的回环模型端点，不记录 prompt 或工具正文。
- 回滚：恢复 `.env` 中原模型 ID、窗口和输出上限；Portal 无需数据库迁移。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `GET http://127.0.0.1:8000/health` | 通过 | TensorFold 返回 `status=ok`、模型 ID 和活动服务指标 |
| `GET http://127.0.0.1:8000/v1/models` | 通过 | 返回 TensorFold 模型 ID |
| OpenAI Chat Completions 普通请求 | 通过 | HTTP 200，返回 `OK` 和 usage |
| OpenAI Chat Completions SSE + `tool_choice` | 通过 | 分片返回原生 `tool_calls`，最终 `finish_reason=tool_calls` |
| `src/local-dsh-worker.mjs` 真实初始化与问答 | 通过 | DSH worker 返回 `ready`、`TENSORFOLD_OK`，并提取上游 usage |
| `git diff --check` | 待执行 | |
| `npm run gate` | 待执行 | |

## 结论

协议层可以适配，当前只需配置切换，不需要代码改造。配置更新并完成门控后，可在保持现有权限边界的前提下启用 TensorFold；当前运行中的 Portal 仍保持本地 Qwen 关闭。

## 遗留事项

- 启用后需用真实 `local_private` 项目完成一次流式问答、工具调用、记忆和恢复验收。
- 需要在 macOS 上运行 `npm run gate`；本报告暂未宣称发布门禁通过。
