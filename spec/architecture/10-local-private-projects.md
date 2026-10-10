# 10 老板隐私项目与本地引擎

## 不变量与最小接入面

`projects.project_type` 为不可变的 `standard | local_private`，迁移默认 standard。隐私项目仅活动老板本人创建/访问；数据库 trigger 与业务服务共同拒绝员工 access、分享/恢复分享、工作图、task、规划/审核 chat 及 Codex thread 绑定。现有项目不能转换。宿主机管理员仍是信任主体，不能将此功能描述为对 Mac 管理员保密。

Portal 保留同一 HTTP/SSE、文件工作台和队列。`AgentRuntimeService` 按服务端项目类型路由到原 `CodexService` 或独立的 `LocalQwenService`；后者通过 DSH 适配层连接当前本机 Qwen OpenAI-compatible 服务，不是浏览器可选的任意 provider/proxy。普通项目行为不变。

| 数据/运行 | 普通项目 | 隐私项目 |
| --- | --- | --- |
| Agent / 推理 | Codex app-server / Codex | 独立 DSH worker / 回环 Qwen |
| 会话映射 | codex_thread_id | local_session_id，绝不写 Codex thread |
| 记忆候选范围 | 当前用户可访问的普通来源项目 + 该用户全局记忆 | 当前用户 + 当前隐私项目，仅在本项目多 chat 共享 |
| 员工共享 / Work Graph | 既有显式协作契约 | 一律禁止 |
| 文件/命令确认 | 既有项目内自动放行 | 按 chat 的 manual / auto 控制 |

## 本地模型与 Agent 边界

- `LOCAL_QWEN_ENABLED` 默认 false。当前安装的模型是 Qwen。URL 只接受明确 HTTP 回环主机 `127.0.0.1` 或 `::1`；不可附带凭据、查询、fragment，不接受远端域名。接口必须提供 `/models`、OpenAI-compatible `/chat/completions` SSE 和原生 tool calls。模型 ID 由运维固定，不能随 chat 改写。
- DSH 及内部依赖精确 pin `0.1.0-rc.7`；Cordis `4.0.1`。代码中的 `@deepseek-ai/dsh-*` 仅是 DSH 框架发布包的 import namespace，不是模型 API、provider 或网络地址；实际模型配置统一为本机 Qwen。仅挂载 core agent-loop、模型适配器、工具、system prompt、JSONL/checkpoint 与本地 compaction；不加载 DSH web bundle、设置文件、用户 profile、shell/FS 插件、子代理或 telemetry。compaction 继承同一本地 provider/model。
- Worker 运行在 Seatbelt 中：仅能写本 chat 的 session 容器，读取自身源码/依赖及系统运行库，联网只允许配置的 localhost TCP 端口。HTTP 层进一步仅允许模型的两个固定 endpoint，禁止重定向。不把项目、Portal DB、Codex 凭据、环境秘密或其他会话目录授权给 Worker。
- Worker 通过私有 stdio 请求 Portal 已注册工具；Portal 再校验用户、access、chat、参数和运行取消状态。文件继续用 sandbox helper；EXECUTE 命令使用项目 access 的无秘密环境，隐私项目命令强制禁网，即使老板 networkAccess 为 true。
- 不可用、超时、恢复失败均明确报错，无云端推理 fallback。普通 Codex 故障只能暂停普通输入。隐私项目可独立运行，但专用搜索需 Codex 可用。当前 Qwen 服务的 `reasoning_content` 由 DSH 的 OpenAI-compatible/Qwen thinking 兼容层消费，不能因此把它路由到普通 Codex。

## 人工确认与完全接管

`chats.control_mode` 默认 manual，独立于 EDIT/EXECUTE；有运行、恢复或待处理输入时禁止切换。

- manual：读取/搜索本地文件无需批准；Agent 文件变更、命令、云端搜索逐项建立持久 `turn_approvals`（file/command/web_search），显示实际目标、内容预览、命令或可编辑搜索词。
- auto：同样记录审批，但自动接受；仍受 ACL、路径、配额、模式与禁网限制。UI 明确确认后启用，并警告模型生成的搜索词可能包含敏感信息。
- EDIT 永远拒绝命令。批准绑定 user/chat/run/tool call/参数，只能消费一次；等待期间文件指纹变化拒绝执行；批准后重新校验权限和取消状态。停止/重启取消审批，迟到批准不能重放副作用。
- 四个 memory 工具由模型自主调用，仍受搜索/管理记忆开关、来源、版本和失效上下文约束；不新增关键词提取或自动注入。

## 唯一云端例外：搜索词

本地模型只获得 `web_search({query})`。manual 显示/允许老板编辑实际 query；auto 直接提交。Portal 只将这个单行、有长度上限的 query 作为动态输入，发送到独立的 `gpt-5.6-luna / low` 搜索运行；不自动附带项目名、文件、对话、记忆、工作目录或工具结果。

