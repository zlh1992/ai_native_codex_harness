# 2026-10-04 微信渠道命令路由修复

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成 |
| 日期 | 2026-10-04 |
| 负责人 | Codex |
| 关联目标 | 修复微信 OpenClaw/Portal 渠道 `/new` 未创建新 Portal 对话、`/models` 未显示 Portal 模型目录的问题 |
| 影响范围 | Portal API、SQLite 渠道绑定、微信协议、架构、测试、运维 |
| 架构规格 | [03 领域模型与不变量](../architecture/03-domain-model-and-invariants.md)、[07 发布契约](../architecture/07-e2e-release-contracts.md)、[08 运维与协议演进](../architecture/08-operations-protocol-and-evolution.md) |

## 背景与证据

重启后的本机 Portal、微信 relay 和固定项目绑定均已恢复。SQLite 事件记录显示微信收到 `/new` 后仍在原 chat 中执行普通 Codex turn，回复为“已开启新对话”；收到 `/models` 后由上游模型自行生成列表，遗漏 Portal 已配置的 `gpt-6-astra` 等目录项。relay 只负责传输，不解析命令；Portal 渠道入口也没有命令分支，因此这是已验证的路由缺口。

## 目标与非目标

### 目标

- 在 Portal 渠道层识别 `/new`，保留旧 chat 历史并为当前微信 scope 创建、绑定新的老板 chat。
- 让 `/models` 返回 Portal 的静态模型目录，包含 `gpt-6-astra`。
- 支持 `/model <id>` 修改当前微信 chat 的模型偏好，并复用既有模型白名单。
- 保持 relay 纯传输、固定老板项目 ACL、事件幂等和本地 Qwen 不启动。

### 非目标

- 不迁移或删除旧 Codex thread，不把旧历史伪装成新对话上下文。
- 不修改微信登录、项目绑定、老板项目只读工具或本地 Qwen 推理实现。
- 不保证上游账号实际授予每个 Portal 模型；上游不可用时仍由现有 Codex 错误处理返回失败。

## 约束与风险

- 遵守 `02-project-constraints`、`DAT-004`、`DAT-006` 和 E2E-018；命令仍必须在 Portal 固定 scope 和老板 ACL 内处理。
- `/new` 不能在运行中的旧 chat 上并发切换；重绑定必须校验当前 chat，避免覆盖竞争更新。
- 新 chat 创建与 active binding 更新需要同一 SQLite 事务；失败时不能留下孤儿绑定。
- 旧 chat 保留会增加历史数量，但满足可审计和回滚要求。

## 实施计划

1. 增加渠道命令解析/目录格式化及 binding 重绑定数据库方法。
2. 在微信事件入口处理 `/new`、`/models` 和 `/model`，持久化命令事件并复用现有回复 relay。
3. 更新架构契约、测试和报告索引；重启 Portal（保持本地 Qwen disabled）并运行回归及 release gate。

## 实际改动

- `src/wechat-channel-commands.mjs` 增加 `/new`、`/models`、`/model` 解析、Portal 模型目录格式化和模型白名单复用。
- `src/db.mjs` 增加 active channel binding 的预期 chat 校验重绑定方法；`src/server.mjs` 在微信事件入口中加入空闲检查、SQLite 事务、新 chat 创建、命令回复和 command 审计。
- `test/channel.test.mjs` 覆盖 binding 重绑定、命令解析、七模型目录和默认模型恢复；架构 03/07/08 补充命令和发布契约。
- 重启本机 Portal 后保持 `localQwen.enabled=false`，并将本机 `.env` 的 `LOCAL_QWEN_ENABLED` 固定为 `false`，避免后续常规重启误启动；微信 relay 和 named tunnel 沿用现有进程与密钥，不改 transport 配置。

## 数据、接口与安全影响

- 数据迁移：新增 binding 指向更新，不增加表；旧 chat、事件和 thread lineage 保留。重绑定在 `BEGIN IMMEDIATE` 事务中完成，失败回滚新 chat。
- API/协议：微信 Portal 事件接口新增命令语义；既有 HMAC、loopback、sender、scope 和 event id 校验保持不变；relay 无需升级。
- 权限与秘密：模型命令只修改当前 active 老板 chat 的偏好；不记录 prompt、secret 或完整敏感回复。
- 回滚：停止 Portal 并恢复上一版本代码即可；新增 chat 可保留，必要时将 binding 恢复到旧 chat。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/channel.test.mjs` | 通过 | 4 项通过，包含命令解析、模型目录和 binding 重绑定 |
| `npm test` | 通过 | 200 项通过 |
| `npm run gate` | 通过 | check 与 E2E 全部通过；E2E 19 项通过 |
| `git diff --check` | 通过 | 无空白错误 |
| 相对 Markdown 链接检查 | 通过 | 本次变更报告和架构文档链接均可解析 |
| 本机真实 HMAC `/models` | 通过 | 返回 completed，包含 `gpt-6-astra` 与 `gpt-5.3-codex-spark` |
| 隔离 scope 两次 `/new` | 通过 | 产生两个不同 chat，active binding 指向第二个；临时 scope/event/chat 已清理 |
| `bash bin/status.sh` 与双公网 `/api/health` | 通过 | Portal PID 25481、Codex ready、named tunnel PID 997；本地 Qwen disabled |

## 结论

目标已达成。微信 `/new`、`/models` 和 `/model` 现在由 Portal 统一处理，旧历史保留，模型目录包含 `gpt-6-astra`；本机 Portal、微信 relay、named tunnel 均已恢复并通过健康检查。发布 gate 已通过。

## 遗留事项

- 若 `gpt-6-astra` 不在当前登录账号的上游可用范围，`/models` 会显示其 Portal 白名单资格，但实际 turn 仍可能由上游拒绝；需要以真实账号 turn 结果单独确认。
