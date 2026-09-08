# 2026-09-09 Codex 自主记忆工具

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（已部署 graph 本地服务） |
| 日期 | 2026-09-09 |
| 负责人 | Codex |
| 关联目标 | 复用 memsearch 0.4.19 / Milvus Lite，由 Codex 自主调用记忆 CRUD |
| 影响范围 | 服务、工具、前端文案、测试、规格 |
| 架构规格 | [约束](../architecture/02-project-constraints.md)、[领域](../architecture/03-domain-model-and-invariants.md)、[安全](../architecture/04-security-and-trust-boundaries.md)、[恢复](../architecture/06-persistence-events-and-recovery.md) |

## 背景与证据

旧实现每轮前自动搜索并注入，成功后按关键词保存用户输入；模型不能中途搜索或主动修改删除。用户要求由工具调用决定 CRUD。

## 目标与非目标

- 增加 memory_search/add/update/delete，保留索引和人工管理界面。
- 移除自动注入与关键词提取；旧任务表和已存记忆保留，未完成提取不重放。
- 不启用 Codex 原生记忆，不改变 planner/reviewer 限制，不实现工具摘要。

## 约束与风险

身份和来源绑定 active root；不接受模型指定用户。搜索 await 后复验权限；新增/更新拒绝秘密，更新删除使用版本。工具返回的记忆须记录引用供历史分享检查。修改旧记忆使已引用线程失效；调用者不得自等待中断而死锁。原 DAT-009/E2E-016 的关键词提取契约改为工具写入，测试以真实 HTTP fake tool 回调替代旧断言。

## 实施计划

1. 工具 schema、注册和 root 分派，权限/来源/版本/引用检查。
2. 清除自动前置召回与后置提取，保留兼容存储。
3. 更新 UI/文档/架构并测试 CRUD、跨用户、禁用、竞态和分享。
4. gate、diff、链接验证；空闲时重启本地服务使工具注册生效。

## 实际改动

- 新增 `src/memory-tools.mjs` 四个 schema 和执行器；Codex normal/task root 注册、按 active 身份分派，搜索结果记引用，写入返回元数据。
- 移除自动前置 recall/context 与成功后关键词 extraction、旧配置；保留 SQLite 记忆/历史任务，不重放遗留提取。
- 更新事务追加来源，旧版本拒绝；原始正文不在旧引用中被新版本替代；跨项目判断覆盖所有来源。
- 变更后标记旧线程、暂停队列并排空其他运行；调用者只确认结果，后续动态工具与原生写批准拒绝。额外修复 retry 绕过显式 reset 的路径。
- 复用原 memsearch/Milvus/ONNX，固定 HF_HUB_CACHE 指向安装预热目录，避免重复下载。UI 改为“搜索记忆/管理记忆”，状态文案仅承诺索引进程启动。
- HTTP E2E 改为真实动态工具回调，新增无关键词保存、CRUD、写入成功后任务失败仍持久化、失效后工具拒绝及 retry/reset 验证；单元测试覆盖权限/版本/异步/事务/历史任务。

## 数据、接口与安全影响

- 数据：无 schema 删除与旧记忆清空；历史提取表保留，queued/running 仅标 failed。现有 HTTP CRUD 保留，新增四个动态工具，不升级 Codex 协议。
- 安全：工具写入立即持久化，不依赖最终任务是否成功；owner/source 不可由模型指定，版本乐观锁、来源 ACL 与旧线程失效继续强制。秘密规则不是完整 DLP，模型判断偏好也不承诺零误判。
- 部署：确认 active run 与未终态 workflow job 均为 0 后，用 Node SQLite backup API 在线备份至共享数据目录的 `backups/before-memory-tools-2026-09-08T16-50-20.225Z.sqlite`（0600），随后只重启 graph 本地服务，不重启隧道。
- 回滚：排空运行后回退本次工具代码及文案、重启服务，保留数据库和原生记忆关闭；不能自动重新消费历史提取任务。只有明确需要回滚数据且核对备份后的新增操作后，才恢复备份；不能覆盖上线后用户数据。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test test/user-memory.test.mjs` | 通过 | 6 项，含事务回滚与旧提取不重放 |
| `node --test test/e2e/portal-gate.test.mjs` | 通过 | 16 项，四工具回调、无关键词保存、失效后的工具与 retry 拒绝、显式 reset |
| `npm run gate` | 通过 | 最终 macOS 99 项单元/集成 + 17 项 HTTP E2E，无失败/跳过；含 loopback 与 Seatbelt |
| `node --input-type=module` 隔离真实 Codex smoke | 通过 | 固定 CLI 0.150.0-alpha.8，Sol/low；自然语言触发 search/add、search/update、search/delete，均成功，最终 active 记忆数 0 |
| `node --input-type=module` 实际 MemoryIndexClient smoke | 通过 | 复用已安装 ONNX 模型缓存，真实 Milvus 搜索返回 1 个结果；安装元数据为 memsearch 0.4.19 / milvus-lite 3.2.1 |
| `git diff --check` | 通过 | 无 whitespace 错误 |
| `node --input-type=module` 相对 Markdown 链接检查 | 通过 | rg 枚举 spec/docs/README，解析并检查 163 个相对目标，无缺失 |
| `./bin/stop-local.sh && ./bin/start-local.sh`、`./bin/status.sh` | 通过 | graph 服务 ready；原隧道 PID 保持，地址未变 |
| `curl -fsS --max-time 5 http://127.0.0.1:4310/api/health` | 通过 | codexState=ready、nativeCodexMemory=false |

真实 smoke 使用临时用户、SQLite、workspace 与索引，没有操作生产账号内容；这些临时目录均已删除。第一轮 smoke 的清理顺序曾在关闭 DB 后收到 client exit 回调而报错，随后修正测试关闭顺序、清理残留临时目录并重跑三次 CRUD 成功。原生测试 thread 按 Codex 历史机制保留，仅含合成测试偏好；未在报告或日志中保存生产正文、凭据。

## 结论

目标达成并已部署 graph 本地服务：模型自主选择四工具，原关键词/前置注入路径移除，原生 Codex 记忆保持关闭。所有门控通过，已有工作树改动保留，未代用户提交 Git。

## 遗留事项

- 无本次阻塞项。模型不调用工具就不会自动持久化；用户可明确要求调用并检查返回结果。“索引进程已启动”不承诺所有向量即时就绪，失败仍安全降级关键词搜索。模型更新/删除已读记忆后需要显式 reset，是保留的安全取舍。
- 工具进度的 Luna 摘要不在本次范围；原生聊天/备份中已出现的记忆正文不会被追溯物理擦除。