专用 Codex app-server 使用一次性 `0700` 目录及 `0600` 登录凭据副本，空白 cwd/CODEX_HOME，不继承主用户配置。原生记忆三项固定关闭并验证；同时验证 web_search=live、没有启用的配置 MCP server，禁用 remote_plugin/tool_suggest。其他原生能力关闭、agents disabled、无 dynamic tools，拒绝全部 server requests。请求使用 ephemeral thread、只读/禁网原生命令 sandbox；应用进程本身需网络访问模型与检索服务，但 Seatbelt 不授予项目/Portal/主 Codex_HOME 文件权限。退出后销毁一次性目录。必须观察到 webSearch item、成功 turn 以及含来源 URL 的答复才返回检索结果，不能把纯模型回答伪称已搜索。

此功能不是“完全离线”：query 内容本身可包含敏感信息，自动模式不保证脱敏；公开检索结果仍是不可信数据。老板公网访问继续经过 Cloudflare，不承诺端到端避开该代理。

## 持久化、恢复、队列与容量

隐私工具明细直接显示本地实际输入/输出与状态，不调用 Luna 或任何云模型做摘要；遵循同一 chat ACL、秘密脱敏及超限标注。记忆正文不复制到明细，仍在我的记忆或原生受 ACL 历史中管理。详见 [工具明细业务快照](06-persistence-events-and-recovery.md)。

- SQLite 保存项目/控制模式、chat、messages、turn、审批、队列、记忆与引用；DSH JSONL 存在 `DATA_DIR/local-sessions/<user>/<project>/<chat>/events`。原始上下文不写全局日志/audit/journal。会话容器不位于可分享项目目录。
- 空白 session 先写本地 route metadata 并 flush，再提交映射，不能映射尚未物化的空目录。工具 dispatch 前及模型 request 边界使用 DSH checkpoint。
- 恢复失败保留旧映射并设置 resume_failed；显式 reset 创建空白 session，保留旧记录及 `chat_thread_recoveries.engine=qwen` lineage，并更新 memory context reset 水位。旧正文仍在受 ACL 的历史中，但不会注入新模型会话。
- 重启沿用 Portal 的 interrupted/cancelled/paused 恢复，不自动执行未知副作用；恢复 DSH 会话时清除遗留未消费 inbox。新消息才开始新工作。steer 在下一 step 边界生效，不等价于中断当前命令；要立即停止使用停止按钮。未获确认的 steer 保留并暂停，不自动重发。
- 全局只有一个活动本地 DSH；同时领取既有全局 root/EXECUTE 容量，聚合用户并发。先持久化终态、排空 Worker 和工具，再释放容量。其他本地 chat 等候，但普通 Codex 可使用其余席位。
- 整轮超时包含审批等待；停止与超时取消待审操作。进程异常后不能自动 fallback 或偷偷更换会话。

## 接口与运维

`POST /api/projects` 增加 projectType，项目/chat payload 返回类型/控制模式但不暴露 local_session_id。`PATCH /api/chats/:id` 增加 controlMode；隐私项目禁止 preferredModel 与 preferredEffort。

`/api/projects/:id/memories[/:memoryId]` 提供 GET/POST/PATCH/DELETE，复用现有版本/失效语义；普通 `/api/memories` 不得访问隐私记忆 ID。派生 ONNX/Milvus 文档以 user/project 的散列 namespace 分开，SQLite 再次过滤所有候选；删除或撤权后的旧索引命中不能返回正文。删除并不保证清除备份、旧 session 或所有派生磁盘残留。

`/api/health.localQwen` 与 `/api/me.codex.runtimes.qwen` 独立报告 disabled/starting/ready/unavailable；usage engine 值为 `qwen`，当前实际模型由 `model` 字段标出为 Qwen。ready 是模型目录/运行接通状态，不代替真实推理验收。默认脚本仍要求 Codex ready；显式启用本地引擎后，可在本地 ready 时以部分能力运行，不能称普通 Codex 同时可用。

详见 [操作指南](../../docs/LOCAL_PRIVATE_PROJECTS.md)。关闭本地功能可暂停使用但必须保留隐私 ACL；禁止用不认识 project_type 的旧代码运行现有数据库。备份须一致性包含 DB、项目/回收站、JSONL、记忆派生数据（可重建）和模型配置。

本地 usage 计量在 Worker 的 HTTP 流边界只提取上游数值元数据，逐请求覆盖推理与本地 compaction；原始 SSE 正文不会另存计量表。缺失 usage 保持 incomplete，不使用 dsh-token-meter 的上下文估算补账。独立 Luna 搜索消费记入老板 GPT，不混入本地 Qwen，也不因此附带隐私上下文。
