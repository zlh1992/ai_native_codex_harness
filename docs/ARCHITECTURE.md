# 架构与安全边界

> 本文保留为操作侧简版说明。长期有效的完整架构、不变量、项目约束和发布契约以 [架构规格索引](../spec/architecture/index.md) 为准；每次实现的计划与结论见 [实施报告](../spec/report/index.md)。

## 1. 目标

本项目让多个受控用户共享这台 Mac 的 Codex 计算与登录。唯一超级账户可管理账号和查看项目元数据，但项目内容权限仍只由 OWNER/SHARED ACL 决定。

## 2. 请求链路

```text
Browser ─HTTPS─> Tunnel ─HTTP loopback─> Harness HTTP Server
                                               │
                 ┌─────────────────────────────┼─────────────────────────┐
                 │                             │                         │
              SQLite                    WorkspaceService          CodexService
       users/sessions/RBAC/audit      canonical path checks      thread ownership map
                                              │                         │ stdio JSONL
                                  macOS sandbox-exec                    ▼
                                      project command             codex app-server
                                                                       │
                                                              existing local login
```

浏览器永远不会连接 app-server，也不能自选 `cwd`、thread id、sandbox policy 或 JSON-RPC method。所有这些值都由服务端根据登录用户和数据库归属生成。

本机当前环境对 Codex 后端 WebSocket 握手会超时，因此 app-server 使用 `openai_http` provider 和 `supports_websockets=false`，直接走已登录 Codex 的 HTTPS Responses 传输；这沿用了 `local_cc` 已验证的连接方式。

## 3. 数据隔离

- 用户目录：`.data/workspaces/<user-uuid>/`
- 项目目录：`.data/workspaces/<user-uuid>/<project-slug>/`
- 老板共享给员工的 tree：`.data/trees/<project-access-uuid>/`
- 命令 HOME/TMP：`.data/runtime/<user-uuid>/<project-access-uuid>/`
- 可恢复废纸篓：`.data/trash/<user-uuid>/`
- 元数据与用户记忆事实源：`.data/harness.sqlite`
- 用户记忆派生索引：`.data/memory-index/users/<user-uuid>/`
- Codex 原生 thread：由本机 Codex 存储；本项目数据库只保存服务端签发的 chat 与 thread 映射。

每次项目、文件、对话和 Codex 工具调用都重新查询有效 OWNER/SHARED 记录，并使用数据库绑定的 `tree_path`；浏览器提供的 owner、tree、cwd 或 Codex thread id 均不被信任。超级账户没有内容旁路，只能通过专用驾驶舱查询跨用户元数据。

Codex 原生长期记忆在 app-server 进程参数、每个 thread config 和 ready 前有效配置验证三层永久关闭。Portal 自有长期记忆按 `user_id` 隔离，只有同一用户当前仍授权的来源项目才能被召回；本地 memsearch 只排序候选，最终权限仍由 SQLite 判断。操作细节见 [用户记忆运维](MEMORY.md)。

## 4. 为什么不用 app-server WebSocket / ACP

官方文档明确把 app-server WebSocket 标为实验性且不支持生产，并提示非回环监听的认证与 TLS 要求。本项目因此直接拉起 `codex app-server --stdio`，逐行交换 JSON-RPC；公网只暴露自己的 HTTP/SSE API。这样保留 app-server 的原生 thread、turn、流式 item 和动态工具，又避免 ACP 的额外代理链与远程裸 RPC 风险。

## 5. Agent 工具隔离

仅仅把 turn 的 `cwd` 指到项目目录并不足以隔离不受信任用户，因为普通 workspace-write 沙箱的读取边界可能大于单个项目。因此实现采用两层控制：

1. app-server 关闭内置 Shell、unified exec、浏览器、插件、外部 MCP、computer use 和 image generation；保留原生 apply-patch、diff、approval、plan、goal、skills 与 multi-agent。每个 turn 使用 `readOnly` 基线和 `on-request` approval，让 Portal 在单次写入前取得完整目标集合。
2. 模型可调用 `workspace_list/read/write/replace/mkdir/delete/search/exec` 动态工具和原生 apply-patch。前七个由后端做规范路径、保留目录与符号链接校验；合法项目文件变更由 Portal 自动接受。`workspace_exec` 仅在 EXECUTE turn 自动放行到 macOS Seatbelt，只允许读写当前绑定 tree 与独立 runtime，不能读取同一员工的另一个项目。共享 worktree 的 `.git` 指针也被文件 API 与 Seatbelt 隐藏。

