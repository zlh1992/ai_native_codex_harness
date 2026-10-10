# 2026-10-07 启用 Portal 本地 Qwen

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-10-07 |
| 负责人 | Codex |
| 关联目标 | 按用户授权启用现有 Portal 的本地隐私项目引擎 |
| 影响范围 | 本机运行配置、Portal 生命周期、运维验证、报告 |
| 架构规格 | [项目强制约束](../architecture/02-project-constraints.md)、[本地隐私项目](../architecture/10-local-private-projects.md)、[运维与协议](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

Portal、微信 relay 和 named tunnel 正常运行；oMLX 回环服务已加载配置中的 Qwen 模型，但 Portal 的本地引擎 disabled。前一轮已通过真实 DSH worker 工具往返、usage 与续聊检查。本次用户明确授权开启。重启前检查显示没有 queued/starting/running turn 或 pending approval，存在的 paused 输入不应自动恢复；磁盘上的 Codex CLI 与协议 pin 一致。

## 目标与非目标

### 目标

- 将本机 `LOCAL_QWEN_ENABLED` 开启并安全重启 Portal，确认 Codex 和本地引擎同时 ready。
- 验证真实本地推理、服务恢复、微信与公网健康，以及 macOS 发布门禁。

### 非目标

- 不切换普通项目和微信的 Codex 路由，不重置微信绑定或公网隧道。
- 不改变项目类型、审批、ACL、记忆边界或云端搜索策略，不自动续发 paused 输入。
- 不安装依赖或修改引擎实现，不将默认示例配置改为强制启用。

## 约束与风险

- 遵守 RUN-004、PRD-009、DAT-005、DEV-001、DEV-003 和秘密记录边界。
- Portal 重启有短暂不可用窗口；先确认无活动运行，并将 SQLite 一致性备份保存到私有运行目录。
- 模型目录 ready 不能替代真实推理；真实验证使用临时隔离数据库、项目与会话，不读取生产正文。

## 实施计划

1. 记录报告，确认运行空闲、固定 CLI 与模型配置，保存私有 SQLite 备份。
2. 仅修改本机 `.env` 的启用值，使用 `stop-local.sh` / `start-local.sh` 重启 Portal。
3. 验证双引擎、微信和公网，使用真实 Qwen 完成隔离引擎冒烟，运行 gate 与文档检查。
4. 清理临时验证数据，补充结果、回滚和报告索引。

## 实际改动

- 本机 `.env` 的 `LOCAL_QWEN_ENABLED` 从 false 改为 true；保留既有 oMLX endpoint、模型、262144 上下文、8192 最大输出配置。未修改 `.env.example` 的默认关闭策略。
- 通过 `bin/stop-local.sh` / `bin/start-local.sh` 重启已纳管 Portal；Codex 与 Qwen 同时 ready。微信 relay、named tunnel 复用原进程及绑定。
- 修改前以 SQLite backup API 保存一致性副本到 `.data/ops-backups/qwen-enable-20261007/harness-before-enable.sqlite`；备份目录 0700，文件 0600，quick_check 为 ok，保持 Git 忽略。配置切换没有改动项目文件，因此未复制工作树或生产本地会话。
- 新增本报告并更新索引。现有长期架构和接口契约保持不变，属于已定义可选功能的部署配置切换。
- 隔离真实引擎验证的末尾账本检查曾使用不存在的 `total_tokens` 列；此时文件审批、读写、续聊及 EXECUTE 断言已经通过。改用现有 `counts_json` 字段进行独立最小用量验证，确认有已报告、已完成且非零的 Qwen 账本记录；无需修改产品代码。

## 数据、接口与安全影响

- 数据迁移：无；重启沿用既有恢复规则。
- API/协议：无；继续由服务端按 project_type 路由。
- 权限与秘密：无变更；备份保存在私有目录，不提交数据库、配置秘密或生产正文。
- 回滚：确认本地运行空闲，将 `.env` 的 `LOCAL_QWEN_ENABLED=false`，再次安全重启 Portal；保留项目、记忆和本地会话。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| CLI pin、运行空闲检查 | 通过 | CLI 0.150.0-alpha.8，无活动 turn 或待审批 |
| `bash bin/stop-local.sh` / `bash bin/start-local.sh` | 通过 | 已纳管 Portal 重启成功 |
| `GET http://127.0.0.1:4310/api/health` | 通过 | codexState=ready、localQwen.enabled=true、localQwen.state=ready |
| `node --input-type=module`（隔离真实 AgentRuntimeService 冒烟） | 功能断言通过，首次末尾账本查询失败 | local_private 默认 manual；一次文件审批后真实写入/读取；续聊沿用 local session，经第二次命令审批执行项目内命令；未创建 Codex thread |
| `node --input-type=module`（隔离真实 Qwen 用量补查） | 通过 | 真实回复及 1 次 Qwen 用量记录；reported=1、finished=1、counts_json 含正 token 计数 |
| `GET http://127.0.0.1:18767/status` | 通过 | bound=true、phase=running |
| 两个已配置 HTTPS 角色域名的 `GET /api/health` | 通过 | 均 HTTP 200、Codex/Qwen ready；localQwen.enabled=true |
| `npm run gate > /tmp/codex-harness-qwen-enable-gate-20261007.log 2>&1` | 通过 | macOS 主机，语法/Shell 检查、200 项测试及 19 项 E2E 全通过；0 skipped |
| `git diff --check` | 通过 | 无空白错误 |
| `python3 -`（本报告与索引相对 Markdown 链接检查） | 通过 | 50 个相对链接可解析 |
| `node --input-type=module`（生产 SQLite 只读元数据检查） | 通过 | quick_check=ok、无外键违规、无活动 turn/pending approval/lease；原 1 条 paused 输入仍暂停 |

真实验证使用系统临时目录下的独立 SQLite、合成老板账号、项目文件和本地会话，只调用本机模型，不读取生产正文或调用云端搜索。两组临时数据目录均已删除，隔离 Worker 已退出；生产未增加测试项目、聊天、审批或用量记录。保留私有 SQLite 备份以供操作恢复，不将其提交。门禁日志位于系统临时目录，未保存真实 prompt、凭据或生产文件内容。

## 结论

目标完成，现有 Portal 已启用本地 Qwen；普通 Codex、微信和公网健康均正常。macOS 发布门禁通过，真实本地文件审批、读写、命令、会话恢复及用量验证通过。无需产品代码、架构或协议迁移。

## 遗留事项

- 真实云端搜索及浏览器中用户自有隐私项目的完整记忆验收不属于此次开关启用范围；本次不宣称已验证真实搜索。相关隔离、记忆与审批契约由 gate 覆盖。
