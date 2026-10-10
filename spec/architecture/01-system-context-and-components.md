# 01 系统上下文与组件

## 系统上下文

| 参与者或系统 | 能力 | 不可信输入 |
| --- | --- | --- |
| 老板浏览器 | 管理普通账号、配额、自己拥有的项目、授权、roadmap 和审核 | Cookie 之外的所有请求参数、项目 id、用户 id、路径、approval id |
| 员工浏览器 | 访问自己的项目和当前有效共享项目，创建私有 chat，运行任务 | 路径、chat id、turn 参数、上传内容、SSE cursor |
| HTTPS 隧道 | 把公网 HTTPS 转发到回环 HTTP | 转发头只有在受信代理配置下才能用于来源 IP/协议判断 |
| Portal | 唯一业务授权点与编排者 | 不信任浏览器传入的 owner、cwd、tree、thread 或 RPC method |
| Codex app-server | 原生 thread/turn/approval/skills/subagent 能力 | 共享本机身份，不是租户授权来源 |
| 本机文件系统/Git | 项目主目录、共享 worktree、runtime、trash | 符号链接、`.git` 指针、项目自定义 agent 配置 |
| SQLite | 业务事实、用户记忆、运行 journal、审计 | 是 Portal 的授权与记忆事实源，不包含原生完整 transcript |
| 微信 transport bridge | 扫码绑定、微信轮询、回传 Portal 结果 | 不启动独立 Codex、不接收 project/cwd/thread、不得绕过 Portal ACL |
| memsearch/ONNX worker | 对每名用户的记忆派生文档做本地语义索引 | 只返回候选，不授予用户或项目权限；失败时可降级 |

## 请求链路

隐私项目通过 `AgentRuntimeService` 路由至独立 `LocalQwenService`/DSH worker；该适配层连接本机 Qwen OpenAI-compatible 服务，复用 Portal 的 HTTP/SSE、容量、审批、文件与记忆工具。普通项目仍使用原 CodexService；独立的 CodexSearchService 只接收经策略批准的搜索词。组件与信任边界详见 [本地隐私项目](10-local-private-projects.md)。

```text
Browser request
  -> session / status / role / CSRF / Origin
  -> projectFor or chatFor ACL lookup
  -> re-fetch policy after relevant await boundary
  -> workspace lifecycle lock or capacity lease
  -> canonical server-bound path/thread/cwd
  -> Workspace API, sandboxed command, or Codex JSON-RPC
  -> durable state/event first
  -> HTTP JSON or SSE projection
```

授权不能只在路由入口检查。建立 worktree、发现 skill、恢复 thread、等待排队或启动 native turn 都可能跨越异步窗口；真正触碰文件或开始 turn 前必须重新读取用户状态、项目 access 和网络策略。

## 组件职责

| 组件 | 当前职责 | 明确禁止承担的职责 |
| --- | --- | --- |
| `src/server.mjs` | HTTP 路由、认证入口、请求体限制、ACL、CSRF、Origin、响应/SSE、生命周期路由、文件预览响应安全头 | 不直接信任客户端路径、tree 或 thread；不直接调用任意 RPC |
| `src/db.mjs` | schema/migration、业务实体、不变量事务、运行状态、事件、审计 | 不保存明文会话 token；不把 native thread id 当授权凭据 |
| `src/fs-service.mjs` | canonical path、保留路径、符号链接和文件大小检查；通过 Seatbelt helper 完成实际 CRUD | 不允许绝对路径、`..`、`.git`、越界链接；不在路径预检后退回主进程裸读写 |
| `src/worktree-service.mjs` | 初始化 Git、创建/恢复/移除员工独立 worktree、固定 submission commit/tree、将 passed 快照合入 owner | 不决定谁有权限；不在脏 tree 上静默销毁数据；不自动解决 merge 冲突 |
| `src/capacity-service.mjs` | root turn、用户并发、access 占用跟踪、EXECUTE lease 与排队 | 不替代数据库生命周期检查；不把同 access 的不同 chat 强制串行 |
| `src/sandbox.mjs` | 最小环境、Seatbelt profile、命令超时和输出限制 | 不继承 Portal/Codex/Cloudflare 秘密；不提供跨项目读取 |
| `src/codex-client.mjs` | 启停 app-server、JSONL RPC、精确协议版本验证 | 不向浏览器暴露；不做业务 ACL |
| `src/codex-service.mjs` | thread/turn、事件、审批、动态工具、恢复、子代理政策、Portal 记忆注入与运行清理 | 不允许客户端指定原生 thread/cwd；不自动跨 chat 共享历史 |
| `src/user-memory-service.mjs` | `user_id` 记忆 CRUD、来源 ACL、搜索、引用、分享确认与线程失效 | 不把索引命中当授权；不读取其他用户记忆；不再自动提取 |
| `src/memory-tools.mjs` | 四个模型自主调用的记忆工具 schema、参数与 chat 开关校验、写入后线程失效 | 身份和来源由 active root 绑定；planner/reviewer 与子代理不可调用 |
| `src/memory-index-client.mjs` + worker | 管理 per-user memsearch 索引、超时与降级状态 | 不持有权威正文或决定可见性；不继承 Portal/Codex 凭据 |
| `public/app.js` | 员工/owner 工作台、事件重放、文件与任务交互、受限 HTML 产物 iframe 预览 | 不作为安全边界；所有限制必须由服务端重复执行，项目 HTML 不获得 Portal 同源能力 |
| `public/boss.js` | 老板元数据与授权工作流 | 不获得员工项目内容旁路 |
| `bin/*.sh` | 本机 launchd 生命周期、健康检查和隧道 | 不把服务直接监听到非回环地址 |

