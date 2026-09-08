# 2026-09-07 用户记忆隔离与 Portal 记忆层

| 字段 | 内容 |
| --- | --- |
| 状态 | 完成（未部署） |
| 日期 | 2026-09-07–08 |
| 负责人 | Codex |
| 关联目标 | 在 `graph` 分支关闭 Codex app-server 原生长期记忆，并提供按 Portal 用户隔离、受当前项目授权约束的跨项目记忆 |
| 影响范围 | 代码、数据库、API、UI、Codex 启动配置、分享流程、运维、文档、测试 |
| 架构规格 | [00](../architecture/00-overview-and-decisions.md)、[01](../architecture/01-system-context-and-components.md)、[02](../architecture/02-project-constraints.md)、[03](../architecture/03-domain-model-and-invariants.md)、[04](../architecture/04-security-and-trust-boundaries.md)、[05](../architecture/05-execution-concurrency-and-lifecycle.md)、[06](../architecture/06-persistence-events-and-recovery.md)、[07](../architecture/07-e2e-release-contracts.md)、[08](../architecture/08-operations-protocol-and-evolution.md)、[09](../architecture/09-human-work-graph.md) |

## 背景与证据

Portal 当前为所有老板、员工和项目共用一个 Codex app-server、`CODEX_HOME` 与上游身份。启动参数关闭了多种越过 Portal ACL 的原生能力，但没有关闭 Codex 的 `memories` feature，也没有强制 `memories.generate_memories=false` 与 `memories.use_memories=false`。因此宿主配置一旦启用原生记忆，Portal 无法证明老板、员工和不同项目之间不会通过共享 app-server 发生潜在串忆。

当前应用没有 by-user 长期记忆实体、来源权限复验、删除失效、引用审计或分享确认。官方配置文档确认 `memories.generate_memories` 控制新线程是否参与记忆生成，`memories.use_memories` 控制是否向模型注入记忆；Portal 必须把两项及 feature 本身固定关闭，并在 ready 前验证实际配置。

## 目标与非目标

### 目标

- Portal 启动的所有 Codex root、resume、fork、工作图后台对话和原生子代理均强制关闭 Codex 长期记忆，客户端、项目配置和浏览器不能重新开启；启动时有效配置不满足要求即 fail closed。
- 以 SQLite 为授权事实源提供按 `user_id` 隔离的 Portal 记忆，支持创建、查看、编辑、停用/删除与来源追踪。
- 普通对话可按 chat 开关自动召回和保存；planner/reviewer 不召回、不生成记忆。
- 同一用户可跨其当前仍有效授权的全部项目召回；每个候选在注入前按全部来源项目重新复验 ACL。索引只负责召回候选，不能授予权限。
- 默认接入 pinned memsearch 0.4.19 的本地 ONNX 索引进程；索引不可用或超时则安全降级为 SQLite 关键词召回，Portal 与删除失效仍可工作。
- 保存每轮实际引用；使用跨项目私有记忆的 chat 在 `files_and_history` 分享前，必须以接收者与当前 chat 快照显式确认，chat 内容变化后确认失效。

### 非目标

- 不扫描或回填上线前全部历史对话，不删除宿主用户全局 Codex 记忆库，也不更改 Codex Desktop 自身配置。
- 不把记忆共享给另一个 Portal 用户；管理员角色不形成员工私有记忆的读取旁路。
- 不把向量索引当作权限或持久化事实源，不承诺敌对宿主机管理员隔离。
- 不让项目文档、memsearch 插件、hooks 或 Markdown 文件直接写入权威记忆。

## 约束与风险

- 遵守 `PRD-001`、`PRD-002`、`PRD-003`、`RUN-004`、`DAT-004`、`DAT-006`、`DEV-001` 至 `DEV-006`、`WFG-001`。
- 共享原生 app-server 的旧 thread 可能已含历史注入内容；关闭原生记忆只阻止后续生成/使用，不会擦除已有 transcript。当前实现不主动扫描或删除这些线程。
- 来源项目撤权或记忆删除后，SQLite 必须立即停止召回；向量索引删除可异步，但候选必须再次经 SQLite 和 ACL 校验，避免陈旧索引复活内容。
- memsearch/ONNX 首次安装或模型获取可能失败或耗时；运维状态需明确 degraded，SQLite fallback 不能绕过 ACL。
- 记忆文本属于受 ACL 业务内容，不得进入 `audit_log`、`turn_events`、服务日志或公开分享确认摘要。
- 分享确认必须绑定接收者、owner chat 集合及各 chat 的消息/记忆引用快照；任一相关状态变化后旧确认不得复用。

