# 架构与安全边界

## 1. 目标

本项目让多个受控用户共享这台 Mac 的 Codex 计算与登录，但不共享工作目录、项目记录、会话入口或文件 API。超级管理员是唯一的跨租户角色。

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
- 可恢复废纸篓：`.data/workspaces/<user-uuid>/.trash/`
- 元数据：`.data/harness.sqlite`
- Codex 原生 thread：由本机 Codex 存储；本项目数据库只保存服务端签发的 chat 与 thread 映射。

普通用户对项目的查询都附加 `user_id` 所有权检查。管理员可以跨用户读取项目，但仍须通过同一套规范路径和符号链接检查。

## 4. 为什么不用 app-server WebSocket / ACP

官方文档明确把 app-server WebSocket 标为实验性且不支持生产，并提示非回环监听的认证与 TLS 要求。本项目因此直接拉起 `codex app-server --stdio`，逐行交换 JSON-RPC；公网只暴露自己的 HTTP/SSE API。这样保留 app-server 的原生 thread、turn、流式 item 和动态工具，又避免 ACP 的额外代理链与远程裸 RPC 风险。

## 5. Agent 工具隔离

仅仅把 turn 的 `cwd` 指到项目目录并不足以隔离不受信任用户，因为普通 workspace-write 沙箱的读取边界可能大于单个项目。因此实现采用两层控制：

1. app-server 关闭内置 Shell、unified exec、浏览器、插件、MCP、computer use、image generation 和 multi-agent，并把 turn 自身设为 read-only、never approval。
2. 模型只能调用 `workspace_list/read/write/replace/mkdir/delete/search/exec` 动态工具。前七个由后端做规范路径校验；`workspace_exec` 再进入 macOS Seatbelt，默认只允许读取系统运行时和当前用户根目录，只允许写当前用户根目录。

命令环境只包含最小 `PATH/HOME/TMPDIR/LANG/TERM/CI`，不会继承 Harness、Cloudflare 或 Codex 的密码/token 环境变量。网络默认关闭；管理员可按用户开启。

## 6. 认证和授权

- 密码：scrypt N=32768、r=8、p=1，每个密码独立随机 salt。
- 会话：浏览器持有 256-bit 随机 token；SQLite 只保存 SHA-256 token 摘要。
- Cookie：HttpOnly、SameSite=Strict；公网配置 `Secure`。
- 写请求：同时校验会话、Origin 和 session-bound CSRF token。
- 登录：按来源 IP 的滑动窗口限速；成功/失败均写审计。
- RBAC：`user` 与 `admin` 两种不可由 Web 提权的角色。

## 7. 资源和滥用边界

- 全局与用户级 Codex turn 并发限制（均可配置，硬上限 40）；同一对话串行，不同对话、项目和用户可并发。
- 每用户项目数和逻辑存储配额。
- Shell 的 wall timeout、CPU ulimit、进程数、文件描述符和输出字节上限。
- 项目命令的网络访问按用户关闭/开启。
- 文件读取、编辑与上传各有大小上限。

存储配额对 API 写入是硬限制；对任意 Shell 工具产生的文件是执行后观测的软限制。若要把服务开放给完全不可信的互联网匿名用户，应进一步使用独立 macOS 用户、虚拟机或容器加磁盘 quota，而不应只依赖本项目。

## 8. 备份和恢复

停止服务后备份 `.data/harness.sqlite*` 与 `.data/workspaces/`。SQLite 使用 WAL，在线备份应使用 SQLite backup API 或同时复制主文件、`-wal` 和 `-shm`。删除的项目/文件位于用户 `.trash`；恢复时由管理员把目标移动回原项目并确认所有权和权限。

## 9. 信任与账号边界

所有用户消耗同一台 Mac 当前 Codex 登录对应的配额。超级管理员应只给获授权的人开账号，并确认这种内部共享方式符合所用 ChatGPT/Codex 套餐、组织政策与数据规则。公网输入会发送给该 Codex 登录对应的 OpenAI 服务，不是纯本地推理。