## 数据存放

```text
.data/harness.sqlite                         业务元数据与 journal
.data/workspaces/<owner-id>/<project-slug>/ owner 项目主目录
.data/trees/<project-access-id>/            每个 shared access 的独立 worktree
.data/runtime/<user-id>/<project-access-id>/ 命令 HOME/TMP 与 access 级运行数据
.data/runtime/git/                          Portal 受信 Git 服务的独立 HOME
.data/trash/<actor-id>/                     可恢复删除
.data/memory-index/users/<user-id>/         SQLite 生成的 per-user Markdown 与 Milvus Lite 派生索引
.data/memory-model-cache/                   固定 revision 的本地 ONNX 模型缓存
CODEX_HOME                                  原生 Codex thread/登录；由所有 Portal 用户共享
```

`tree_path`、`project_access_id` 和 `codex_thread_id` 只由服务端数据库绑定产生。对外 payload 必须移除物理 `treePath`、branch 内部细节及其他绝对路径。

`CODEX_HOME` 虽共享，但 Portal 启动参数和所有 start/resume/fork 的 thread config 都固定 `features.memories=false`、`memories.generate_memories=false`、`memories.use_memories=false`；初始化后必须用 `config/read` 验证有效值，任一不为 `false` 就拒绝 ready。

普通项目和微信固定项目的 Codex app-server 使用当前 macOS 用户的本机 ChatGPT 登录，并固定 `openai_http` 与 `https://chatgpt.com/backend-api/codex`；运行配置和生命周期脚本拒绝其他 provider/endpoint。`local_private` 由独立回环 Qwen OpenAI-compatible 服务路由，不能与普通项目或微信互换。

## UI 分工

- `/employee` 是员工登录与工作台入口；`/boss/login` 是老板专用登录页，`/boss` 是老板驾驶舱，`/boss/workbench` 是老板项目工作台。本地与公网使用相同角色路径；无需不同域名或端口。`/` 与旧页面保留跳转兼容。
- 老板与员工采用独立登录页面、角色专用登录 API 与不同首页；共用工作台组件及同源会话，页面不得把错误角色当作成功登录。
- 两个页面可以共享同一登录会话，但 UI 导航不改变服务端内容 ACL。
- owner 与 shared access 在同一工作台中使用相同文件预览组件；HTML 默认渲染且可切回源码，主动内容由 iframe sandbox 与响应 CSP 双重隔离。

`src/input-queue-service.mjs` 负责 chat 私有输入的验证、编辑/取消/继续、FIFO 消费和当前 turn 的 steer；由 CodexService 启停，在业务 SQLite 中持久化。它调用既有 runTurn/capacity，不绕过 root、用户、EXECUTE、模式或 sandbox 边界。浏览器统一通过队列 API 接受消息，再订阅 Portal run SSE。

微信渠道使用 SQLite `channel_bindings` 将 `(channel, external_scope_id)` 固定到老板 `weichat-project` 内的 chat，并用 `channel_events` 按外部事件 ID 去重。桥接只提交私聊文本和签名，不提交 owner、project、cwd 或 thread；Portal 在每次 turn 前重新解析老板 access 和固定项目。只有这个 active binding 的 chat 会注册 `owner_projects_list` 与 `owner_project_*` 只读工具；每次调用再按当前老板身份解析目标项目，只接受本人 owner access 的 standard 项目。

## 工作图组件

WorkGraphStore 管理持久状态；ProjectContextService 固定输入；ProjectShareService 批量准备授权；WorkGraphService 管理清单/交付/依赖；TaskReviewService 管理验收；WorkflowScheduler 和 WorkGraphRuntime 复用 Codex 运行；静态 WorkGraphUI 复用任务首页。 详细契约见 [多人 Work Graph](09-human-work-graph.md)，操作见 [工作图指南](../../docs/WORK_GRAPH.md)。