## 实施计划

1. 在 Codex 子进程启动参数和每个 thread start/resume/fork 的 config 中固定关闭原生记忆；initialize 后调用 `config/read` 验证，补 fake app-server 与协议测试。
2. 增加幂等 SQLite 迁移与 `UserMemoryService`：用户记忆、来源依赖、版本、chat 开关、turn 引用、提取任务与分享确认。
3. 增加受管 Python 索引桥与 pinned memsearch/ONNX 安装清单；实现 per-user 索引、2 秒超时、重建/删除及 SQLite 关键词 fallback。
4. 在普通 turn 启动前召回并注入受限 reference context，在成功终态后异步提取；工作图 planner/reviewer 全面禁用。
5. 增加 `/api/memories` CRUD、chat 记忆开关、每轮引用接口与工作台“我的记忆/本轮引用”界面。
6. 扩展 `files_and_history` 分享：存在跨项目记忆引用时先返回确认挑战，确认绑定接收者和 chat 快照；`files_only` 不受影响。
7. 更新长期架构、运维说明和发布契约，补单元/HTTP E2E，并执行语法、测试、Markdown 相对链接、`git diff --check` 与完整 `npm run gate`。

## 实际改动

- `src/codex-client.mjs` 在 app-server CLI 层关闭 `memories` feature 和两个 memory 开关，并在 initialize 后调用 `config/read`；任一有效值未明确为 `false` 时以 `CODEX_NATIVE_MEMORY_ENABLED` 拒绝 ready。`src/codex-service.mjs` 把同一冻结配置覆盖到 start/resume/fork；原生子代理受进程级 feature 关闭和 parent thread 配置约束。
- SQLite 幂等增加 `user_memories`、`user_memory_sources`、`turn_memory_refs`、`memory_extraction_jobs`、`memory_share_confirmations`，以及 chat 的 `use_memory`、`save_memory`、`memory_context_reset_at`。删除使用清空正文的 tombstone；reset 保留旧引用证据但把旧 epoch 排除在后续失效和分享快照之外。
- 新增 `UserMemoryService`：按 session user CRUD、当前来源 access 复验、最多 8 条/12000 字符召回、实际注入版本记录、索引陈旧时的二次 SQLite 过滤、记忆变化/撤权后的 active turn 排空和旧 native thread 失效。
- 新增受管 stdio Python worker。每用户使用独立 Markdown 文档目录和 Milvus Lite DB；`memsearch[onnx]` 固定为 0.4.19，embedding 模型固定到 `gpahal/bge-m3-onnx-int8` commit `2b34e84df040034d4b9eabb62383a87c18955822`。worker 只获得最小环境，不获得 Portal/Codex 凭据；超时/不可用时使用 SQLite 关键词降级。
- 成功的普通/task turn 结束后写持久 extraction job。与原计划的“通用提取”相比，V1 有意采用确定性、保守规则：仅含“请记住/以后/始终/偏好”等明确长期意图时保存，疑似密码、token、私钥和常见凭据模式直接丢弃；planner/reviewer 和失败 turn 不处理，不回填旧历史。
- turn/start 前把记忆作为标明“非指令、非权限、非权威”的私有参考块注入；本地 message fallback 和分享 fork 会剥离该隐藏块，避免把 Portal 内部上下文显示或复制成用户原文。
- 新增 `/api/memories` CRUD、`/api/chats/:id/memory` 设置/引用和 per-run 引用接口；工作台增加“我的记忆”、每 chat 两个开关和“本轮引用”。编辑支持多行，删除和上下文重置沿用站内确认框。
- `files_and_history` 分享若命中跨项目记忆引用，先返回不含正文的短期挑战；最终发布前再次验证接收者、chat 集合/更新时间、引用、当前记忆版本和来源 ACL，再单次消费 token。失效引用在明确 reset 前拒绝历史分享；`files_only` 和 Work Graph 自动分享不复制历史、不触发此确认。
- 安装脚本增加 Python 3.10+ venv、固定 memsearch 依赖和默认模型预热；`.env.example`、README、运维文档、长期架构与 E2E 契约同步更新。

## 数据、接口与安全影响

