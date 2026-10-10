# 2026-09-27 恢复官方模型认证

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（发布 gate 仍受既有环境失败限制） |
| 日期 | 2026-09-27 |
| 负责人 | Codex |
| 关联目标 | 修复微信消息模型认证，并确认普通项目/微信/隐私项目的上游边界 |
| 影响范围 | 本机私有运行配置、配置校验、生命周期脚本、运维说明 |
| 架构规格 | [上下文](../architecture/01-system-context-and-components.md)、[约束](../architecture/02-project-constraints.md)、[安全边界](../architecture/04-security-and-trust-boundaries.md)、[运维](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

微信消息到达 Portal 后，上游模型多次重试并返回 401 INVALID_API_KEY。当前请求地址与本机 ChatGPT 登录凭据不匹配。用户明确选择恢复项目默认官方地址。

## 目标与非目标

恢复官方模型请求并真实验证；禁止启动配置引用第三方 Codex 地址。保留微信绑定、项目、历史、模型与权限；不修改凭据，不重放原失败消息，不调整重试策略。隐私项目仍由显式启用的本机回环 DeepSeek 独立提供，不能 fallback 到云端。

## 约束与风险

遵守 RUN-006、DAT-006；只修改私有配置的地址项，不输出凭据。重启前检查活动运行，真实模型验证不读写业务文件。

## 实施计划

1. 复核源代码、`.env`、微信 relay 运行配置及六个启动入口的上游关系。
2. 将本机 CHATGPT_CODEX_BASE_URL 恢复为代码默认官方地址，并在配置/启动时拒绝第三方地址或 provider。
3. 修正整套启动健康门槛，普通项目/微信必须要求 Codex ready；隐私项目仍只在显式开启本地 DeepSeek 后使用回环服务。
4. 无活动运行时用统一入口重启，核验微信绑定和引擎状态。
5. 通过签名渠道请求执行一次简短无工具的真实模型验证，不向微信另发消息。
6. 记录验证和发布门控结果，更新运维说明、架构和报告索引。

## 实际改动

恢复 `.env` 中的 `CHATGPT_CODEX_BASE_URL` 为 `https://chatgpt.com/backend-api/codex`；未修改认证文件或微信绑定。配置层固定 `openai_http` 和官方地址，生命周期脚本在启动/状态/健康检查前拒绝其他 provider/endpoint；未显式设置时 Codex 子进程固定读取当前 macOS 用户的 `~/.codex` 登录目录。整套启动只把 Codex ready 视为普通项目/微信的成功前置条件。微信 relay 增加本机 Portal URL 校验，运行目录已用项目安装脚本同步。统一入口重启了 Portal、公网隧道和 relay。

## 数据、接口与安全影响

无业务 schema/API/权限改变；增加配置 fail-closed 校验。未复制或修改认证文件；回滚需恢复代码/私有地址并重启，但恢复非官方地址会被启动校验拒绝。

## 验证

| 统一重启与健康 | 通过 | Portal 与双公网 health `codex=true/codexState=ready`；微信 `bound=true/phase=running` |
| 真实签名渠道模型请求 | 通过 | 发送不涉及文件的验证 prompt，官方模型 10 秒返回预期 `OK`；channel event completed |
| 配置/脚本拒绝第三方上游 | 通过 | 配置单测 2 项；临时替换 `.env` 后 `status.command` exit 2；当前源码/运行配置检索无第三方地址 |
| 本地隐私引擎边界 | 通过 | `test/local-private.test.mjs` 等 10 项通过；`LOCAL_DEEPSEEK_ENABLED=false` 时 health 显示 disabled |
| `npm run gate` | 未通过 | 155 项，146 通过、9 失败；既有 linkedom 缺失、PDF/DOCX 提取与本地搜索环境失败；未修改或跳过契约 |
| `git diff --check`、相对链接、shell/Node 语法 | 通过 | 无空白、断链或语法错误 |

## 结论与遗留事项

目标已达成：普通项目、员工项目、微信固定项目均锁定本机 ChatGPT 官方 Codex；老板隐私项目仍独立使用显式开启的本机回环 DeepSeek；微信绑定保留，真实渠道请求成功。完整 gate 仍不能声称通过；用户可重新发送“你好”做手机端最终收发确认。

## 后续状态（2026-09-28）

随后完成了老板隐私项目本地引擎的统一替换：当前运行配置、服务类、健康字段、账本引擎和 DSH 适配均使用本机 Qwen OpenAI-compatible API；普通项目、员工项目、微信渠道仍保持本报告确认的本机 ChatGPT 官方 Codex。原结论中的本地模型名称是本报告生成时的历史状态，当前状态以 [本机 Qwen 报告](2026-09-27-local-qwen-private-engine.md) 和架构第 10 章为准。