命令环境只包含最小 `PATH/HOME/TMPDIR/LANG/TERM/CI`，不会继承 Harness、Cloudflare 或 Codex 的密码/token 环境变量。网络默认关闭；管理员可按用户开启。

## 6. 认证和授权

- 密码：scrypt N=32768、r=8、p=1，每个密码独立随机 salt。
- 会话：浏览器持有 256-bit 随机 token；SQLite 只保存 SHA-256 token 摘要。
- Cookie：HttpOnly、SameSite=Strict；公网配置 `Secure`。
- 写请求：同时校验会话、Origin 和 session-bound CSRF token。
- 登录：按来源 IP 的滑动窗口限速；成功/失败均写审计。
- RBAC：`user` 与唯一 `admin` 两种不可由 Web 提权的账号角色；内容访问另由 OWNER/SHARED ACL 控制。
- 项目成员：同一老板项目可有多条有效 SHARED 记录；数据库只限制同一项目、同一员工最多一条有效授权。每条授权绑定自己的 branch、base SHA 和 worktree；撤权后若脏树仍在，为同一员工恢复时复用原 access 与 tree。
- 对话是用户私有的 thread 映射，不因同项目而互读原 transcript；新 share 显式把 owner 当时的全部对话 fork 为接收员工的私有副本，后续不自动同步。`thread/resume` 失败会保留旧 id 并进入 `resume_failed`，只有重试成功或用户明确确认 context reset 后才改变状态；reset 会记录 lineage。

## 7. 资源和滥用边界

- App Server 全局 turn 硬上限 40，Portal active root turn 硬上限 11，EXECUTE lease 默认同为 11；同一 chat 只能有一个 root turn，同一 project access/worktree 的不同 chat 可并发。浏览器文件修改、任务快照和交付必须取得整个 access 的空闲状态；并发 turn 同时修改同一文件时可能冲突。
- 每用户项目数和逻辑存储配额。
- Shell 的 wall timeout、CPU ulimit、进程数、文件描述符和输出字节上限。
- 项目命令的网络访问按用户关闭/开启。
- 文件读取、编辑与上传各有大小上限。

存储配额对 API 写入是硬限制；对任意 Shell 工具产生的文件是执行后观测的软限制。若要把服务开放给完全不可信的互联网匿名用户，应进一步使用独立 macOS 用户、虚拟机或容器加磁盘 quota，而不应只依赖本项目。

## 8. 备份和恢复

停止服务后备份 `.data/harness.sqlite*`、`.data/workspaces/`、`.data/trees/` 和 `.data/trash/`。SQLite 使用 WAL，在线备份应使用 SQLite backup API 或同时复制主文件、`-wal` 和 `-shm`。恢复文件前必须核对对应项目 ACL 与 tree 绑定。

`task_submissions` 的 chat/run 外键使用 `ON DELETE SET NULL`，不可变 final reply、diff 与原生标识仍独立保留；应用层同时拒绝删除含提交证据的 chat。`turn_events` 使用单调 id 保存脱敏语义事件，SSE 支持 `Last-Event-ID`；逐 token 文本、reasoning、命令正文、文件内容和 raw diff 不进入事件日志。

## 9. 信任与账号边界

所有用户仍共享一个 app-server 进程、一个本机 `CODEX_HOME` 与同一 Codex 登录对应的配额。原生记忆关闭消除了一个明确的跨用户串忆入口，但 Portal 对 HTTP、动态工具、cwd、sandbox 和 active root 的业务 ACL 仍不构成敌对租户级的上游身份或进程隔离；当前产品只能定位为内部互信 Pilot。若面向互不信任组织，必须拆成 per-user/per-tenant worker 与独立上游身份。公网输入会发送给该 Codex 登录对应的 OpenAI 服务，不是纯本地推理。