- 数据迁移：新增表全部使用 `CREATE TABLE/INDEX IF NOT EXISTS`，chat 字段使用兼容的 `ADD COLUMN`；旧 chat 默认开启 Portal 召回/形成，但不扫描旧 transcript。来源 `project_id` 有意保留为非 FK 证据，项目删除后仍可 fail closed，而不是因级联删除把来源记忆错误变成全局记忆。
- API/协议：新增 `GET/POST /api/memories`、`PATCH/DELETE /api/memories/:id`、`GET/PATCH /api/chats/:id/memory`、`GET /api/chats/:id/turn-runs/:runId/memory-references`；分享 POST 可带 `memoryConfirmationToken`。Codex CLI/schema pin 保持 0.150.0-alpha.8，只使用该 schema 已存在的 `config/read` 和 thread config。
- 权限与秘密：所有正文接口从 session user 出发；无 admin bypass。语义索引不是授权点，候选在注入/显示/分享前复验 SQLite owner、active/version 和全部来源 access。audit 仅写 id、version、类型、受影响 chat 数；health 仅写状态/error code，不写正文、query 或内部路径。
- 并发与失效：记忆 update/delete、来源撤权和项目删除先排空已引用 chat，再变更事实并标记旧 thread；召回在异步索引返回后再次读取版本/ACL。分享在 native fork 等 await 之后、SQLite 发布之前再次消费快照 token，变化时回滚未绑定 worktree。
- 回滚：先停止服务并备份 SQLite/WAL/SHM。旧代码会忽略新增表/字段，但不得回滚 native-memory-off；业务记忆需降级时设置 `PORTAL_MEMORY_ENABLED=false`，保留三项 Codex 关闭与 ready 验证。`.data/memory-index` 和模型缓存可删除重建，不是权威数据。
- 清理：单元/E2E 使用临时数据库和目录并自动删除；依赖 API 核验创建的 `/tmp` venv 已删除。未读取、修改或迁移生产数据库、生产项目、现有 Codex memory 库。

## 验证

| 命令或场景 | 结果 | 证据摘要 |
| --- | --- | --- |
| `node --test --test-concurrency=1 test/user-memory.test.mjs` | 通过 | 3/3：按用户与来源 ACL、撤权/reset、接收者/快照/单次分享 token、保守提取与秘密拒绝 |
| `node --test --test-concurrency=1 test/e2e/portal-gate.test.mjs` | 通过 | 固定 Portal gate 及 15 个子场景通过；新增真实 HTTP CRUD、跨项目召回、引用、chat 开关、跨用户拒绝和分享确认 |
| `npm run gate` | 通过 | macOS/loopback/Seatbelt 主机：95/95 单元/集成、17/17 E2E；无 skip/fail |
| `CODEX_BIN=../codex-harness-remote/.tools/codex-0.150.0-alpha.8/vendor/x86_64-apple-darwin/bin/codex node --input-type=module -e "import { loadConfig } from './src/config.mjs'; import { CodexAppServerClient } from './src/codex-client.mjs'; const client=new CodexAppServerClient(loadConfig()); await client.start(); console.log(client.started); client.stop();"` | 通过 | 锁定真实二进制 initialize + `config/read` 后 `started=true`；当前 App 内置 0.153.4 则按既有精确 pin 正确拒绝，未伪装兼容 |
| `uv run --with 'memsearch[onnx]==0.4.19' python -c "import inspect; from memsearch import MemSearch; assert inspect.iscoroutinefunction(MemSearch.index); assert inspect.iscoroutinefunction(MemSearch.search)"` | 通过 | 实装 memsearch 0.4.19；构造参数及 async `index`/`search(top_k=...)`、同步 `close` 与 worker 调用一致；未下载模型，显式临时 venv 已删除 |
| inline Node Markdown link checker | 通过 | README、docs、spec 共 36 份 Markdown、153 个相对文件链接，0 无效 |
| `git diff --check` | 通过 | 无空白错误 |

## 结论

目标已在 `graph` 分支达成：Portal 原生 Codex 记忆已成为不可覆盖、ready 前验证的关闭不变量；Portal 自有记忆以用户和当前来源授权为边界，并具有引用、失效、reset 与分享确认闭环。固定发布门禁通过，代码具备合并/部署条件；本报告未执行部署。

## 遗留事项

- 首次部署需运行 `./bin/install-mac.sh` 下载固定 ONNX 模型（约 558 MB），然后确认 `/api/me` 的 memory index 为 online；未下载时会安全降级到关键词召回。
- 当前系统 App 内置 Codex 已是 0.153.4，而项目协议仍精确锁定 0.150.0-alpha.8。部署必须继续把 `CODEX_BIN` 指向已保留的 0.150.0-alpha.8，或另开协议升级变更重新生成 schema；不得只改版本字符串。
- 直接依赖与模型 revision 已固定，但 Python 传递依赖尚未使用 hash lock；后续供应链加固可增加平台化 hash lock，不影响本轮 ACL 正确性。
